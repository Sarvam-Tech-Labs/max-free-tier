// pnpm test — the drift check must flag a moved number AND a page that changed shape, never pass silently.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAll, checkMetric, freeCell, parseAmount, report, SOURCES } from "./limits-drift.mjs";

test("parseAmount reads the formats Cloudflare uses", () => {
  assert.deepEqual(parseAmount(" 5 million / day "), { limit: 5_000_000, period: "day" });
  assert.deepEqual(parseAmount(" 100,000 per day "), { limit: 100_000, period: "day" });
  assert.deepEqual(parseAmount(" 10,000 operations/day included "), { limit: 10_000, period: "day" });
  assert.deepEqual(parseAmount(" 1 million requests / month "), { limit: 1_000_000, period: "month" });
  assert.equal(parseAmount(" Unlimited "), null);
  assert.equal(parseAmount(" 100 "), null); // a number without a period is not comparable
  assert.equal(parseAmount(undefined), null);
});

test("freeCell finds the Free column, honours `after`, returns null when the row is gone", () => {
  const md = "| Class A Operations | $4.50 |\n### Free tier\n| Class A Operations | 1 million requests / month |\n";
  assert.equal(freeCell(md, { row: /^\|\s*Class A Operations\s*\|/ }).trim(), "$4.50");
  assert.equal(freeCell(md, { after: "### Free tier", row: /^\|\s*Class A Operations\s*\|/ }).trim(), "1 million requests / month");
  assert.equal(freeCell(md, { after: "### Nope", row: /Class A/ }), null);
  assert.equal(freeCell(md, { row: /^\|\s*Gone\s*\|/ }), null);
});

const KV = "| Keys read | 100,000 / day | 10 million/month |\n| Keys written | 1,000 / day | x |\n";
const spec = { file: "partials/workers/kv_pricing.mdx", row: /^\|\s*Keys read\s*\|/ };
const ours = { limit: 100_000, period: "day" };
const serve = (md) => async () => md;

test("ok when the docs match", async () => {
  assert.equal((await checkMetric("kv.read", ours, spec, serve(KV))).status, "ok");
});

test("DRIFT when the number or the period moved", async () => {
  const num = await checkMetric("kv.read", ours, spec, serve(KV.replace("100,000 / day", "50,000 / day")));
  assert.equal(num.status, "drift");
  assert.match(num.detail, /docs say 50,000\/day, limits\.ts has 100,000\/day/);
  assert.equal((await checkMetric("kv.read", ours, spec, serve(KV.replace("100,000 / day", "3 million / month")))).status, "drift");
});

test("UNVERIFIABLE when the row vanished, the cell is unreadable, or the fetch fails", async () => {
  assert.equal((await checkMetric("kv.read", ours, spec, serve("| Keys written | 1,000 / day |"))).status, "unverifiable");
  assert.equal((await checkMetric("kv.read", ours, spec, serve("| Keys read | Unlimited |"))).status, "unverifiable");
  const down = await checkMetric("kv.read", ours, spec, async () => {
    throw new Error("HTTP 404");
  });
  assert.equal(down.status, "unverifiable");
  assert.match(down.detail, /HTTP 404/);
});

test("a metric with no mapped docs source is reported, not skipped", async () => {
  const r = await checkAll({ "new.metric": { limit: 1, period: "day" } }, SOURCES, serve(""));
  assert.equal(r[0].status, "unverifiable");
  assert.match(r[0].detail, /no docs source mapped/);
});

test("report lists every result and only the problems as `bad`", () => {
  const { bad, text } = report([
    { metric: "a", status: "ok", detail: "1/day" },
    { metric: "b", status: "drift", detail: "x" },
  ]);
  assert.equal(bad.length, 1);
  assert.match(text, /ok .*a: 1\/day\nDRIFT .*b: x/);
});
