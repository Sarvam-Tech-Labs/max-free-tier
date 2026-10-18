/**
 * The overview page's two companions, server-rendered (no JS):
 *   /clients    one row per client, identified by email: how close each is to its free limits, per platform.
 *   /platforms  per platform: every free allowance (tracked here or not, with its source) and each client's consumption.
 * Both read the same Ledger as the overview page. Everything that comes from the registry is escaped.
 */
import { CATALOG, PLATFORM_NAME, type PlatformCatalog } from "./catalog";
import { type DomainRow, daysUntil, type MonitorState, type UptimeView } from "./health";
import type { ClientInfo, Ledger, LedgerProvider, Meter, Platform } from "./ledger";
import { escapeHtml as esc } from "./page";
import type { AlertRow, CheckRun } from "./store";

const PAGES = [
  ["/", "Overview"],
  ["/clients", "By client"],
  ["/platforms", "By platform"],
  ["/activity", "Activity"],
  ["/classic", "7-day table"],
] as const;

/** Uptime (FlareWatch) and domain expiry, for the client pages. Absent → those columns say so. */
export interface Health {
  uptime: UptimeView | null;
  domains: DomainRow[];
  now: Date;
}

/** A domain this close to expiry counts as an alert (FlareWatch warns at the same point). */
export const DOMAIN_WARN_DAYS = 30;

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#dcdcd6;--ok:#2f9e5f;--warn:#d4a20c;--serious:#e07b1a;--crit:#d33a3a;--accent:#2f6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1c1c1f;--ink:#ececee;--muted:#a0a0a8;--line:#33333a;--accent:#6aa0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 6px}h3{font-size:14px;margin:14px 0 4px}
nav{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 20px}nav a{padding:5px 12px;border:1px solid var(--line);border-radius:99px;color:var(--ink);text-decoration:none;background:var(--card)}
nav a[aria-current]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.muted{color:var(--muted)}.small{font-size:12px}a{color:var(--accent)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}td.n,th.n{text-align:right;white-space:nowrap}
.bar{display:inline-block;width:70px;height:7px;background:var(--line);border-radius:4px;vertical-align:middle;margin-right:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--ok)}
.warn .bar i{background:var(--warn)}.serious .bar i{background:var(--serious)}.critical .bar i{background:var(--crit)}
.pill{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:99px;background:var(--line)}.pill.live{background:#dff3e6;color:#17663a}.pill.unconfirmed{background:#fbf0d2;color:#7a5a05}
.alert{margin:6px 0;padding:6px 10px;border-left:4px solid var(--crit);background:var(--card);border-radius:4px}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:0 12px}summary{cursor:pointer;padding:10px 0;font-weight:600}
form{display:flex;gap:8px;margin:0 0 14px}input[type=search]{flex:1;max-width:420px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit}
button{padding:7px 14px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit;cursor:pointer}
.st{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--muted);vertical-align:middle}.st.up{background:var(--ok)}.st.down{background:var(--crit)}.st.warning{background:var(--serious)}
.bad{color:var(--crit);font-weight:600}.soon{color:var(--serious);font-weight:600}
.sources a{display:inline-block;margin-right:10px}@media (max-width:720px){main{padding:16px 12px 48px}th,td{padding:6px}.bar{width:44px}}
`;

function shell(title: string, active: string, body: string, generatedAt: string): string {
  const nav = PAGES.map(
    ([href, label]) =>
      `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><h1>${esc(title)}</h1><nav>${nav}</nav>${body}<p class="muted small">Readings as of ${esc(generatedAt)}. Cloudflare is read hourly; GitHub, Resend, Supabase and Vercel at :30. Page adapted from the same data as the overview (free-tier-maxxer).</p></main></body></html>`;
}

const pctOf = (m: Meter): number => (m.limit > 0 ? (m.used / m.limit) * 100 : 0);
// Same thresholds as the Telegram alerts (50 / 80 / 95).
const level = (pct: number): string =>
  pct >= 95 ? "critical" : pct >= 80 ? "serious" : pct >= 50 ? "warn" : "ok";
const fmtPct = (pct: number): string => (pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`);

