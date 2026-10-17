import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { GRAPHQL_ENDPOINT } from "../src/graphql";
import {
  FREE_PLAN_LIMITS,
  formatLimitLine,
  formatPct,
  limitStatus,
  parseLevels,
  parseLimits,
} from "../src/limits";
import { formatReport } from "../src/notify";
import { renderPage } from "../src/page";
import { accountKey, parseAccounts, parseLabels, renderIndex, runCollect } from "../src/run";
import { filterUnnotifiedLimits, markLimitNotified, sumByMetric, upsertRows } from "../src/store";
import { createFakeD1, rawDb } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T13:00:00Z");

describe("parseLimits / parseLevels", () => {
  it("defaults to the free-plan table", () => {
    expect(parseLimits(undefined)).toEqual(FREE_PLAN_LIMITS);
    expect(parseLimits("  ")).toEqual(FREE_PLAN_LIMITS);
  });

  it("overrides keep the metric's period, 0 removes, unknown metrics are daily", () => {
    const l = parseLimits('{"r2.class_a": 500, "d1.rows_read": 0, "custom.thing": 7}');
    expect(l["r2.class_a"]).toEqual({ limit: 500, period: "month" });
    expect(l["d1.rows_read"]).toBeUndefined();
    expect(l["custom.thing"]).toEqual({ limit: 7, period: "day" });
  });

  it("rejects non-objects and bad numbers", () => {
    expect(() => parseLimits("[1]")).toThrow("LIMITS_JSON must be a JSON object");
    expect(() => parseLimits('{"a": -1}')).toThrow("LIMITS_JSON[a]");
    expect(() => parseLimits('{"a": "5"}')).toThrow("LIMITS_JSON[a]");
  });

  it("levels are whole percentages, de-duplicated and sorted", () => {
    expect(parseLevels("95, 50,80,50")).toEqual([50, 80, 95]);
    expect(() => parseLevels("0")).toThrow("LIMIT_LEVELS");
    expect(() => parseLevels("101")).toThrow("LIMIT_LEVELS");
    expect(() => parseLevels("50,abc")).toThrow("LIMIT_LEVELS");
    expect(() => parseLevels("12.5")).toThrow("LIMIT_LEVELS");
  });
});

describe("limitStatus", () => {
  const limits = parseLimits(undefined);
  const levels = [50, 80, 95];

  it("daily metrics use today, monthly ones month-to-date; unused metrics are skipped", () => {
    const out = limitStatus(
      "2026-10-18",
      { "d1.rows_written": 85_000, "r2.class_a": 10 },
      { "r2.class_a": 600_000, "d1.rows_written": 999_999 },
      limits,
      levels,
    );
    expect(out).toEqual([
      {
        metric: "d1.rows_written",
        used: 85_000,
        limit: 100_000,
        period: "day",
        periodKey: "2026-10-18",
        pct: 85,
        level: 80,
      },
      {
        metric: "r2.class_a",
        used: 600_000,
        limit: 1_000_000,
        period: "month",
        periodKey: "2026-10",
        pct: 60,
        level: 50,
      },
    ]);
  });

  it("below the lowest level → level null; at exactly a level → that level", () => {
    const [low] = limitStatus("2026-10-18", { "kv.write": 100 }, {}, limits, levels);
    expect(low?.level).toBeNull();
    const [exact] = limitStatus("2026-10-18", { "kv.write": 950 }, {}, limits, levels);
    expect(exact?.level).toBe(95);
  });

  it("formats percentages and lines", () => {
    expect(formatPct(4.25)).toBe("4.3%");
    expect(formatPct(85.4)).toBe("85%");
    const [s] = limitStatus("2026-10-18", { "d1.rows_written": 85_000 }, {}, limits, levels);
    expect(formatLimitLine(s as NonNullable<typeof s>)).toBe(
      "• d1.rows_written: 85,000 of 100,000 per day (85%) — past 80% of the free-plan limit",
    );
  });
});

describe("account helpers", () => {
  it("parseAccounts trims, drops blanks, de-duplicates", () => {
    expect(parseAccounts(" a, b ,,a ")).toEqual(["a", "b"]);
    expect(parseAccounts(undefined)).toEqual([]);
  });
  it("parseLabels: empty → {}, invalid → throws", () => {
    expect(parseLabels("")).toEqual({});
    expect(parseLabels('{"a":"Acme"}')).toEqual({ a: "Acme" });
    expect(() => parseLabels('{"a": 1}')).toThrow("ACCOUNT_LABELS_JSON");
    expect(() => parseLabels("[]")).toThrow("ACCOUNT_LABELS_JSON");
  });
  it('accountKey is "" for a single account (keeps old history), the id otherwise', () => {
    expect(accountKey(["a"], "a")).toBe("");
    expect(accountKey(["a", "b"], "b")).toBe("b");
  });
});

