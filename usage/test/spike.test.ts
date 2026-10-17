import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  FALLBACK_THRESHOLD,
  formatRatio,
  median,
  parseThresholds,
  SPIKE_RATIO,
  spike,
} from "../src/spike";

describe("median", () => {
  it("empty → 0", () => expect(median([])).toBe(0));
  it("odd length → middle", () => expect(median([5, 1, 3])).toBe(3));
  it("even length → mean of the two middle values", () => expect(median([4, 1, 3, 2])).toBe(2.5));
  it("does not mutate the input", () => {
    const v = [3, 1, 2];
    median(v);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe("parseThresholds", () => {
  it("undefined / empty / blank → defaults (a copy)", () => {
    for (const j of [undefined, "", "   "]) {
      const t = parseThresholds(j);
      expect(t).toEqual(DEFAULT_THRESHOLDS);
      expect(t).not.toBe(DEFAULT_THRESHOLDS);
    }
  });
  it("merges overrides and allows new keys", () => {
    const t = parseThresholds('{"d1.rows_read": 5, "custom.x": 0}');
    expect(t["d1.rows_read"]).toBe(5);
    expect(t["custom.x"]).toBe(0);
    expect(t["workers.requests"]).toBe(DEFAULT_THRESHOLDS["workers.requests"]);
  });
  it("rejects non-object JSON", () => {
    expect(() => parseThresholds("[1]")).toThrow("must be a JSON object");
    expect(() => parseThresholds("null")).toThrow("must be a JSON object");
    expect(() => parseThresholds("3")).toThrow("must be a JSON object");
  });
  it("rejects non-numeric, negative or non-finite values", () => {
    expect(() => parseThresholds('{"a": "1"}')).toThrow("THRESHOLDS_JSON[a]");
    expect(() => parseThresholds('{"a": -1}')).toThrow("THRESHOLDS_JSON[a]");
    expect(() => parseThresholds('{"a": null}')).toThrow("THRESHOLDS_JSON[a]");
  });
  it("invalid JSON throws", () => expect(() => parseThresholds("{oops")).toThrow());
});

describe("spike", () => {
  const th = { "d1.rows_read": 100, "kv.read": 10 };

  it("flags today ≥ 10× median and ≥ floor", () => {
    const out = spike({ "d1.rows_read": 1000 }, { "d1.rows_read": [100, 90, 110] }, th);
    expect(out).toEqual([{ metric: "d1.rows_read", today: 1000, baseline: 100, ratio: 10 }]);
  });

  it("below the absolute floor → not a spike even at 1000×", () => {
    expect(spike({ "d1.rows_read": 99 }, { "d1.rows_read": [0, 0, 0] }, th)).toEqual([]);
  });

  it("above the floor but under the ratio → not a spike", () => {
    expect(spike({ "d1.rows_read": 999 }, { "d1.rows_read": [100, 100, 100] }, th)).toEqual([]);
  });

  it("no history for the metric → skipped (first day after deploy)", () => {
    expect(spike({ "d1.rows_read": 10_000 }, {}, th)).toEqual([]);
    expect(spike({ "d1.rows_read": 10_000 }, { "d1.rows_read": [] }, th)).toEqual([]);
  });

  it("baseline 0 with today above floor → ratio Infinity", () => {
    const out = spike({ "kv.read": 50 }, { "kv.read": [0, 0] }, th);
    expect(out).toEqual([
      { metric: "kv.read", today: 50, baseline: 0, ratio: Number.POSITIVE_INFINITY },
    ]);
  });

  it("unknown metric uses FALLBACK_THRESHOLD", () => {
    expect(spike({ "x.y": FALLBACK_THRESHOLD - 1 }, { "x.y": [1] }, th)).toEqual([]);
    expect(spike({ "x.y": FALLBACK_THRESHOLD }, { "x.y": [1] }, th)).toHaveLength(1);
  });

  it("defaults are used when thresholds omitted; output sorted by metric", () => {
    const today = { "kv.read": 1_000_000, "d1.rows_written": 5_000_000 };
    const hist = { "kv.read": [1000], "d1.rows_written": [1000] };
    const out = spike(today, hist);
    expect(out.map((s) => s.metric)).toEqual(["d1.rows_written", "kv.read"]);
    expect(out[0]?.ratio).toBe(5000);
  });

  it("exposes the ratio constant used in copy", () => expect(SPIKE_RATIO).toBe(10));
});

describe("formatRatio", () => {
  it("finite → one decimal with ×", () => expect(formatRatio(12.345)).toBe("12.3×"));
  it("Infinity → new", () => expect(formatRatio(Number.POSITIVE_INFINITY)).toBe("new"));
});