export function fmtValue(unit: Meter["unit"], n: number): string {
  if (unit === "bytes") {
    return n >= 1e9
      ? `${(n / 1e9).toFixed(2)} GB`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)} MB`
        : n >= 1e3
          ? `${Math.round(n / 1e3)} KB`
          : `${Math.round(n)} B`;
  }
  if (unit === "minutes") return `${Math.round(n).toLocaleString("en-US")} min`;
  return n >= 1e6
    ? `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`
    : n >= 1e4
      ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`
      : Math.round(n).toLocaleString("en-US");
}

function bar(pct: number): string {
  return `<span class="${level(pct)}"><span class="bar"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i></span>${fmtPct(pct)}</span>`;
}

/** The meter closest to its limit across a set of cards, or null when none has a limit. */
function worst(
  providers: readonly LedgerProvider[],
): { provider: LedgerProvider; meter: Meter; pct: number } | null {
  let best: { provider: LedgerProvider; meter: Meter; pct: number } | null = null;
  for (const provider of providers) {
    for (const meter of provider.metrics) {
      const pct = pctOf(meter);
      if (meter.limit > 0 && (!best || pct > best.pct)) best = { provider, meter, pct };
    }
  }
  return best;
}

interface Group {
  client: ClientInfo;
  providers: LedgerProvider[];
}

/** Registry clients, plus a group for cards whose account is not in the registry (so nothing is silently hidden). */
export function groupByClient(ledger: Ledger): Group[] {
  const { clients, providers } = ledger.data;
  const known = new Set(clients.map((c) => c.id));
  const groups: Group[] = clients.map((client) => ({
    client,
    providers: providers.filter((p) => p.clientId === client.id),
  }));
  const orphans = providers.filter((p) => !p.clientId || !known.has(p.clientId));
  if (orphans.length > 0) {
    groups.push({
      client: {
        id: "",
        name: "Not in the registry",
        status: "live",
        platforms: [],
        accounts: [],
        monitors: [],
        domains: [],
      },
      providers: orphans,
    });
  }
  return groups;
}

function clientMatches(c: ClientInfo, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return (
    needle === "" || [c.email ?? "", c.name, c.id].some((s) => s.toLowerCase().includes(needle))
  );
}

function meterRows(p: LedgerProvider): string {
  const rows = p.metrics
    .map((m) => {
      const pct = pctOf(m);
      const note = m.note ? `<div class="muted small">${esc(m.note)}</div>` : "";
      return `<tr><td>${esc(m.label)}${note}</td><td class="n">${fmtValue(m.unit, m.used)}</td><td class="n">${fmtValue(m.unit, m.limit)}</td><td>${bar(pct)}</td><td class="muted">${m.resets ? "resets" : "a size"}</td></tr>`;
    })
    .join("");
  return rows === ""
    ? ""
    : `<table><tr><th>Meter</th><th class="n">Used</th><th class="n">Free limit</th><th>Share</th><th></th></tr>${rows}</table>`;
}

/** FlareWatch's states in plain words: pending / late / running all read as "checking". */
function uptimeWord(
  s: MonitorState | undefined,
): "up" | "down" | "warning" | "checking" | "unknown" {
  if (!s) return "unknown";
  if (s.status === "up") return "up";
  if (s.status === "down") return "down";
  if (s.status === "degraded") return "warning";
  return "checking";
}

interface SiteSummary {
  total: number;
  up: number;
  down: Array<{ name: string; since?: number; error?: string }>;
  warnings: string[];
}

function siteSummary(client: ClientInfo, h: Health): SiteSummary | null {
  if (client.monitors.length === 0 || !h.uptime) return null;
  const out: SiteSummary = { total: client.monitors.length, up: 0, down: [], warnings: [] };
  for (const m of client.monitors) {
    const s = h.uptime.monitors[m.id];
    const word = uptimeWord(s);
    if (word === "up") out.up++;
    if (word === "down") {
      const open = s?.incidents.at(-1);
      out.down.push({
        name: m.name,
        ...(open?.start[0] !== undefined ? { since: open.start[0] } : {}),
        ...(open?.error.at(-1) ? { error: open.error.at(-1) as string } : {}),
      });
    }
    if (word === "warning" && s?.warning) out.warnings.push(`${m.name}: ${s.warning}`);
  }
  return out;
}

/** The client's domain closest to expiry (or with a failed lookup). */
function nearestDomain(
  client: ClientInfo,
  h: Health,
): { row: DomainRow; days: number | null } | null {
  const rows = client.domains
    .map((d) => h.domains.find((r) => r.domain === d))
    .filter((r): r is DomainRow => r !== undefined)
    .map((row) => ({ row, days: row.expires ? daysUntil(row.expires, h.now) : null }));
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => ((b.days ?? -1e9) < (a.days ?? -1e9) ? b : a));
}

