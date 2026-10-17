import { describe, expect, it } from "vitest";
import type { UsageRow } from "../src/graphql";
import {
  buildSeries,
  filterUnnotified,
  loadTotals,
  markNotified,
  pivot,
  splitKey,
  upsertRows,
} from "../src/store";
import { createFakeD1, rawDb } from "./helpers/fake-d1";

const row = (date: string, metric: string, dim: string, value: number): UsageRow => ({
  date,
  product: "d1",
  metric,
  dim,
  value,
});

describe("upsertRows / loadTotals", () => {
  it("empty input writes nothing and returns 0", async () => {
    const db = createFakeD1();
    expect(await upsertRows(db, [], "t")).toBe(0);
    expect(await loadTotals(db, "2000-01-01", "2100-01-01")).toEqual([]);
  });

  it("re-collecting the same key overwrites value and collected_at; totals sum across dims", async () => {
    const db = createFakeD1();
    await upsertRows(
      db,
      [row("2026-09-14", "rows_read", "a", 10), row("2026-09-14", "rows_read", "b", 5)],
      "t1",
    );
    await upsertRows(db, [row("2026-09-14", "rows_read", "a", 100)], "t2");
    const raw = rawDb(db)
      .prepare("SELECT value, collected_at FROM usage_daily WHERE dim = 'a'")
      .get() as { value: number; collected_at: string };
    expect(raw).toEqual({ value: 100, collected_at: "t2" });

    const totals = await loadTotals(db, "2026-09-14", "2026-09-14");
    expect(totals).toEqual([{ date: "2026-09-14", metric: "d1.rows_read", value: 105 }]);
  });

  it("date range is inclusive on both ends and excludes outside dates", async () => {
    const db = createFakeD1();
    await upsertRows(
      db,
      [
        row("2026-09-10", "rows_read", "a", 1),
        row("2026-09-11", "rows_read", "a", 2),
        row("2026-09-12", "rows_read", "a", 3),
      ],
      "t",
    );
    const t = await loadTotals(db, "2026-09-11", "2026-09-12");
    expect(t.map((r) => r.value)).toEqual([2, 3]);
  });
});

describe("buildSeries", () => {
  it("splits today from history and ignores future dates", () => {
    const s = buildSeries(
      [
        { date: "2026-09-12", metric: "a", value: 1 },
        { date: "2026-09-13", metric: "a", value: 2 },
        { date: "2026-09-14", metric: "a", value: 30 },
        { date: "2026-09-14", metric: "b", value: 7 },
        { date: "2026-09-15", metric: "a", value: 99 },
      ],
      "2026-09-14",
    );
    expect(s.today).toEqual({ a: 30, b: 7 });
    expect(s.last7).toEqual({ a: [1, 2] });
  });
  it("empty → empty", () =>
    expect(buildSeries([], "2026-09-14")).toEqual({ today: {}, last7: {} }));
});

describe("pivot", () => {
  it("metric → date → value", () => {
    const p = pivot([
      { date: "d1", metric: "a", value: 1 },
      { date: "d2", metric: "a", value: 2 },
      { date: "d1", metric: "b", value: 3 },
    ]);
    expect(p.get("a")?.get("d2")).toBe(2);
    expect(p.get("b")?.get("d1")).toBe(3);
    expect(p.get("b")?.get("d2")).toBeUndefined();
  });
});

describe("spike_notified dedupe", () => {
  const spikes = [
    { metric: "d1.rows_read", today: 10, baseline: 1, ratio: 10 },
    { metric: "kv.read", today: 10, baseline: 1, ratio: 10 },
  ];

  it("nothing marked → all spikes fresh; empty list short-circuits", async () => {
    const db = createFakeD1();
    expect(await filterUnnotified(db, "2026-09-14", [])).toEqual([]);
    expect(await filterUnnotified(db, "2026-09-14", spikes)).toEqual(spikes);
  });

  it("marked spikes are dropped for that date only; re-marking is idempotent", async () => {
    const db = createFakeD1();
    await markNotified(db, "2026-09-14", [], "t0"); // no-op
    await markNotified(db, "2026-09-14", [spikes[0] as (typeof spikes)[0]], "t1");
    await markNotified(db, "2026-09-14", [spikes[0] as (typeof spikes)[0]], "t2");
    expect(await filterUnnotified(db, "2026-09-14", spikes)).toEqual([spikes[1]]);
    expect(await filterUnnotified(db, "2026-09-15", spikes)).toEqual(spikes);
    const n = rawDb(db).prepare("SELECT COUNT(*) AS n FROM spike_notified").get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("splitKey", () => {
  it("splits on the first dot", () =>
    expect(splitKey("d1.rows_read")).toEqual(["d1", "rows_read"]));
  it("no dot → empty metric", () => expect(splitKey("weird")).toEqual(["weird", ""]));
});
