/**
 * The site's two tabs, server-rendered (design system in theme.ts):
 *   Free-tier limits   what every platform's free plan includes, how it resets, and every change we have detected.
 *   Consumption        pick an email in the collapsible sidebar → that owner's platforms, each meter's consumption,
 *                      the exact reset date and time, and how often it resets; plus uptime and domain status.
 * Everything that comes from the registry or a platform is escaped.
 */
import {
  CATALOG,
  type CatalogItem,
  cycleOf,
  itemFor,
  PLATFORM_NAME,
  type PlatformCatalog,
  platformOf,
} from "./catalog";
import type { DomainRow, MonitorState, UptimeView } from "./health";
import type { ClientInfo, Ledger, LedgerProvider, Meter, Platform } from "./ledger";
import { escapeHtml as esc } from "./page";
import { KIND_LABEL, KINDS, type ProviderKind } from "./providers";
import { refreshRows } from "./refresh";
import type { AlertRow, CheckRun } from "./store";
import { icon, shell } from "./theme";
import { daysUntil, formatInstant, nextReset, relative, zoneLabel } from "./time";
import type { RequiredToken, TokenMeta, TokensOverview } from "./tokens";

/** Uptime (FlareWatch) and domain expiry: absent/empty → those cards say so. */
export interface Health {
  uptime: UptimeView | null;
  domains: DomainRow[];
  now: Date;
}

export interface PageData {
  ledger: Ledger;
  health: Health;
  runs: readonly CheckRun[];
  /** Everything logged by the checks, newest first (limit changes are the terms/drift entries). */
  alerts: readonly AlertRow[];
  /** IANA zone for every displayed time. */
  tz: string;
}

/** A domain this close to expiry counts as needing attention (FlareWatch warns at the same point). */
export const DOMAIN_WARN_DAYS = 30;
/** Usage at or above this share of a limit needs attention (the Telegram alert levels are 50 / 80 / 95). */
const HIGH_USAGE_PCT = 80;
const PLATFORM_ORDER: readonly Platform[] = [
  "cloudflare",
  "vercel",
  "resend",
  "github",
  "supabase",
];

// ───────────────────────────── shared pieces ─────────────────────────────

const pctOf = (m: Meter): number => (m.limit > 0 ? (m.used / m.limit) * 100 : 0);
const level = (pct: number): "ok" | "warn" | "bad" =>
  pct >= 80 ? "bad" : pct >= 50 ? "warn" : "ok";