function domainCell(d: { row: DomainRow; days: number | null } | null, client: ClientInfo): string {
  if (!d)
    return client.domains.length > 0
      ? `<span class="muted">not looked up yet</span>`
      : `<span class="muted">—</span>`;
  if (d.days === null)
    return `<span class="soon">lookup failed</span><div class="muted small">${esc(d.row.domain)}</div>`;
  const cls = d.days < 0 ? "bad" : d.days <= DOMAIN_WARN_DAYS ? "soon" : "";
  const when = d.days < 0 ? `expired ${-d.days} days ago` : `in ${d.days} days`;
  return `<span class="${cls}">${when}</span><div class="muted small">${esc(d.row.domain)} · ${esc((d.row.expires ?? "").slice(0, 10))}</div>`;
}

const utc = (unix: number): string =>
  new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function sitesTable(client: ClientInfo, h: Health): string {
  if (client.monitors.length === 0) return "";
  if (!h.uptime)
    return `<p class="muted small">Uptime is unavailable right now (the uptime Worker did not answer).</p>`;
  const rows = client.monitors
    .map((m) => {
      const s = h.uptime?.monitors[m.id];
      const word = uptimeWord(s);
      const last = s?.incidents.at(-1);
      const incident = !last
        ? `<span class="muted">none in 90 days</span>`
        : last.end === undefined
          ? `<span class="bad">down since ${utc(last.start[0] ?? 0)}</span><div class="muted small">${esc(last.error.at(-1) ?? "")}</div>`
          : `<span class="muted">${utc(last.start[0] ?? 0)} → ${utc(last.end)}</span>`;
      const warn = s?.warning ? `<div class="soon small">${esc(s.warning)}</div>` : "";
      return `<tr><td><span class="st ${word}"></span>${esc(m.name)}${warn}</td><td><a href="${esc(m.url)}" rel="noopener noreferrer" target="_blank">${esc(m.url.replace(/^https:\/\//, ""))}</a></td><td>${word}</td><td class="n">${s?.latest ? `${Math.round(s.latest.ping)} ms` : "–"}</td><td>${incident}</td></tr>`;
    })
    .join("");
  return `<h3>Sites (checked every minute)</h3><table><tr><th>Site</th><th>URL</th><th>Status</th><th class="n">Response</th><th>Last incident</th></tr>${rows}</table>`;
}

function domainsTable(client: ClientInfo, h: Health): string {
  if (client.domains.length === 0) return "";
  const rows = client.domains
    .map((d) => {
      const r = h.domains.find((x) => x.domain === d);
      return `<tr><td>${esc(d)}</td><td>${domainCell(r ? { row: r, days: r.expires ? daysUntil(r.expires, h.now) : null } : null, { ...client, domains: [d] })}</td><td class="muted small">${r ? `checked ${esc(r.checkedAt.slice(0, 10))}${r.error ? ` · ${esc(r.error)}` : ""}` : ""}</td></tr>`;
    })
    .join("");
  return `<h3>Domains</h3><table><tr><th>Domain</th><th>Registration expires</th><th></th></tr>${rows}</table>`;
}

function clientDetail(g: Group, open: boolean, h: Health): string {
  const { client, providers } = g;
  const who = client.email
    ? `${esc(client.name)} <span class="muted">· ${esc(client.email)}</span>`
    : esc(client.name);
  const health = sitesTable(client, h) + domainsTable(client, h);
  let body: string;
  if (providers.length === 0) {
    const why =
      client.status === "unconfirmed"
        ? "Not confirmed as a live client in the registry."
        : "Nothing is metered yet: add the client's Cloudflare account or a usage: block in the registry.";
    const uses =
      client.platforms.length > 0
        ? ` Platforms on file: ${client.platforms.map(esc).join(", ")}.`
        : "";
    body = `<p class="muted">${why}${uses}</p>`;
  } else {
    body = providers
      .map((p) => {
        const alert = p.status
          ? `<div class="alert"><b>${esc(p.status.label)}:</b> ${esc(p.status.value)}</div>`
          : "";
        return `<h3>${esc(PLATFORM_NAME[p.platform] ?? p.platform)} <span class="muted small">${esc(p.account)}</span></h3>${alert}${meterRows(p)}`;
      })
      .join("");
  }
  const usageTitle = health && providers.length > 0 ? "<h3>Free-tier usage</h3>" : "";
  return `<details id="client-${esc(client.id || "unassigned")}"${open ? " open" : ""}><summary>${who}</summary>${health}${usageTitle}${body}</details>`;
}