describe("store: limit notifications", () => {
  it("sumByMetric adds across dates", () => {
    expect(
      sumByMetric([
        { date: "2026-10-01", metric: "r2.class_a", value: 5 },
        { date: "2026-10-02", metric: "r2.class_a", value: 7 },
      ]),
    ).toEqual({ "r2.class_a": 12 });
  });

  it("a level alerts once; a higher level still alerts; a lower one never re-alerts", async () => {
    const db = createFakeD1();
    const at = (level: number | null, used = 1) => ({
      metric: "d1.rows_written",
      used,
      limit: 100_000,
      period: "day" as const,
      periodKey: "2026-10-18",
      pct: level ?? 1,
      level,
    });
    expect(await filterUnnotifiedLimits(db, "acc", [at(null)])).toEqual([]);
    const first = await filterUnnotifiedLimits(db, "acc", [at(80)]);
    expect(first).toHaveLength(1);
    await markLimitNotified(db, "acc", first, "t1");
    expect(await filterUnnotifiedLimits(db, "acc", [at(80)])).toEqual([]);
    expect(await filterUnnotifiedLimits(db, "acc", [at(50)])).toEqual([]);
    expect(await filterUnnotifiedLimits(db, "acc", [at(95)])).toHaveLength(1);
    // another account and another day are independent
    expect(await filterUnnotifiedLimits(db, "other", [at(80)])).toHaveLength(1);
    await markLimitNotified(db, "acc", [], "t2"); // no-op
  });
});

describe("migration 0001 keeps single-account history", () => {
  it("rows written before the migration move to account ''", () => {
    const dir = join(__dirname, "..", "migrations");
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(join(dir, "0000_usage_daily.sql"), "utf8"));
    db.exec(
      "INSERT INTO usage_daily VALUES ('2026-10-01','d1','rows_read','db',42,'t'); INSERT INTO spike_notified VALUES ('2026-10-01','d1','rows_read','t');",
    );
    db.exec(readFileSync(join(dir, "0001_accounts_and_limits.sql"), "utf8"));
    expect(db.prepare("SELECT account, value FROM usage_daily").get()).toEqual({
      account: "",
      value: 42,
    });
    expect(db.prepare("SELECT account FROM spike_notified").get()).toEqual({ account: "" });
  });
});

describe("formatReport", () => {
  const spike = { metric: "kv.read", today: 50, baseline: 0, ratio: Number.POSITIVE_INFINITY };
  const limit = limitStatus("2026-10-18", { "kv.write": 900 }, {}, parseLimits(undefined), [80])[0];

  it("single unlabelled spike-only section is the classic message", () => {
    expect(formatReport("2026-10-18", [{ spikes: [spike], limits: [] }])).toMatch(
      /^usage-guard-collector — 1 spike on 2026-10-18 \(UTC\)\n• kv.read/,
    );
  });

  it("labels and limit lines once several accounts or limits are involved", () => {
    const text = formatReport("2026-10-18", [
      { label: "Acme", spikes: [], limits: [limit as NonNullable<typeof limit>] },
      { label: "Beta", spikes: [spike], limits: [] },
    ]);
    expect(text).toBe(
      "usage-guard-collector — 2 alerts on 2026-10-18 (UTC)\nAcme\n• kv.write: 900 of 1,000 per day (90%) — past 80% of the free-plan limit\n\nBeta\n• kv.read: 50 today vs. 7-day median 0 (new)",
    );
    expect(
      formatReport("2026-10-18", [{ spikes: [], limits: [limit as NonNullable<typeof limit>] }]),
    ).toMatch(/^usage-guard-collector — 1 alert on/);
  });
});

/** GraphQL stub: per-account D1 rows_written; one account can be made to fail. Telegram 200. */
function stub(writtenByAccount: Record<string, number>, failing?: string) {
  const sent: string[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      variables?: { account: string };
      text?: string;
    };
    if (url !== GRAPHQL_ENDPOINT) {
      sent.push(String(body.text));
      return Response.json({ ok: true });
    }
    const account = body.variables?.account as string;
    if (account === failing) return Response.json({ errors: [{ message: "not authorized" }] });
    const g = {
      sum: {
        rowsRead: 10,
        rowsWritten: writtenByAccount[account] ?? 0,
        readQueries: 1,
        writeQueries: 1,
      },
      dimensions: { databaseId: "db" },
    };
    return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [g] }] } } });
  }) as unknown as typeof fetch;
  return { f, sent };
}

const telegram = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };

function env(over: Partial<Env> = {}): Env {
  return { USAGE: createFakeD1(), CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "aaa,bbb", ...over };
}

