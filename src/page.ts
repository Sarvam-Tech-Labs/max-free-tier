/** GET / — plain HTML string. No framework, no external scripts, no external CSS. */
import type { MetricKey, Spike } from "./spike";
import { formatRatio } from "./spike";

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function fmtNum(n: number | undefined): string {
  if (n === undefined) return "–";
  return Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export interface PageModel {
  /** Ascending, oldest first; the last one is today. */
  dates: string[];
  table: Map<MetricKey, Map<string, number>>;
  spikes: Spike[];
  /** ISO timestamp of the newest collected_at, or null when the table is empty. */
  lastCollected: string | null;
}

/**
 * Same gauge mark as the hosted Usage Guard (my-open-project apps/b-inbox/public/favicon.svg, 2026-09-15):
 * blue 270° ring + purple needle on a dark tile. Inlined as a data URI so the Worker ships no static assets.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>usage-guard-collector</title><rect width="64" height="64" rx="14" fill="#141821"/><rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="#232838"/><circle cx="32" cy="34" r="16" fill="none" stroke="#4f8cff" stroke-width="6" stroke-dasharray="75.40 100.53" transform="rotate(135 32 34)"/><path d="M32 34L41.5 28.4" stroke="#a78bfa" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="34" r="4.5" fill="#a78bfa"/></svg>`;

export function faviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;
}

const CSS = `body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:64rem;margin:2rem auto;padding:0 1rem;color:#222}
table{border-collapse:collapse;width:100%}th,td{padding:.3rem .5rem;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{font-weight:600}.spike{background:#fff3e0}.muted{color:#777}code{font-size:.9em}`;

export function renderPage(m: PageModel): string {
  const spikeKeys = new Set(m.spikes.map((s) => s.metric));
  const head = m.dates.map((d) => `<th>${escapeHtml(d.slice(5))}</th>`).join("");
  const metrics = [...m.table.keys()].sort();
  const body =
    metrics.length === 0
      ? `<tr><td colspan="${m.dates.length + 1}" class="muted">No rows yet. The Cron runs every 6 hours; trigger one with <code>curl -X POST http://127.0.0.1:8787/__scheduled</code> under <code>wrangler dev --test-scheduled</code>.</td></tr>`
      : metrics
          .map((k) => {
            const byDate = m.table.get(k) as Map<string, number>;
            const cells = m.dates.map((d) => `<td>${fmtNum(byDate.get(d))}</td>`).join("");
            return `<tr${spikeKeys.has(k) ? ' class="spike"' : ""}><td><code>${escapeHtml(k)}</code></td>${cells}</tr>`;
          })
          .join("");

  const spikes =
    m.spikes.length === 0
      ? `<p class="muted">No spikes today (today ≥ 10× the 7-day median and above the per-metric floor).</p>`
      : `<ul>${m.spikes
          .map(
            (s) =>
              `<li><code>${escapeHtml(s.metric)}</code>: ${fmtNum(s.today)} today vs. median ${fmtNum(s.baseline)} (${escapeHtml(formatRatio(s.ratio))})</li>`,
          )
          .join("")}</ul>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#141821"><link rel="icon" type="image/svg+xml" href="${faviconHref()}"><title>usage-guard-collector</title><style>${CSS}</style></head><body>
<h1>Cloudflare usage, last ${m.dates.length} days</h1>
<p class="muted">Account-wide daily totals from the GraphQL Analytics API (UTC days; today is partial).
${m.lastCollected ? `Last collected ${escapeHtml(m.lastCollected)}.` : "Not collected yet."}
These are analytics counts, not the invoice.</p>
<h2>Spikes</h2>${spikes}
<h2>Daily totals</h2>
<table><thead><tr><th>metric</th>${head}</tr></thead><tbody>${body}</tbody></table>
<p class="muted">Read-only. Source: <a href="https://github.com/HowardZlh/usage-guard-collector">github.com/HowardZlh/usage-guard-collector</a>.</p>
</body></html>`;
}