/** Everything about one client that needs attention: platform alerts, sites down, domains expiring or unverifiable. */
function alertsOf(g: Group, h: Health): number {
  const sites = siteSummary(g.client, h);
  const d = nearestDomain(g.client, h);
  const domain = d && (d.days === null || d.days <= DOMAIN_WARN_DAYS) ? 1 : 0;
  return g.providers.filter((p) => p.status).length + (sites?.down.length ?? 0) + domain;
}

export function renderClientsPage(
  ledger: Ledger,
  q = "",
  h: Health = { uptime: null, domains: [], now: new Date() },
): string {
  const groups = groupByClient(ledger).filter((g) => clientMatches(g.client, q));
  // Anything broken first (a site down, a domain about to lapse), then by how close each is to a free limit.
  const rank = (g: Group): number =>
    (siteSummary(g.client, h)?.down.length ? 1e6 : 0) +
    alertsOf(g, h) * 1e3 +
    (worst(g.providers)?.pct ?? -1);
  groups.sort((a, b) => rank(b) - rank(a) || a.client.name.localeCompare(b.client.name));

  const rows = groups
    .map((g) => {
      const w = worst(g.providers);
      const alerts = alertsOf(g, h);
      const email = g.client.email
        ? esc(g.client.email)
        : `<span class="muted">no email on file</span>`;
      const status = g.client.id
        ? ` <span class="pill ${esc(g.client.status)}">${esc(g.client.status)}</span>`
        : "";
      const sites = siteSummary(g.client, h);
      const sitesCell =
        g.client.monitors.length === 0
          ? `<span class="muted">—</span>`
          : !sites
            ? `<span class="muted">uptime unavailable</span>`
            : sites.down.length > 0
              ? `<span class="bad">${sites.down.length} down</span><div class="muted small">${sites.down.map((d) => esc(d.name)).join(", ")}</div>`
              : sites.warnings.length > 0
                ? `<span class="soon">${sites.warnings.length} warning${sites.warnings.length === 1 ? "" : "s"}</span><div class="muted small">${sites.warnings.map(esc).join("; ")}</div>`
                : `<span class="st up"></span>${sites.up}/${sites.total} up`;
      const closest = w
        ? `${bar(w.pct)}<div class="muted small">${esc(w.meter.label)} · ${esc(w.provider.name)}</div>`
        : `<span class="muted">not metered yet</span>`;
      const flag =
        alerts > 0
          ? `<b style="color:var(--crit)">${alerts} alert${alerts === 1 ? "" : "s"}</b>`
          : `<span class="muted">none</span>`;
      return `<tr><td><a href="#client-${esc(g.client.id || "unassigned")}">${esc(g.client.name)}</a>${status}</td><td>${email}</td><td>${sitesCell}</td><td>${domainCell(nearestDomain(g.client, h), g.client)}</td><td>${closest}</td><td>${flag}</td></tr>`;
    })
    .join("");

  const noEmail = ledger.data.clients.filter((c) => !c.email && c.status !== "paused").length;
  const body = `<form method="get" action="/clients"><input type="search" name="q" value="${esc(q)}" placeholder="Find a client by email or name" aria-label="Find a client by email or name"><button>Search</button>${q ? '<a href="/clients" style="align-self:center">Clear</a>' : ""}</form>
${rows === "" ? `<p class="muted">No client matches “${esc(q)}”.</p>` : `<table><tr><th>Client</th><th>Email</th><th>Sites</th><th>Domain expires</th><th>Closest to a free limit</th><th>Alerts</th></tr>${rows}</table>`}
${noEmail > 0 ? `<p class="muted small">${noEmail} client${noEmail === 1 ? " has" : "s have"} no email in the registry; add <code>email:</code> to identify them here.</p>` : ""}
<h2>Detail</h2>${groups.map((g) => clientDetail(g, groups.length === 1, h)).join("")}`;
  return shell(
    "Clients: uptime, domains and free-tier usage",
    "/clients",
    body,
    ledger.data.generatedAt,
  );
}