describe("runCollect: several accounts + limit alerts", () => {
  afterEach(() => vi.useRealTimers());

  it("keys rows by account and alerts each crossed level once, labelled", async () => {
    const e = env({
      ...telegram,
      ACCOUNT_LABELS_JSON: '{"aaa":"Acme"}',
      LIMIT_LEVELS: "50,80,95",
    });
    // Each run collects yesterday + today with the same stubbed value, so today's total = the value.
    const s1 = await runCollect(e, NOW, stub({ aaa: 85_000, bbb: 10 }).f);
    expect(s1).toMatchObject({ written: 16, spikes: 0, notified: 1, limitAlerts: 1 });
    const keys = rawDb(e.USAGE)
      .prepare("SELECT DISTINCT account FROM usage_daily ORDER BY account")
      .all();
    expect(keys).toEqual([{ account: "aaa" }, { account: "bbb" }]);

    const run2 = stub({ aaa: 85_000, bbb: 10 });
    const s2 = await runCollect(e, NOW, run2.f);
    expect(s2.notified).toBe(0); // 80% already posted today
    expect(run2.sent).toEqual([]);

    const run3 = stub({ aaa: 97_000, bbb: 10 });
    await runCollect(e, NOW, run3.f);
    expect(run3.sent).toHaveLength(1);
    expect(run3.sent[0]).toContain("Acme\n• d1.rows_written: 97,000 of 100,000 per day (97%)");
  });

  it("one failing account does not stop the others; its label prefixes the error", async () => {
    const e = env({ ...telegram, ACCOUNT_LABELS_JSON: '{"bbb":"Beta"}', LIMIT_LEVELS: "80" });
    const { f, sent } = stub({ aaa: 90_000 }, "bbb");
    const s = await runCollect(e, NOW, f);
    expect(s.error).toBe("Beta: graphql: not authorized");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("aaa\n• d1.rows_written"); // unlabelled account shows its id
  });

  it("bad ACCOUNT_LABELS_JSON / LIMIT_LEVELS are reported but collection continues", async () => {
    const e = env({ ACCOUNT_LABELS_JSON: "{nope", LIMIT_LEVELS: "abc" });
    const s = await runCollect(e, NOW, stub({ aaa: 1 }).f);
    expect(s.written).toBe(16);
    expect(s.error).toContain("LIMIT_LEVELS");
    expect(s.error?.split("; ").length).toBe(3); // labels + one per account
  });

  it("limit alerts are off unless LIMIT_LEVELS is set", async () => {
    const e = env({ ...telegram, CF_ACCOUNT_ID: "aaa" });
    const { f, sent } = stub({ aaa: 99_000 });
    const s = await runCollect(e, NOW, f);
    expect(s.limitAlerts).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("a notify crash is reported, nothing marked", async () => {
    const e = env({ ...telegram, CF_ACCOUNT_ID: "aaa", LIMIT_LEVELS: "50" });
    const base = stub({ aaa: 99_000 }).f;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url !== GRAPHQL_ENDPOINT) throw new Error("socket closed");
      return base(url, init);
    }) as unknown as typeof fetch;
    const s = await runCollect(e, NOW, f);
    expect(s.notified).toBe(0);
    const n = rawDb(e.USAGE).prepare("SELECT COUNT(*) AS n FROM limit_notified").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });
});

describe("renderIndex / renderPage with accounts and limits", () => {
  it("one section per account with labels and a limits table", async () => {
    const e = env({ ACCOUNT_LABELS_JSON: '{"aaa":"Acme <Ltd>"}', LIMIT_LEVELS: "50,80" });
    await upsertRows(
      e.USAGE,
      [{ date: "2026-10-18", product: "d1", metric: "rows_written", dim: "db", value: 90_000 }],
      "2026-10-18T12:00:00Z",
      "aaa",
    );
    const html = await renderIndex(e, NOW);
    expect(html).toContain("<h2>Acme &lt;Ltd&gt;</h2>");
    expect(html).toContain("<h2>bbb</h2>");
    expect(html).toContain("<h3>Free-plan limits</h3>");
    expect(html).toContain(
      '<tr class="spike"><td><code>d1.rows_written</code></td><td>90,000</td><td>100,000</td><td>90%</td><td>day</td></tr>',
    );
    expect(html).toContain("No usage counted against a free-plan limit yet.");
  });

  it("bad labels still render; single account with limits on keeps h2 headings", async () => {
    expect(await renderIndex(env({ ACCOUNT_LABELS_JSON: "{nope" }), NOW)).toContain("<h2>aaa</h2>");
    const html = renderPage({
      dates: ["2026-10-18"],
      table: new Map(),
      spikes: [],
      limits: [],
      lastCollected: null,
    });
    expect(html).toContain("<h2>Free-plan limits</h2>");
  });

  it("no CF_ACCOUNT_ID still renders an (empty) page", async () => {
    expect(await renderIndex(env({ CF_ACCOUNT_ID: undefined }), NOW)).toContain("No rows yet");
  });
});
