// Do the free-plan numbers in usage/src/limits.ts still match Cloudflare's docs?
//   node --experimental-strip-types scripts/limits-drift.mjs        (Node 22.6+; prints a report, exit 1 on any problem)
// Cloudflare's docs are open source, so the numbers are read from their Markdown source (the same files the terms watch
// diffs). A number that moved is DRIFT; a table row we can no longer find or parse is UNVERIFIABLE (the page was
// restructured), so a silent docs change cannot hide behind "no drift found". Other platforms publish HTML only and stay
// on the diff-only terms watch (watch/urls.yaml).
// With TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set, a problem is also posted to Telegram.
import { fileURLToPath } from "node:url";
import { FREE_PLAN_LIMITS } from "../usage/src/limits.ts";

const DOCS = "https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/";

/**
 * metric → where the Free-plan cell lives: file, the table row to find, optionally a heading to start after.
 * The Free value is the first data cell after the row label.
 */
export const SOURCES = {
  "workers.requests": { file: "docs/workers/platform/pricing.mdx", row: /^\|\s*\*\*Free\*\*\s*\|/ },
  "d1.rows_read": { file: "partials/workers/d1-pricing.mdx", row: /^\|\s*Rows read\s*\|/ },
  "d1.rows_written": { file: "partials/workers/d1-pricing.mdx", row: /^\|\s*Rows written\s*\|/ },
  "do.requests": { file: "partials/durable-objects/durable-objects-pricing.mdx", row: /^\|\s*Requests\s*\|/ },
  "kv.read": { file: "partials/workers/kv_pricing.mdx", row: /^\|\s*Keys read\s*\|/ },
  "kv.write": { file: "partials/workers/kv_pricing.mdx", row: /^\|\s*Keys written\s*\|/ },
  "kv.delete": { file: "partials/workers/kv_pricing.mdx", row: /^\|\s*Keys deleted\s*\|/ },
  "kv.list": { file: "partials/workers/kv_pricing.mdx", row: /^\|\s*List requests\s*\|/ },
  "queues.operations": { file: "partials/workers/queues_pricing.mdx", row: /^\|\s*Standard operations\s*\|/ },
  "ai.neurons": { file: "docs/workers-ai/platform/pricing.mdx", row: /^\|\s*Workers Free\s*\|/ },
  "r2.class_a": { file: "docs/r2/pricing.mdx", after: "### Free tier", row: /^\|\s*Class A Operations\s*\|/ },
  "r2.class_b": { file: "docs/r2/pricing.mdx", after: "### Free tier", row: /^\|\s*Class B Operations\s*\|/ },
};

/** "5 million / day" → { limit: 5000000, period: "day" }; "10,000 operations/day included" → { 10000, "day" }. */
export function parseAmount(cell) {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(million|billion)?/i.exec(cell ?? "");
  if (!m) return null;
  const mult = { million: 1e6, billion: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  const limit = Math.round(Number(m[1].replace(/,/g, "")) * mult);
  const period = /\/\s*day|per day|a day/i.test(cell) ? "day" : /month/i.test(cell) ? "month" : null;
  return period && Number.isFinite(limit) ? { limit, period } : null;
}

/** The Free cell of the first table row matching `spec.row` (after `spec.after` if given), or null. */
export function freeCell(markdown, spec) {
  let text = markdown;
  if (spec.after) {
    const i = text.indexOf(spec.after);
    if (i < 0) return null;
    text = text.slice(i);
  }
  const line = text.split(/\r?\n/).find((l) => spec.row.test(l));
  // cells[0] is the empty text before the first "|", cells[1] the row label, cells[2] the Free column.
  return line ? (line.split("|")[2] ?? null) : null;
}

/** Compare one metric. `fetchText(url)` → Markdown. Returns { metric, status: ok | drift | unverifiable, detail }. */
export async function checkMetric(metric, ours, spec, fetchText) {
  let md;
  try {
    md = await fetchText(DOCS + spec.file);
  } catch (e) {
    return { metric, status: "unverifiable", detail: `could not fetch ${spec.file}: ${e.message}` };
  }
  const cell = freeCell(md, spec);
  const theirs = cell === null ? null : parseAmount(cell);
  if (!theirs) {
    return { metric, status: "unverifiable", detail: `Free cell not found or unreadable in ${spec.file} (${cell?.trim() ?? "row missing"}); the page changed shape` };
  }
  if (theirs.limit !== ours.limit || theirs.period !== ours.period) {
    return { metric, status: "drift", detail: `docs say ${theirs.limit.toLocaleString("en-US")}/${theirs.period}, limits.ts has ${ours.limit.toLocaleString("en-US")}/${ours.period}` };
  }
  return { metric, status: "ok", detail: `${ours.limit.toLocaleString("en-US")}/${ours.period}` };
}

export async function checkAll(limits, sources, fetchText) {
  const out = [];
  for (const [metric, ours] of Object.entries(limits)) {
    const spec = sources[metric];
    // A metric added to limits.ts without a docs source here must be a conscious choice, not an oversight.
    out.push(spec ? await checkMetric(metric, ours, spec, fetchText) : { metric, status: "unverifiable", detail: "no docs source mapped in scripts/limits-drift.mjs" });
  }
  return out;
}

export function report(results) {
  const bad = results.filter((r) => r.status !== "ok");
  const lines = results.map((r) => `${r.status === "ok" ? "ok         " : r.status === "drift" ? "DRIFT      " : "UNVERIFIABLE"} ${r.metric}: ${r.detail}`);
  return { bad, text: lines.join("\n") };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "max-free-tier-limits-drift" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { bad, text } = report(await checkAll(FREE_PLAN_LIMITS, SOURCES, fetchText));
  console.log(text);
  if (bad.length === 0) {
    console.log(`\nAll ${Object.keys(FREE_PLAN_LIMITS).length} Cloudflare free-plan limits match the docs.`);
  } else {
    const msg = `max-free-tier: ${bad.length} free-plan limit${bad.length === 1 ? "" : "s"} need attention\n${bad.map((r) => `• ${r.metric}: ${r.detail}`).join("\n")}\nFix: update usage/src/limits.ts (FREE_PLAN_LIMITS, LIMITS_AS_OF), or scripts/limits-drift.mjs if the docs page was restructured.`;
    console.error(`\n${msg}`);
    const { TELEGRAM_BOT_TOKEN: bot, TELEGRAM_CHAT_ID: chat } = process.env;
    if (bot && chat) {
      const res = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }),
      }).catch(() => null);
      console.error(res?.ok ? "Posted to Telegram." : "Telegram post failed.");
    }
    process.exit(1);
  }
}