const fmtPct = (pct: number): string => (pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`);

function fmtValue(unit: Meter["unit"], n: number): string {
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
  if (unit === "hours") return `${(Math.round(n * 10) / 10).toLocaleString("en-US")} core-h`;
  return Math.round(n).toLocaleString("en-US");
}

function meterBar(pct: number): string {
  const w = Math.min(100, pct).toFixed(1);
  return `<div class="meter ${level(pct)}" role="img" aria-label="${fmtPct(pct)} used"><div class="track"><div class="fill" style="width:${w}%"></div></div><span class="pct num">${fmtPct(pct)}</span></div>`;
}

const badge = (text: string, kind: "" | "ok" | "warn" | "bad" | "mute" = ""): string =>
  `<span class="badge${kind ? ` ${kind}` : ""}">${esc(text)}</span>`;

const updatedText = (d: PageData): string => {
  const at = d.runs
    .filter((r) => r.name === "collect" || r.name === "providers")
    .map((r) => r.at)
    .sort()
    .at(-1);
  return at ? `Updated ${relative(at, d.health.now)}` : "Waiting for the first reading";
};

function page(
  d: PageData,
  title: string,
  active: "limits" | "consumption" | "tokens",
  body: string,
): string {
  return shell({ title, active, body, updated: updatedText(d), zone: zoneLabel(d.tz) });
}

function when(iso: string, d: PageData): string {
  const t = formatInstant(iso, d.tz);
  return `<span title="${esc(t.utc)}">${esc(t.text)}</span>`;
}

/** A reset time as two lines: the date, then the time with how far away it is. Hover for UTC. */
function whenStacked(iso: string, d: PageData): string {
  const t = formatInstant(iso, d.tz);
  const [date = "", time = ""] = t.text.split(", ");
  return `<div class="when2" title="${esc(t.utc)}"><div class="d">${esc(date)}</div><div class="t">${esc(time)} · ${esc(relative(iso, d.health.now))}</div></div>`;
}

function statCard(
  ico: Parameters<typeof icon>[0],
  value: string,
  label: string,
  sub = "",
  kind = "",
): string {
  return `<div class="card stat"><div class="tile ${kind}">${icon(ico, 22)}</div><div><div class="l">${esc(label)}</div><div class="v num">${value}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div></div>`;
}

// ─────────────────────────── tab 1: free-tier limits ───────────────────────────

/** Which platform a change text is about (urlwatch names its entries "Cloudflare · Workers pricing" and so on). */
function platformInText(text: string): string | null {
  return /\b(Cloudflare|Vercel|Supabase|Resend|Firebase|GitHub)\b/.exec(text)?.[1] ?? null;
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  terms: "Free-tier terms",
  drift: "Limits vs docs",
  usage: "Usage alert",
  providers: "Usage alert",
};

/** First meaningful line of a change report (skips the rule lines urlwatch draws). */
function headline(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  return (
    lines.find(
      (l) => /(CHANGED|NEW|ERROR|REMOVED|DRIFT|UNVERIFIABLE)/.test(l) && !/^[-=]+$/.test(l),
    ) ??
    lines.find((l) => l !== "" && !/^[-=]+$/.test(l)) ??
    "Change detected"
  );
}

function diffBlock(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => {
      const cls =
        l.startsWith("+++") || l.startsWith("---")
          ? ""
          : l.startsWith("+")
            ? "add"
            : l.startsWith("-")
              ? "del"
              : l.startsWith("@@")
                ? "hunk"
                : "";
      return `<span${cls ? ` class="${cls}"` : ""}>${esc(l) || " "}</span>`;
    })
    .join("");
  return `<pre class="diff" tabindex="0" aria-label="Exact change">${lines}</pre>`;
}

function runBadge(name: string, label: string, runs: readonly CheckRun[], now: Date): string {
  const r = runs.find((x) => x.name === name);
  if (!r) return `<span class="badge mute">${icon("clock", 12)}${esc(label)}: not run yet</span>`;
  return `<span class="badge ${r.ok ? "ok" : "warn"}">${icon(r.ok ? "check" : "alert", 12)}${esc(label)}: ${r.ok ? "no changes" : "changed"} · ${esc(relative(r.at, now))}</span>`;
}

function limitRow(cat: PlatformCatalog, item: CatalogItem, d: PageData): string {
  const tracked = item.match !== undefined;
  const cycle = cycleOf(item);
  const next = nextReset(cycle, d.health.now);
  const resets = next
    ? `<div>${when(next, d)}</div><div class="muted small">${esc(item.resets)}</div>`
    : `<div class="muted">${esc(item.resets)}</div>`;
  const text =
    `${cat.name} ${item.label} ${item.allowance} ${item.category} ${item.frequency}`.toLowerCase();
  return `<tr data-platform="${esc(cat.id)}" data-category="${esc(item.category)}" data-freq="${esc(item.frequency)}" data-tracked="${tracked ? 1 : 0}" data-text="${esc(text)}">
<td class="nowrap"><b>${esc(cat.name)}</b></td><td>${esc(item.label)}</td><td class="num">${esc(item.allowance)}</td><td>${badge(item.category, "mute")}</td><td>${badge(item.frequency, item.frequency === "Never" || item.frequency === "—" ? "mute" : "")}</td><td>${resets}</td><td>${tracked ? badge("Tracked live", "ok") : `<span title="${esc(item.why ?? "")}">${badge("Not tracked", "mute")}</span>`}</td></tr>`;
}

/** The local time of day at which the UTC-midnight limits reset, e.g. "05:30 IST". */
function dailyReset(d: PageData): string {
  const next = nextReset("utc-day", d.health.now) as string;
  return esc(formatInstant(next, d.tz).text.split(", ")[1] ?? "");
}

export function renderLimitsPage(d: PageData): string {
  const now = d.health.now;
  const items = CATALOG.flatMap((c) => c.items.map((item) => ({ c, item })));
  const tracked = items.filter((x) => x.item.match).length;
  const changes = d.alerts.filter((a) => a.source === "terms" || a.source === "drift");
  const recent = changes.filter((a) => now.getTime() - Date.parse(a.at) <= 30 * 86_400_000);
  const categories = [...new Set(items.map((x) => x.item.category))].sort();
  const freqs = [...new Set(items.map((x) => x.item.frequency))];

  const chips = CATALOG.map(
    (c) =>
      `<button type="button" class="chip" data-chip="${esc(c.id)}" aria-pressed="false">${esc(c.name)}</button>`,
  ).join("");
  const options = (xs: readonly string[]) =>
    xs.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");

  const filterCard = `<section class="card" aria-label="Filters"><div class="filters" id="filters">
<div class="field search-f"><label for="q">Search</label><div class="search">${icon("search", 16)}<input id="q" type="search" placeholder="Search a limit, platform or category" autocomplete="off"></div></div>
<div class="field"><label for="cat">Category</label><select id="cat"><option value="">All categories</option>${options(categories)}</select></div>
<div class="field"><label for="freq">Resets</label><select id="freq"><option value="">Any frequency</option>${options(freqs)}</select></div>
<label class="switch"><input id="trk" type="checkbox"> Tracked live only</label>
</div>
<div class="chips pad" role="group" aria-label="Platform">${chips}<button type="button" class="btn" id="reset">Reset filters</button></div></section>`;

  const table = `<section class="card" aria-label="All free-tier limits"><div class="card-head"><h2>All limits</h2><span class="grow"></span><span class="muted" id="count" aria-live="polite"></span></div>
<div class="table-wrap"><table id="limits"><caption class="muted small" style="text-align:left;padding:0 0 8px;caption-side:top">Hover “Not tracked” to see why a limit cannot be measured. Times are the next reset in ${esc(zoneLabel(d.tz))}; hover for UTC.</caption><thead><tr><th>Platform</th><th>Limit</th><th>Included</th><th>Category</th><th>Resets</th><th>Next reset</th><th>Tracked</th></tr></thead><tbody>${items.map((x) => limitRow(x.c, x.item, d)).join("")}</tbody></table></div>
<div class="empty" id="none" hidden>No limit matches these filters.</div></section>`;

  const events = changes
    .slice(0, 25)
    .map((a) => {
      const plat = platformInText(a.text);
      return `<article class="event"><div class="when">${when(a.at, d)}<div>${esc(relative(a.at, now))}</div></div><div><div class="chips">${badge(SOURCE_LABEL[a.source] ?? a.source, a.source === "drift" ? "warn" : "")}${plat ? badge(plat, "mute") : ""}</div><div style="margin-top:6px;font-weight:500">${esc(headline(a.text))}</div><details style="border:0;margin-top:8px;padding:0"><summary>${icon("chevron", 14).replace('class="icon"', 'class="icon chev"')}Show the exact change</summary>${diffBlock(a.text)}</details></div></article>`;
    })
    .join("");
  const history = `<section class="card" aria-label="Changes to the free tiers"><div class="card-head"><h2>Changes to the free tiers</h2><span class="grow"></span>${runBadge("terms", "Terms watch", d.runs, now)}${runBadge("drift", "Limits vs docs", d.runs, now)}</div>
${events === "" ? `<div class="empty">No change detected yet. Every pricing and limits page is checked daily; anything added, changed or removed appears here with the exact lines.</div>` : events}</section>`;

  const sources = `<section class="card sources" aria-label="Sources"><div class="card-head"><h2>Where these numbers come from</h2></div>${CATALOG.map(
    (c) =>
      `<div style="margin-bottom:16px"><h3>${esc(c.name)} <span class="muted small">${esc(c.plan)} plan · as of ${esc(c.asOf)}</span></h3><p class="muted small">${esc(c.verified)}</p>${c.sources.map((s) => `<a href="${esc(s)}" rel="noopener noreferrer" target="_blank">${esc(s.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a>`).join("")}</div>`,
  ).join("")}</section>`;

  const body = `<div class="page-head"><h1>Free-tier limits</h1><p class="lead">What each platform's free plan includes, how often it resets, and every change we have detected. Filter by platform, category or how it resets.</p></div>
<div class="stack">
<div class="grid stats">${statCard("layers", String(CATALOG.length), "Platforms", CATALOG.map((c) => esc(c.name)).join(", "))}${statCard("gauge", String(items.length), "Limits listed", `${tracked} tracked live`)}${statCard("clock", dailyReset(d), "Daily reset", "00:00 UTC, every day")}${statCard("history", String(recent.length), "Changes in 30 days", recent.length === 0 ? "none detected" : "see the history below", recent.length === 0 ? "ok" : "warn")}</div>
${filterCard}${table}${history}${sources}</div>`;
  return page(d, "Free-tier limits", "limits", body);
}

// ───────────────────────────── tab 2: consumption ─────────────────────────────

interface Account {
  /** "" for clients with no email. */
  email: string;
  clients: ClientInfo[];
}

/** Clients grouped under their owner's email (alphabetical, case-insensitive); clients without one share a last group. */
export function accountsOf(ledger: Ledger): Account[] {
  const byEmail = new Map<string, ClientInfo[]>();
  for (const c of ledger.data.clients) {
    const email = (c.email ?? "").trim().toLowerCase();
    byEmail.set(email, [...(byEmail.get(email) ?? []), c]);
  }
  return [...byEmail.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([email, clients]) => ({ email, clients }));
}

const accountKey = (a: Account): string => (a.email === "" ? "none" : a.email);
const accountHref = (a: Account, base = "/consumption"): string =>
  `${base}?email=${encodeURIComponent(accountKey(a))}`;

interface SiteRow {
  client: string;
  name: string;
  url: string;
  state: MonitorState | undefined;
}

function sitesOf(a: Account, h: Health): SiteRow[] {
  return a.clients.flatMap((c) =>
    c.monitors.map((m) => ({
      client: c.name,
      name: m.name,
      url: m.url,
      state: h.uptime?.monitors[m.id],
    })),
  );
}

const isDown = (s: MonitorState | undefined): boolean => s?.status === "down";

function domainsOf(a: Account, h: Health): Array<{ row: DomainRow; days: number | null }> {
  return a.clients
    .flatMap((c) => c.domains)
    .map((dom) => h.domains.find((r) => r.domain === dom))
    .filter((r): r is DomainRow => r !== undefined)
    .map((row) => ({ row, days: row.expires ? daysUntil(row.expires, h.now) : null }))
    .sort((x, y) => (x.days ?? -1e9) - (y.days ?? -1e9));
}

function cardsOf(a: Account, ledger: Ledger): LedgerProvider[] {
  const ids = new Set(a.clients.map((c) => c.id));
  return ledger.data.providers.filter(
    (p) =>
      (p.clientId !== undefined && ids.has(p.clientId)) || (a.email !== "" && p.email === a.email),
  );
}

/** What needs a look for this owner: platform alerts, sites down, domains expiring, usage at 80% or more. */
function attention(a: Account, d: PageData): number {
  const cards = cardsOf(a, d.ledger);
  const domains = domainsOf(a, d.health).filter(
    (x) => x.days === null || x.days <= DOMAIN_WARN_DAYS,
  ).length;
  const high = cards
    .flatMap((p) => p.metrics)
    .filter((m) => m.resets && pctOf(m) >= HIGH_USAGE_PCT).length;
  return (
    cards.filter((p) => p.status).length +
    sitesOf(a, d.health).filter((s) => isDown(s.state)).length +
    domains +
    high
  );
}

function sidebar(
  accounts: readonly Account[],
  selected: Account,
  d: PageData,
  base = "/consumption",
  needsAttention: (a: Account) => boolean = (a) => attention(a, d) > 0,
): string {
  const items = accounts
    .map((a) => {
      const n = a.clients.length;
      const label = a.email === "" ? "No email on file" : a.email;
      const hot = needsAttention(a) ? `<span class="dot" title="Needs attention"></span>` : "";
      return `<a class="acct" href="${accountHref(a, base)}"${a === selected ? ' aria-current="page"' : ""}><span class="avatar">${esc(a.email === "" ? "?" : label.charAt(0))}</span><span class="t"><div class="e" title="${esc(label)}">${esc(label)}</div><div class="p">${n} project${n === 1 ? "" : "s"}</div></span>${hot}</a>`;
    })
    .join("");
  return `<aside class="card sidebar" id="accounts" aria-label="Accounts"><div class="sidebar-head"><h2>Accounts</h2><button type="button" class="btn icon-only" data-sidebar-toggle aria-controls="accounts" aria-expanded="true" aria-label="Collapse the account list" title="Collapse">${icon("panel", 16)}</button></div><nav aria-label="Email accounts">${items}</nav></aside>`;
}

const HOBBY_NOTE =
  " Vercel's Hobby plan gives API tokens no usage numbers, so consumption can't be read; only “account blocked” can be monitored. The limits below are what the plan includes.";

/** Why a platform shows no numbers, as HTML. `waiting` = tokens the registry asks for that have not been added yet. */
function notConnectedNote(p: Platform, waiting: readonly string[]): string {
  if (p === "cloudflare") {
    return "No Cloudflare account is linked to these projects. Add the account id to the registry to read usage live.";
  }
  const link = '<a href="/tokens">Tokens page</a>';
  const extra = p === "vercel" ? esc(HOBBY_NOTE) : "";
  if (waiting.length > 0) {
    return `Waiting for ${waiting.map((n) => `<code>${esc(n)}</code>`).join(", ")}. Paste it on the ${link} to connect.${extra}`;
  }
  return `Not set up yet: add a <code>usage:</code> block for ${esc(PLATFORM_NAME[p])} to the registry, then paste its token on the ${link}.${extra}`;
}

function nextResetCell(
  item: CatalogItem | undefined,
  m: Meter | undefined,
  platform: Platform,
  d: PageData,
): string {
  if (m && !m.resets)
    return `<span class="muted">Never</span><div class="muted small">a size, not a quota</div>`;
  const at = m?.resetsAt ?? (item ? nextReset(cycleOf(item), d.health.now) : undefined);
  if (at) return whenStacked(at, d);
  if (item && cycleOf(item) === "none") return `<span class="muted">${esc(item.resets)}</span>`;
  return `<span class="muted">Date not exposed by ${esc(PLATFORM_NAME[platform])}</span>${item ? `<div class="muted small">${esc(item.frequency)}, ${esc(item.resets)}</div>` : ""}`;
}

function meterRow(p: LedgerProvider, m: Meter, d: PageData): string {
  const item = itemFor(p.platform, m.key);
  const note = m.note ? `<div class="muted small">${esc(m.note)}</div>` : "";
  const conf = m.confidence === "approximate" ? `<div class="muted small">approximate</div>` : "";
  return `<tr><td>${esc(m.label)}${note}${conf}</td><td class="num nowrap">${esc(fmtValue(m.unit, m.used))} <span class="muted">of ${esc(fmtValue(m.unit, m.limit))}</span></td><td>${meterBar(pctOf(m))}</td><td>${nextResetCell(item, m, p.platform, d)}</td><td>${badge(item?.frequency ?? (m.resets ? "—" : "Never"), item?.frequency === "Never" || !m.resets ? "mute" : "")}</td></tr>`;
}

function unmeasuredRows(cat: PlatformCatalog, d: PageData, withUsage: boolean): string {
  return cat.items
    .filter((i) => !i.match)
    .map(
      (i) =>
        `<tr><td>${esc(i.label)}</td><td class="num">${esc(i.allowance)}</td>${withUsage ? `<td><span class="muted" title="${esc(i.why ?? "")}">Not measurable</span></td>` : ""}<td>${nextResetCell(i, undefined, cat.id, d)}</td><td>${badge(i.frequency, i.frequency === "Never" || i.frequency === "—" ? "mute" : "")}</td></tr>`,
    )
    .join("");
}

function platformSection(
  cat: PlatformCatalog,
  cards: readonly LedgerProvider[],
  d: PageData,
  waiting: readonly string[],
  usedBy: readonly string[] = [],
): string {
  const connected = cards.length > 0;
  const head = `<div class="section-head"><h2>${esc(cat.name)}</h2>${badge(`${cat.plan} plan`, "mute")}<span class="grow"></span>${connected ? badge("Connected", "ok") : badge("Not connected", "warn")}</div>${usedBy.length > 0 ? `<div class="muted small" style="margin:-4px 0 12px">Used by ${usedBy.map(esc).join(", ")}</div>` : ""}`;
  const alerts = cards
    .filter((p) => p.status)
    .map(
      (p) =>
        `<div class="note bad">${icon("alert", 18)}<div><b>${esc(p.name)}:</b> ${esc(p.status?.value ?? "")}</div></div>`,
    )
    .join("");

  if (!connected) {
    const rows = cat.items
      .map(
        (i) =>
          `<tr><td>${esc(i.label)}</td><td class="num">${esc(i.allowance)}</td><td>${nextResetCell(i, undefined, cat.id, d)}</td><td>${badge(i.frequency, i.frequency === "Never" || i.frequency === "—" ? "mute" : "")}</td></tr>`,
      )
      .join("");
    // Collapsed: nothing is measured here, so the list of what the plan includes must not push real data off the page.
    return `<section class="card" aria-label="${esc(cat.name)}">${head}<div class="note" style="margin-bottom:0">${icon("plug", 18)}<div>${notConnectedNote(cat.id, waiting)}</div></div><details style="margin-top:12px"><summary>${icon("chevron", 14).replace('class="icon"', 'class="icon chev"')}What the free plan includes (${cat.items.length} limits)</summary><div class="table-wrap" style="margin-top:12px"><table class="compact"><thead><tr><th>Limit</th><th>Included</th><th>Next reset</th><th>Resets</th></tr></thead><tbody>${rows}</tbody></table></div></details></section>`;
  }

  const groups = cards
    .map((p) => {
      const label =
        cards.length > 1
          ? `<tr class="group"><td colspan="5">${esc(p.name)} · ${esc(p.account)}</td></tr>`
          : "";
      return label + p.metrics.map((m) => meterRow(p, m, d)).join("");
    })
    .join("");
  const meters = cards.some((p) => p.metrics.length > 0)
    ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Meter</th><th>Consumed</th><th>Share of the free limit</th><th>Next reset (${esc(zoneLabel(d.tz))})</th><th>Resets</th></tr></thead><tbody>${groups}</tbody></table></div>`
    : `<div class="empty">Connected, but there is nothing to measure on this plan.</div>`;
  const others = unmeasuredRows(cat, d, true);
  const more =
    others === ""
      ? ""
      : `<details><summary>${icon("chevron", 14).replace('class="icon"', 'class="icon chev"')}Other limits on this plan that can't be measured</summary><div class="table-wrap" style="margin-top:12px"><table class="compact"><thead><tr><th>Limit</th><th>Included</th><th>Consumed</th><th>Next reset</th><th>Resets</th></tr></thead><tbody>${others}</tbody></table></div></details>`;
  return `<section class="card" aria-label="${esc(cat.name)}">${head}${alerts}${meters}${more}</section>`;
}

function statusStrip(a: Account, d: PageData): string {
  const h = d.health;
  const sites = sitesOf(a, h);
  const down = sites.filter((s) => isDown(s.state));
  const up = sites.filter((s) => s.state?.status === "up").length;
  const doms = domainsOf(a, h);
  const soonest = doms[0];
  const high = cardsOf(a, d.ledger)
    .flatMap((p) => p.metrics.map((m) => ({ p, m })))
    .filter((x) => x.m.limit > 0)
    .sort((x, y) => pctOf(y.m) - pctOf(x.m))[0];

  const siteCard =
    sites.length === 0
      ? statCard("globe", "—", "Sites", "No site is monitored for this account")
      : !h.uptime
        ? statCard("globe", "?", "Sites", "Uptime is unavailable right now", "warn")
        : down.length > 0
          ? statCard(
              "globe",
              `${down.length} down`,
              "Sites",
              down.map((s) => esc(s.name)).join(", "),
              "bad",
            )
          : statCard("globe", `${up}/${sites.length} up`, "Sites", "checked every minute", "ok");
  const domainCard = !soonest
    ? statCard(
        "clock",
        "—",
        "Domain expiry",
        a.clients.some((c) => c.domains.length > 0) ? "not looked up yet" : "No domain on file",
      )
    : soonest.days === null
      ? statCard("clock", "?", "Domain expiry", `${esc(soonest.row.domain)}: lookup failed`, "warn")
      : statCard(
          "clock",
          soonest.days < 0 ? "expired" : `${soonest.days} days`,
          "Domain expiry",
          `${esc(soonest.row.domain)} · ${esc(formatInstant(soonest.row.expires ?? "", d.tz).text)}`,
          soonest.days <= DOMAIN_WARN_DAYS ? "warn" : "ok",
        );
  const usageCard = high
    ? statCard(
        "gauge",
        fmtPct(pctOf(high.m)),
        "Highest usage",
        `${esc(high.m.label)} · ${esc(PLATFORM_NAME[high.p.platform])}`,
        pctOf(high.m) >= HIGH_USAGE_PCT ? "bad" : pctOf(high.m) >= 50 ? "warn" : "ok",
      )
    : statCard("gauge", "—", "Highest usage", "Nothing connected yet");

  const siteTable =
    sites.length === 0 && doms.length === 0
      ? ""
      : `<details style="margin-top:16px"><summary>${icon("chevron", 14).replace('class="icon"', 'class="icon chev"')}Sites and domains</summary><div class="table-wrap" style="margin-top:12px"><table class="compact"><thead><tr><th>Site</th><th>Status</th><th class="r">Response</th><th>Last incident</th></tr></thead><tbody>${sites
          .map((s) => {
            const last = s.state?.incidents.at(-1);
            const incident = !last
              ? `<span class="muted">none in 90 days</span>`
              : last.end === undefined
                ? `<span style="color:#f87171">since ${esc(formatInstant(new Date((last.start[0] ?? 0) * 1000).toISOString(), d.tz).text)}</span><div class="muted small">${esc(last.error.at(-1) ?? "")}</div>`
                : `<span class="muted">${esc(formatInstant(new Date((last.start[0] ?? 0) * 1000).toISOString(), d.tz).text)}</span>`;
            const status = !s.state
              ? badge("unknown", "mute")
              : isDown(s.state)
                ? badge("down", "bad")
                : s.state.status === "up"
                  ? badge("up", "ok")
                  : badge(s.state.status === "degraded" ? "warning" : "checking", "warn");
            return `<tr><td><b>${esc(s.name)}</b><div class="small"><a href="${esc(s.url)}" rel="noopener noreferrer" target="_blank">${esc(s.url.replace(/^https:\/\//, ""))}</a></div></td><td>${status}${s.state?.warning ? `<div class="muted small">${esc(s.state.warning)}</div>` : ""}</td><td class="r num">${s.state?.latest ? `${Math.round(s.state.latest.ping)} ms` : "–"}</td><td>${incident}</td></tr>`;
          })
          .join("")}${doms
          .map(
            (x) =>
              `<tr><td><b>${esc(x.row.domain)}</b><div class="muted small">domain registration</div></td><td>${x.days === null ? badge("lookup failed", "warn") : x.days < 0 ? badge("expired", "bad") : x.days <= DOMAIN_WARN_DAYS ? badge("expires soon", "warn") : badge("ok", "ok")}</td><td class="r"></td><td>${x.row.expires ? `expires ${esc(formatInstant(x.row.expires, d.tz).text)}` : esc(x.row.error ?? "")}</td></tr>`,
          )
          .join("")}</tbody></table></div></details>`;
  return `<section class="card" aria-label="Status"><div class="grid stats" style="margin:0">${siteCard}${domainCard}${usageCard}</div>${siteTable}</section>`;
}

/** "in 12 min" is rounded; the live countdown beside it is not. */
function refreshCard(a: Account, cards: readonly LedgerProvider[], d: PageData): string {
  const names = [
    ...new Set(
      cards.filter((c) => c.platform !== "cloudflare").map((c) => PLATFORM_NAME[c.platform]),
    ),
  ];
  const registry = a.clients
    .flatMap((c) => c.platforms.map(platformOf))
    .filter((p): p is Platform => p !== undefined && p !== "cloudflare")
    .map((p) => PLATFORM_NAME[p]);
  const rows = refreshRows({
    runs: d.runs,
    domains: d.health.domains.filter((r) => a.clients.some((c) => c.domains.includes(r.domain))),
    now: d.health.now,
    cloudflare: cards.some((c) => c.platform === "cloudflare"),
    platforms: [...new Set([...names, ...registry])],
    sites: sitesOf(a, d.health).length > 0,
    domainCount: domainsOf(a, d.health).length,
  });
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => {
      const next = formatInstant(r.nextAt, d.tz);
      const left = Math.max(0, Date.parse(r.nextAt) - d.health.now.getTime());
      const last = r.lastAt
        ? `<div title="${esc(formatInstant(r.lastAt, d.tz).utc)}">${esc(relative(r.lastAt, d.health.now))}${r.failed ? ` ${badge("had errors", "warn")}` : ""}</div><div class="muted small" title="${esc(r.note)}">${esc(formatInstant(r.lastAt, d.tz).text)}</div>`
        : r.period
          ? `<span class="muted">Live</span>`
          : `<span class="muted">Not yet</span>`;
      const timer = `<div class="cd" data-left="${left}"${r.period ? ` data-every="${r.period}"` : " data-reload"}>in ${esc(relative(r.nextAt, d.health.now).replace(/^in /, ""))}</div>`;
      return `<tr><td>${esc(r.label)}</td><td>${badge(r.every, "mute")}</td><td>${last}</td><td>${timer}<div class="muted small" title="${esc(next.utc)}">${esc(next.text)}</div></td></tr>`;
    })
    .join("");
  return `<section class="card" aria-label="Data refresh"><div class="section-head"><h2>Data refresh</h2><span class="grow"></span><span class="muted small">Timers count down live; the page reloads itself after a refresh</span></div><div class="table-wrap"><table class="compact"><thead><tr><th>Data</th><th>Refreshes</th><th>Last refreshed</th><th>Next refresh</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

export function renderConsumptionPage(d: PageData, email?: string): string {
  const accounts = accountsOf(d.ledger);
  if (accounts.length === 0) {
    return page(
      d,
      "Consumption",
      "consumption",
      `<div class="page-head"><h1>Consumption</h1></div><div class="card empty">No clients in the registry yet.</div>`,
    );
  }
  const wanted = (email ?? "").trim().toLowerCase();
  const selected =
    accounts.find((a) => accountKey(a) === wanted) ??
    accounts.find((a) => attention(a, d) > 0) ??
    (accounts[0] as Account);
  const cards = cardsOf(selected, d.ledger);
  const registryPlatforms = new Set(
    selected.clients.flatMap((c) =>
      c.platforms.map(platformOf).filter((p): p is Platform => p !== undefined),
    ),
  );
  const sections = PLATFORM_ORDER.filter(
    (p) => cards.some((c) => c.platform === p) || registryPlatforms.has(p),
  )
    .map((p) => {
      const cat = CATALOG.find((c) => c.id === p) as PlatformCatalog;
      const ids = new Set([...selected.clients.map((c) => c.id), selected.email]);
      const usedBy = selected.clients
        .filter((c) => !c.synthetic && c.platforms.some((x) => platformOf(x) === p))
        .map((c) => c.name);
      const waiting = [
        ...new Set(
          d.ledger.data.targets
            .filter((x) => ids.has(x.clientId) && x.platform === p)
            .map((x) => x.token),
        ),
      ];
      return platformSection(
        cat,
        cards.filter((c) => c.platform === p),
        d,
        waiting,
        usedBy,
      );
    })
    .join("");
  const unmonitored = [
    ...new Set(
      selected.clients.flatMap((c) => c.platforms).filter((x) => platformOf(x) === undefined),
    ),
  ];

  const title = selected.email === "" ? "No email on file" : selected.email;
  const projects = selected.clients
    .filter((c) => !c.synthetic)
    .map((c) => `${badge(c.name)}${c.status === "live" ? "" : badge(c.status, "warn")}`)
    .join("");
  const who = `<section class="card who"><div class="card-head" style="margin:0"><button type="button" class="btn icon-only" data-sidebar-toggle aria-controls="accounts" aria-expanded="true" aria-label="Show or hide the account list" title="Accounts">${icon("panel", 16)}</button><div class="grow"><div class="muted small">Account</div><h1>${esc(title)}</h1></div></div><div class="chips pad">${projects}</div>${selected.email === "" ? `<p class="muted small" style="margin:12px 0 0">These clients have no email in the registry. Add <code>email:</code> to group them under their owner.</p>` : ""}</section>`;

  const body = `<div class="layout">${sidebar(accounts, selected, d)}<div class="stack" style="min-width:0">${who}${statusStrip(selected, d)}${refreshCard(selected, cards, d)}${sections || `<div class="card empty">No platform is on file for this account.</div>`}${unmonitored.length > 0 ? `<p class="muted small">Also uses ${unmonitored.map(esc).join(", ")}, which are not monitored.</p>` : ""}</div></div>`;
  return page(d, title, "consumption", body);
}

// ───────────────────────────── Tokens page ─────────────────────────────

const KIND_HELP: Readonly<Record<ProviderKind, { url: string; scope: string }>> = {
  github: {
    url: "https://github.com/settings/personal-access-tokens/new",
    scope:
      "A fine-grained token created by the account that owns the repositories. Account permission “Plan: read”; no repository access is needed.",
  },
  resend: {
    url: "https://resend.com/api-keys",
    scope:
      "An API key with “Full access” (Resend has no read-only key). Create one just for this and revoke it any time.",
  },
  supabase: {
    url: "https://supabase.com/dashboard/account/tokens",
    scope: "A scoped access token with read access to projects and to the database.",
  },
  vercel: {
    url: "https://vercel.com/account/tokens",
    scope:
      "A token scoped to the team. Hobby teams expose no usage numbers, so this only detects “account blocked”.",
  },
};

type TokenState =
  | { kind: "missing" }
  | { kind: "saved" }
  | { kind: "working"; at: string }
  | { kind: "failing"; error: string };

function stateOf(name: string, o: TokensOverview): TokenState {
  const checks = o.status.filter((s) => s.token === name);
  const known = o.managed.some((m) => m.name === name) || o.secretNames.includes(name);
  if (!known) return { kind: "missing" };
  const bad = checks.find((s) => !s.ok);
  if (bad) return { kind: "failing", error: bad.error ?? "unknown error" };
  const at = checks
    .filter((s) => s.ok)
    .map((s) => s.checkedAt)
    .sort()
    .at(-1);
  return at ? { kind: "working", at } : { kind: "saved" };
}

function expiryCell(m: TokenMeta | undefined, d: PageData): string {
  if (!m?.expiresAt) return `<span class="muted">No expiry set</span>`;
  const days = daysUntil(m.expiresAt, d.health.now);
  const t = formatInstant(m.expiresAt, d.tz);
  const kind = days < 0 ? "bad" : days <= 14 ? "warn" : "";
  const label =
    days < 0 ? "Expired" : days <= 14 ? `Expires in ${days} day${days === 1 ? "" : "s"}` : "";
  return `<div title="${esc(t.utc)}">${esc(t.text.split(", ")[0] ?? "")}</div><div class="small ${kind ? "" : "muted"}">${kind ? badge(label, kind) : esc(relative(m.expiresAt, d.health.now))}</div>`;
}

function statusCell(s: TokenState, d: PageData): string {
  switch (s.kind) {
    case "missing":
      return `${badge("Missing", "warn")}<div class="muted small">Not connected yet</div>`;
    case "saved":
      return `${badge("Saved", "mute")}<div class="muted small">First check within the hour</div>`;
    case "working":
      return `${badge("Working", "ok")}<div class="muted small">Checked ${esc(relative(s.at, d.health.now))}</div>`;
    case "failing":
      return `${badge("Failing", "bad")}<div class="small" style="color:#fca5a5;max-width:280px;overflow-wrap:anywhere">${esc(s.error)}</div>`;
  }
}

/** The tokens an account's platforms use: its email's, or its projects' for a project with no email. */
function tokensOf(a: Account, o: TokensOverview): RequiredToken[] {
  const ids = new Set(a.clients.map((c) => c.id));
  return o.required.filter((r) =>
    r.targets.some((t) => (a.email !== "" && t.id === a.email) || ids.has(t.id)),
  );
}

/** Missing, failing or about to expire: what the dot beside an email on the Tokens page means. */
function tokenAttention(a: Account, o: TokensOverview, d: PageData): boolean {
  return tokensOf(a, o).some((r) => {
    const s = stateOf(r.name, o);
    if (s.kind === "failing" || s.kind === "missing") return true;
    const exp = o.managed.find((m) => m.name === r.name)?.expiresAt;
    return exp ? daysUntil(exp, d.health.now) <= 14 : false;
  });
}

const WORST: Readonly<Record<TokenState["kind"], number>> = {
  failing: 3,
  missing: 2,
  saved: 1,
  working: 0,
};

/** Same layout as the Consumption tab: emails in a sidebar, and for the one you pick, a card per platform. */
export function renderTokensPage(d: PageData, o: TokensOverview, email?: string): string {
  const off = !o.enabled;
  const disabled = off ? ' disabled title="Set the TOKEN_ENCRYPTION_KEY secret first"' : "";
  const required = new Set(o.required.map((r) => r.name));

  const btn = (attrs: string, ico: Parameters<typeof icon>[0], label: string, cls = "") =>
    `<button type="button" class="btn small ${cls}" ${attrs}${disabled}>${icon(ico, 14)}${label}</button>`;

  const tokenRow = (r: RequiredToken, withPlatform: boolean): string => {
    const m = o.managed.find((x) => x.name === r.name);
    const fromSecret = !m && o.secretNames.includes(r.name);
    const state = stateOf(r.name, o);
    const added = m
      ? `ends …${esc(m.last4)} · added ${esc(formatInstant(m.createdAt, d.tz).text.split(", ")[0] ?? "")}`
      : fromSecret
        ? "from the deployment secret"
        : "";
    const conn = o.connections.find((c) => c.tokenName === r.name);
    const remove = conn
      ? btn(`data-connection-delete="${esc(conn.id)}"`, "trash", "Disconnect", "danger")
      : m
        ? btn(`data-token-delete="${esc(r.name)}"`, "trash", "Delete", "danger")
        : "";
    const actions =
      state.kind === "missing"
        ? btn(`data-token-open="${esc(r.name)}" data-mode="add"`, "key", "Add token", "primary") +
          remove
        : [
            btn(`data-token-open="${esc(r.name)}" data-mode="replace"`, "key", "Replace"),
            btn(`data-token-test="${esc(r.name)}"`, "refresh", "Test"),
            remove,
          ].join("");
    const what = r.targets
      .map((t) => t.account ?? t.projects?.join(", ") ?? "")
      .filter((x) => x !== "")
      .map((x) => esc(x))
      .join(", ");
    return `<tr id="token-${esc(r.name)}"><td data-label="Token"><code>${esc(r.name)}</code>${conn ? ` ${badge("On the site", "mute")}` : ""}${added ? `<div class="muted small">${added}</div>` : ""}</td>${withPlatform ? `<td data-label="Platform">${badge(KIND_LABEL[r.kind], "mute")}</td>` : ""}<td data-label="Account">${what || `<span class="muted">—</span>`}</td><td data-label="Status">${statusCell(state, d)}</td><td data-label="Expires">${expiryCell(m, d)}</td><td data-label=""><div class="actions">${actions}</div></td></tr>`;
  };
  const tokenTable = (rows: string, withPlatform: boolean): string =>
    `<div class="table-wrap"><table class="compact cards"><thead><tr><th>Token</th>${withPlatform ? "<th>Platform</th>" : ""}<th>Account</th><th>Status</th><th>Expires</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  const others = o.managed.filter((m) => !required.has(m.name));
  const otherRows = others
    .map(
      (m) =>
        `<tr><td data-label="Token"><code>${esc(m.name)}</code><div class="muted small">ends …${esc(m.last4)}</div></td><td data-label="Note" class="muted">No client in the registry uses this name any more</td><td data-label=""><button type="button" class="btn small danger" data-token-delete="${esc(m.name)}"${disabled}>${icon("trash", 14)}Delete</button></td></tr>`,
    )
    .join("");

  const helps = o.required
    .map((r) => {
      const h = KIND_HELP[r.kind];
      return `<template data-help-for="${esc(r.name)}"><p><b>${esc(KIND_LABEL[r.kind])}</b> · for ${r.targets.map((t) => esc(t.client)).join(", ")}</p><p>${esc(h.scope)}</p><p><a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">Create it on ${esc(KIND_LABEL[r.kind])} ↗</a></p></template>`;
    })
    .join("");

  const emailOptions = [
    ...new Set(d.ledger.data.clients.flatMap((c) => (c.email ? [c.email.toLowerCase()] : []))),
  ]
    .sort()
    .map((e) => `<option value="${esc(e)}"></option>`)
    .join("");
  const kindHelps = KINDS.map(
    (k) =>
      `<template data-kind-help="${k}"><p>${esc(KIND_HELP[k].scope)}</p><p><a href="${esc(KIND_HELP[k].url)}" target="_blank" rel="noopener noreferrer">Create it on ${esc(KIND_LABEL[k])} ↗</a></p></template>`,
  ).join("");
  const connectDialog = `<dialog id="connect-dialog" aria-labelledby="connect-title"><form method="dialog" autocomplete="off">
<h2 id="connect-title">Connect a platform</h2>
<p class="muted" style="margin:0">Paste a token and say which email its account belongs to. The site finds the account from the token, so there is nothing else to type.</p>
<div class="field"><label for="c-kind">Platform</label><select id="c-kind" name="kind">${KINDS.map((k) => `<option value="${k}">${esc(KIND_LABEL[k])}</option>`).join("")}</select></div>
<div class="help" data-kind-box></div>
<div class="field"><label for="c-value">Token</label><input id="c-value" name="value" type="password" autocomplete="new-password" spellcheck="false" data-1p-ignore data-lpignore="true" required minlength="8" placeholder="Paste the token here"><span class="hint">It is checked against the platform, encrypted, and never shown again.</span></div>
<div class="field"><label for="c-email">Email</label><input id="c-email" name="email" type="email" list="c-emails" required maxlength="254" autocomplete="off" placeholder="the email this platform account is registered with"><datalist id="c-emails">${emailOptions}</datalist><span class="hint">Everything for one email is grouped together on the Consumption tab, with one connection per platform. Pick one you already use, or type a new one.</span></div>
<div class="field" data-github hidden><label for="c-org">GitHub organization (optional)</label><input id="c-org" name="org" type="text" maxlength="39" placeholder="only if billing is on an organization"></div>
<div class="field" data-team hidden><label for="c-team">Vercel team</label><select id="c-team" name="team"></select></div>
<div class="field"><label for="c-expires">Expires on (optional)</label><input id="c-expires" name="expires" type="date"><span class="hint">The date you chose when creating it, so you are warned in time. GitHub's is read automatically.</span></div>
<div class="form-error" role="alert" data-err hidden></div>
<div class="dialog-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" data-save>Verify and connect</button></div>
</form></dialog>`;

  const dialog = `<dialog id="token-dialog" aria-labelledby="token-title"><form method="dialog" autocomplete="off">
<h2 id="token-title" data-title>Add token</h2>
<div class="help" data-help></div>
<input type="hidden" name="name">
<div class="field"><label for="token-value">Token</label><input id="token-value" name="value" type="password" autocomplete="new-password" spellcheck="false" data-1p-ignore data-lpignore="true" required minlength="8" placeholder="Paste the token here"><span class="hint">It is checked against the platform, encrypted, and never shown again.</span></div>
<div class="field"><label for="token-expires">Expires on (optional)</label><input id="token-expires" name="expires" type="date"><span class="hint">The date you chose when creating it, so you are warned in time. GitHub's is read automatically.</span></div>
<div class="form-error" role="alert" data-err hidden></div>
<div class="dialog-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" data-save>Verify and save</button></div>
</form></dialog>${connectDialog}<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>`;

  const accounts = accountsOf(d.ledger);
  const wanted = (email ?? "").trim().toLowerCase();
  const selected =
    accounts.find((a) => accountKey(a) === wanted) ??
    accounts.find((a) => tokenAttention(a, o, d)) ??
    accounts[0];

  // Tokens whose owner is not in the sidebar (e.g. a registry entry for a client that is not listed).
  const placed = new Set(accounts.flatMap((a) => tokensOf(a, o).map((r) => r.name)));
  const unplaced = o.required.filter((r) => !placed.has(r.name));

  const connectBtn = (attrs: string, label: string) =>
    `<button type="button" class="btn primary" data-connect-open ${attrs}${disabled}>${icon("key", 16)}${label}</button>`;

  const section = (a: Account, k: ProviderKind): string => {
    const toks = tokensOf(a, o).filter((r) => r.kind === k);
    const usedBy = a.clients
      .filter((c) => !c.synthetic && c.platforms.some((x) => platformOf(x) === k))
      .map((c) => c.name);
    if (toks.length === 0 && usedBy.length === 0) return "";
    const worst = toks.map((r) => stateOf(r.name, o).kind).sort((x, y) => WORST[y] - WORST[x])[0];
    const status =
      worst === undefined
        ? badge("Not connected", "warn")
        : worst === "failing"
          ? badge("Failing", "bad")
          : worst === "missing"
            ? badge("Missing", "warn")
            : worst === "saved"
              ? badge("Saved", "mute")
              : badge("Working", "ok");
    const head = `<div class="section-head"><h2>${esc(KIND_LABEL[k])}</h2><span class="grow"></span>${status}</div>${usedBy.length > 0 ? `<div class="muted small" style="margin:-4px 0 12px">Used by ${usedBy.map(esc).join(", ")}</div>` : ""}`;
    if (toks.length === 0) {
      return `<section class="card" aria-label="${esc(KIND_LABEL[k])}">${head}<div class="note" style="margin-bottom:0">${icon("plug", 18)}<div>No ${esc(KIND_LABEL[k])} token for this email yet. Paste one to read its usage.</div></div><div class="actions" style="margin-top:12px">${connectBtn(`data-kind="${k}" data-email="${esc(a.email)}"`, `Connect ${esc(KIND_LABEL[k])}`)}</div></section>`;
    }
    return `<section class="card" aria-label="${esc(KIND_LABEL[k])}">${head}${tokenTable(toks.map((r) => tokenRow(r, false)).join(""), false)}</section>`;
  };

  const kinds = PLATFORM_ORDER.filter((p): p is ProviderKind => p !== "cloudflare");
  const sections = selected ? kinds.map((k) => section(selected, k)).join("") : "";

  const projects = selected
    ? selected.clients
        .filter((c) => !c.synthetic)
        .map((c) => `${badge(c.name)}${c.status === "live" ? "" : badge(c.status, "warn")}`)
        .join("")
    : "";
  const who = selected
    ? `<section class="card who"><div class="card-head" style="margin:0"><button type="button" class="btn icon-only" data-sidebar-toggle aria-controls="accounts" aria-expanded="true" aria-label="Show or hide the account list" title="Accounts">${icon("panel", 16)}</button><div class="grow"><div class="muted small">Account</div><h1>${esc(selected.email === "" ? "No email on file" : selected.email)}</h1></div>${connectBtn(`data-email="${esc(selected.email)}"`, "Connect a platform")}</div>${projects ? `<div class="chips pad">${projects}</div>` : ""}</section>`
    : `<section class="card who"><div class="card-head" style="margin:0"><div class="grow"><div class="muted small">Tokens</div><h1>Connect a platform</h1></div>${connectBtn("", "Connect a platform")}</div></section>`;

  const empty =
    selected && sections === ""
      ? `<div class="card empty">No platform is on file for this email yet. Use <b>Connect a platform</b> to add one.</div>`
      : !selected && unplaced.length === 0
        ? `<div class="card empty">Nothing is connected yet. Use <b>Connect a platform</b> above.</div>`
        : "";

  const unplacedCard =
    unplaced.length > 0
      ? `<section class="card" aria-label="Tokens not linked to an email"><div class="card-head"><h2>Not linked to an email</h2></div>${tokenTable(
          [...unplaced]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => tokenRow(r, true))
            .join(""),
          true,
        )}</section>`
      : "";
  const othersCard =
    others.length > 0
      ? `<section class="card" aria-label="Other saved tokens"><div class="card-head"><h2>Other saved tokens</h2></div><div class="table-wrap"><table class="compact cards"><thead><tr><th>Token</th><th>Note</th><th>Actions</th></tr></thead><tbody>${otherRows}</tbody></table></div></section>`
      : "";

  const main = `<div class="stack" style="min-width:0">
${off ? `<div class="note bad">${icon("alert", 18)}<div><b>Token storage is not enabled.</b> Set the <code>TOKEN_ENCRYPTION_KEY</code> secret and redeploy to add tokens here. Tokens set in the deployment secret keep working.</div></div>` : ""}
${who}${sections}${empty}${unplacedCard}${othersCard}
<section class="card" aria-label="How tokens are kept"><div class="card-head"><span class="tile">${icon("shield", 22)}</span><h2>How tokens are kept</h2></div>
<ul class="muted" style="margin:0;padding-left:20px;display:grid;gap:6px">
<li>Encrypted (AES-256-GCM) before they are stored. The key is a separate secret, never in the database.</li>
<li>Never shown again: this page only knows the last four characters. Replace a token by pasting a new one.</li>
<li>Verified against the platform before saving, then checked every hour. A Telegram alert follows if one fails twice in a row or expires within 14 days.</li>
<li>Anyone with the site password can add, replace or delete tokens, but cannot read them. Prefer read-only tokens where the platform offers them.</li>
</ul></section>
</div>`;
  const body =
    accounts.length > 0
      ? `<div class="layout">${sidebar(accounts, selected as Account, d, "/tokens", (a) => tokenAttention(a, o, d))}${main}</div>${helps}${kindHelps}${dialog}`
      : `${main}${helps}${kindHelps}${dialog}`;
  return page(d, "Tokens", "tokens", body);
}