function matrixCell(item: { match?: RegExp }, providers: readonly LedgerProvider[]): string {
  const hits = providers.flatMap((p) => p.metrics.filter((m) => item.match?.test(m.key)));
  if (hits.length === 0) return `<td class="muted">–</td>`;
  const top = hits.reduce((a, b) => (pctOf(b) > pctOf(a) ? b : a));
  const exact = (n: number): string =>
    top.unit === "count" ? Math.round(n).toLocaleString("en-US") : fmtValue(top.unit, n);
  const tip = `${exact(top.used)} of ${exact(top.limit)}${hits.length > 1 ? ` (worst of ${hits.length})` : ""}`;
  return `<td title="${esc(tip)}">${bar(pctOf(top))}</td>`;
}

function platformSection(cat: PlatformCatalog, ledger: Ledger): string {
  const cards = ledger.data.providers.filter((p) => p.platform === cat.id);
  const byClient = new Map<string, LedgerProvider[]>();
  for (const p of cards)
    byClient.set(p.clientId ?? "", [...(byClient.get(p.clientId ?? "") ?? []), p]);
  const cols = [...byClient.entries()].map(([id, providers]) => {
    const c = ledger.data.clients.find((x) => x.id === id);
    return { name: c?.name ?? "Not in the registry", email: c?.email ?? "", providers };
  });

  const head = cols.map((c) => `<th title="${esc(c.email)}">${esc(c.name)}</th>`).join("");
  const rows = cat.items
    .map((item) => {
      const tracked = item.match !== undefined;
      const consumption = !tracked
        ? `<td class="muted small" colspan="${Math.max(1, cols.length)}">Not tracked here. ${esc(item.why ?? "")}</td>`
        : cols.length === 0
          ? `<td class="muted small">no client on this platform yet</td>`
          : cols.map((c) => matrixCell(item, c.providers)).join("");
      return `<tr><td>${esc(item.label)}</td><td>${esc(item.allowance)}</td><td class="muted">${esc(item.resets)}</td>${consumption}</tr>`;
    })
    .join("");

  const sources = cat.sources
    .map(
      (s) =>
        `<a href="${esc(s)}" rel="noopener noreferrer" target="_blank">${esc(s.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a>`,
    )
    .join("");
  const alerts = cards.filter((p) => p.status);
  return `<h2>${esc(cat.name)}</h2><p class="muted small">${esc(cat.plan)} plan · limits as of ${esc(cat.asOf)} · ${esc(cat.verified)}</p>
<p class="sources small">${sources}</p>
${alerts.map((p) => `<div class="alert"><b>${esc(p.name)}:</b> ${esc(p.status?.value ?? "")}</div>`).join("")}
<table><tr><th>Free allowance</th><th>Included</th><th>Resets</th>${head || "<th>Consumption</th>"}</tr>${rows}</table>`;
}

export function renderPlatformsPage(ledger: Ledger): string {
  const order: Platform[] = ["cloudflare", "github", "resend", "supabase", "vercel"];
  const body = `<p class="muted">Every free allowance by platform, where it comes from, and how much of it each client has used. “Not tracked” means the platform exposes no way for a read-only token to measure it.</p>${order
    .map((id) => CATALOG.find((c) => c.id === id))
    .filter((c): c is PlatformCatalog => c !== undefined)
    .map((c) => platformSection(c, ledger))
    .join("")}`;
  return shell("Free-tier limits by platform", "/platforms", body, ledger.data.generatedAt);
}

const CHECKS: ReadonlyArray<{ name: string; label: string; every: string }> = [
  { name: "collect", label: "Cloudflare usage + domain expiry", every: "hourly at :00" },
  { name: "providers", label: "GitHub, Resend, Supabase, Vercel", every: "hourly at :30" },
  { name: "terms", label: "Free-tier terms watch (pricing pages)", every: "daily" },
  { name: "drift", label: "Our limits vs Cloudflare's docs", every: "daily" },
];

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 90) return `${m} min ago`;
  const hours = Math.round(m / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  usage: "Cloudflare limits",
  providers: "Other platforms",
  terms: "Free-tier terms",
  drift: "Limits vs docs",
  uptime: "Uptime",
};

interface Event {
  at: string;
  source: string;
  who: string;
  text: string;
  bad: boolean;
}

