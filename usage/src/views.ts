/**
 * The overview page's two companions, server-rendered (no JS):
 *   /clients    one row per client, identified by email: how close each is to its free limits, per platform.
 *   /platforms  per platform: every free allowance (tracked here or not, with its source) and each client's consumption.
 * Both read the same Ledger as the overview page. Everything that comes from the registry is escaped.
 */
import { CATALOG, PLATFORM_NAME, type PlatformCatalog } from "./catalog";
import type { ClientInfo, Ledger, LedgerProvider, Meter, Platform } from "./ledger";
import { escapeHtml as esc } from "./page";

const PAGES = [
  ["/", "Overview"],
  ["/clients", "By client"],
  ["/platforms", "By platform"],
  ["/classic", "7-day table"],
] as const;

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
      client: { id: "", name: "Not in the registry", status: "live", platforms: [], accounts: [] },
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

function clientDetail(g: Group, open: boolean): string {
  const { client, providers } = g;
  const who = client.email
    ? `${esc(client.name)} <span class="muted">· ${esc(client.email)}</span>`
    : esc(client.name);
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
  return `<details id="client-${esc(client.id || "unassigned")}"${open ? " open" : ""}><summary>${who}</summary>${body}</details>`;
}

export function renderClientsPage(ledger: Ledger, q = ""): string {
  const groups = groupByClient(ledger).filter((g) => clientMatches(g.client, q));
  const rank = (g: Group): number => worst(g.providers)?.pct ?? -1;
  groups.sort((a, b) => rank(b) - rank(a) || a.client.name.localeCompare(b.client.name));

  const rows = groups
    .map((g) => {
      const w = worst(g.providers);
      const alerts = g.providers.filter((p) => p.status).length;
      const platforms = [
        ...new Set(g.providers.map((p) => PLATFORM_NAME[p.platform] ?? p.platform)),
      ];
      const email = g.client.email
        ? esc(g.client.email)
        : `<span class="muted">no email on file</span>`;
      const status = g.client.id
        ? `<span class="pill ${esc(g.client.status)}">${esc(g.client.status)}</span>`
        : "";
      const closest = w
        ? `${bar(w.pct)}<div class="muted small">${esc(w.meter.label)} · ${esc(w.provider.name)}</div>`
        : `<span class="muted">not metered yet</span>`;
      const flag =
        alerts > 0
          ? `<b style="color:var(--crit)">${alerts} alert${alerts === 1 ? "" : "s"}</b>`
          : `<span class="muted">none</span>`;
      return `<tr><td><a href="#client-${esc(g.client.id || "unassigned")}">${esc(g.client.name)}</a></td><td>${email}</td><td>${status}</td><td>${platforms.length > 0 ? platforms.map(esc).join(", ") : '<span class="muted">—</span>'}</td><td>${closest}</td><td>${flag}</td></tr>`;
    })
    .join("");

  const noEmail = ledger.data.clients.filter((c) => !c.email && c.status !== "paused").length;
  const body = `<form method="get" action="/clients"><input type="search" name="q" value="${esc(q)}" placeholder="Find a client by email or name" aria-label="Find a client by email or name"><button>Search</button>${q ? '<a href="/clients" style="align-self:center">Clear</a>' : ""}</form>
${rows === "" ? `<p class="muted">No client matches “${esc(q)}”.</p>` : `<table><tr><th>Client</th><th>Email</th><th>Status</th><th>Metered on</th><th>Closest to its limit</th><th>Alerts</th></tr>${rows}</table>`}
${noEmail > 0 ? `<p class="muted small">${noEmail} client${noEmail === 1 ? " has" : "s have"} no email in the registry; add <code>email:</code> to identify them here.</p>` : ""}
<h2>Detail</h2>${groups.map((g) => clientDetail(g, groups.length === 1)).join("")}`;
  return shell("Free-tier consumption by client", "/clients", body, ledger.data.generatedAt);
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