/** Outages from FlareWatch's incident history: one "down" and (once over) one "back up" event each. */
function uptimeEvents(ledger: Ledger, h: Health, sinceMs: number): Event[] {
  if (!h.uptime) return [];
  const names = new Map<string, string>();
  for (const c of ledger.data.clients)
    for (const m of c.monitors) names.set(m.id, `${c.name} · ${m.name}`);
  const out: Event[] = [];
  for (const [id, s] of Object.entries(h.uptime.monitors)) {
    const who = names.get(id) ?? (id === "watchdog" ? "Watchdog ping" : id);
    for (const inc of s.incidents) {
      const start = (inc.start[0] ?? 0) * 1000;
      if (start >= sinceMs) {
        out.push({
          at: new Date(start).toISOString(),
          source: "uptime",
          who,
          text: `Down: ${inc.error[0] ?? "no response"}`,
          bad: true,
        });
      }
      if (inc.end !== undefined && inc.end * 1000 >= sinceMs) {
        const mins = Math.max(1, Math.round((inc.end * 1000 - start) / 60_000));
        out.push({
          at: new Date(inc.end * 1000).toISOString(),
          source: "uptime",
          who,
          text: `Back up after ${mins} min`,
          bad: false,
        });
      }
    }
  }
  return out;
}

/** /activity: when every check last ran and what it found, then one timeline of alerts and outages. */
export function renderActivityPage(
  ledger: Ledger,
  h: Health,
  runs: readonly CheckRun[],
  alerts: readonly AlertRow[],
): string {
  const now = h.now.getTime();
  const checkRows = CHECKS.map((c) => {
    const r = runs.find((x) => x.name === c.name);
    const result = !r
      ? `<span class="muted">not run yet</span>`
      : r.ok
        ? `<span class="st up"></span>fine`
        : `<span class="st down"></span><span class="bad">needs a look</span>`;
    const when = r
      ? `${ago(now - Date.parse(r.at))}<div class="muted small">${esc(r.at.replace("T", " ").slice(0, 16))} UTC</div>`
      : "";
    return `<tr><td>${esc(c.label)}<div class="muted small">${esc(c.every)}</div></td><td>${when}</td><td>${result}</td><td class="small">${esc(r?.summary ?? "")}</td></tr>`;
  });
  const down = h.uptime
    ? Object.values(h.uptime.monitors).filter((s) => s.status === "down").length
    : 0;
  const uptimeRow = !h.uptime
    ? `<tr><td>Uptime (all sites)<div class="muted small">every minute</div></td><td></td><td><span class="muted">unavailable</span></td><td class="small muted">The uptime Worker did not answer.</td></tr>`
    : `<tr><td>Uptime (all sites)<div class="muted small">every minute</div></td><td>${h.uptime.lastUpdate ? ago(now - h.uptime.lastUpdate * 1000) : "not run yet"}</td><td>${down === 0 ? '<span class="st up"></span>fine' : `<span class="st down"></span><span class="bad">${down} down</span>`}</td><td class="small">${Object.keys(h.uptime.monitors).length} checks</td></tr>`;

  const since = now - 30 * 86_400_000;
  const events: Event[] = [
    ...alerts.map((a) => ({ at: a.at, source: a.source, who: "", text: a.text, bad: true })),
    ...uptimeEvents(ledger, h, since),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 150);
  const eventRows = events
    .map(
      (e) =>
        `<tr><td class="small" style="white-space:nowrap">${esc(e.at.replace("T", " ").slice(0, 16))} UTC</td><td>${esc(SOURCE_LABEL[e.source] ?? e.source)}</td><td>${e.who ? `<b>${esc(e.who)}</b><br>` : ""}<span style="white-space:pre-wrap">${esc(e.text)}</span></td></tr>`,
    )
    .join("");

  const body = `<h2>Checks</h2><table><tr><th>Check</th><th>Last run</th><th>Result</th><th>Summary</th></tr>${checkRows.join("")}${uptimeRow}</table>
<h2>Timeline (last 30 days)</h2>
${eventRows === "" ? `<p class="muted">Nothing has happened yet: no alerts sent and no outages recorded.</p>` : `<table><tr><th>When</th><th>What</th><th>Details</th></tr>${eventRows}</table>`}
<p class="muted small">Every alert that also went to Telegram is listed here, with outages from the minute-by-minute uptime checks.</p>`;
  return shell("Activity", "/activity", body, ledger.data.generatedAt);
}
