import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CATALOG, cycleOf, itemFor, platformOf } from "../src/catalog";
import type { Env } from "../src/env";
import {
  AI_QUERY,
  fetchAiRows,
  fetchStorage,
  STORAGE_QUERY,
  storageStatuses,
  toAiRows,
  toStorage,
} from "../src/extras";
import { buildLedger } from "../src/ledger";
import { FREE_PLAN_LIMITS, FREE_PLAN_STORAGE, formatLimitLine, toStatus } from "../src/limits";
import { runCollect } from "../src/run";
import { loadReadings } from "../src/store";
import { type PageData, renderConsumptionPage, renderLimitsPage } from "../src/views";
import { createFakeD1, rawDb } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T12:00:00Z");
const GB = 1e9;
const MB = 1e6;

describe("Workers AI neurons", () => {
  it("sums a day per model into usage rows; nothing or null gives nothing", () => {
    const rows = toAiRows("2026-10-18", {
      aiInferenceAdaptiveGroups: [
        { sum: { totalNeurons: 1000 }, dimensions: { modelId: "@cf/meta/llama" } },
        { sum: { totalNeurons: 250 }, dimensions: { modelId: "@cf/meta/llama" } },
        { sum: { totalNeurons: 40 }, dimensions: { modelId: "" } },
      ],
    });
    expect(rows).toEqual([
      { date: "2026-10-18", product: "ai", metric: "neurons", dim: "@cf/meta/llama", value: 1250 },
      { date: "2026-10-18", product: "ai", metric: "neurons", dim: "unknown", value: 40 },
    ]);
    expect(toAiRows("2026-10-18", null)).toEqual([]);
    expect(toAiRows("2026-10-18", {})).toEqual([]);
  });

  it("asks for the dataset the live schema has, with the date filter", async () => {
    const f = vi.fn(async () =>
      Response.json({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } } }),
    ) as unknown as typeof fetch;
    expect(await fetchAiRows("tok", "acct", "2026-10-18", f)).toEqual([]);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    const body = JSON.parse(String(init.body));
    expect(body.variables).toEqual({ account: "acct", date: "2026-10-18" });
    expect(body.query).toBe(AI_QUERY);
    expect(AI_QUERY).toContain("aiInferenceAdaptiveGroups");
    expect(AI_QUERY).toContain("sum { totalNeurons }");
    expect(FREE_PLAN_LIMITS["ai.neurons"]).toEqual({ limit: 10_000, period: "day" });
  });
});

describe("D1 and R2 storage", () => {
  const d1 = (databaseId: string, date: string, databaseSizeBytes: number) => ({
    max: { databaseSizeBytes },
    dimensions: { databaseId, date },
  });
  const r2 = (bucketName: string, date: string, payloadSize: number, storageClass?: string) => ({
    max: { payloadSize, metadataSize: 1000 },
    dimensions: { bucketName, date, ...(storageClass ? { storageClass } : {}) },
  });

  it("takes each database's and bucket's NEWEST size (a level, not a sum over days) and adds them up", () => {
    const t = toStorage({
      d1StorageAdaptiveGroups: [
        d1("a", "2026-10-17", 100 * MB),
        d1("a", "2026-10-18", 120 * MB), // newer wins even though it is listed second
        d1("b", "2026-10-18", 30 * MB),
        d1("b", "2026-10-17", 90 * MB),
      ],
      r2StorageAdaptiveGroups: [
        r2("covers", "2026-10-17", 500 * MB, "Standard"),
        r2("covers", "2026-10-18", 600 * MB, "Standard"),
        r2("digital", "2026-10-18", 2 * GB), // no storage class: counts as Standard
        r2("archive", "2026-10-18", 9 * GB, "InfrequentAccess"), // no free allowance: left out
      ],
    });
    expect(t).toEqual({
      d1TotalBytes: 150 * MB,
      d1LargestBytes: 120 * MB,
      d1Databases: 2,
      r2Bytes: 600 * MB + 1000 + 2 * GB + 1000,
      r2Buckets: 2,
    });
    expect(toStorage(null)).toEqual({
      d1TotalBytes: 0,
      d1LargestBytes: 0,
      d1Databases: 0,
      r2Bytes: 0,
      r2Buckets: 0,
    });
  });

  it("reports the account total, the biggest single database and R2, only for products the account uses", () => {
    const some = storageStatuses(
      {
        d1TotalBytes: 4.9 * GB,
        d1LargestBytes: 460 * MB,
        d1Databases: 3,
        r2Bytes: 1 * GB,
        r2Buckets: 2,
      },
      "2026-10-18",
      [50, 80, 95],
    );
    const by = Object.fromEntries(some.map((s) => [s.metric, s]));
    expect(by["d1.storage_bytes"]).toMatchObject({
      used: 4.9 * GB,
      limit: 5 * GB,
      period: "month",
      periodKey: "2026-10",
      level: 95,
    });
    expect(by["d1.db_max_bytes"]).toMatchObject({ limit: 500 * MB, level: 80 }); // 92%
    expect(by["r2.storage_bytes"]).toMatchObject({ limit: 10 * GB, level: null }); // 10%
    expect(FREE_PLAN_STORAGE).toEqual({
      "d1.storage_bytes": 5e9,
      "d1.db_max_bytes": 500e6,
      "r2.storage_bytes": 10e9,
    });

    expect(
      storageStatuses(
        { d1TotalBytes: 0, d1LargestBytes: 0, d1Databases: 0, r2Bytes: 5, r2Buckets: 1 },
        "2026-10-18",
        [],
      ),
    ).toMatchObject([{ metric: "r2.storage_bytes", level: null }]);
    expect(
      storageStatuses(
        { d1TotalBytes: 0, d1LargestBytes: 0, d1Databases: 0, r2Bytes: 0, r2Buckets: 0 },
        "2026-10-18",
        [80],
      ),
    ).toEqual([]);
  });

  it("queries yesterday through today on the dataset names the live schema has", async () => {
    const f = vi.fn(async () =>
      Response.json({
        data: {
          viewer: {
            accounts: [
              {
                d1StorageAdaptiveGroups: [d1("a", "2026-10-18", 1 * MB)],
                r2StorageAdaptiveGroups: [],
              },
            ],
          },
        },
      }),
    ) as unknown as typeof fetch;
    const t = await fetchStorage("tok", "acct", "2026-10-18", f);
    expect(t.d1TotalBytes).toBe(1 * MB);
    const body = JSON.parse(
      String(
        ((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body,
      ),
    );
    expect(body.variables).toEqual({ account: "acct", from: "2026-10-17", to: "2026-10-18" });
    expect(body.query).toBe(STORAGE_QUERY);
    for (const part of [
      "d1StorageAdaptiveGroups",
      "databaseSizeBytes",
      "r2StorageAdaptiveGroups",
      "payloadSize",
      "metadataSize",
      "date_geq",
    ])
      expect(STORAGE_QUERY).toContain(part);
  });

  it("alert lines say sizes in GB / MB, and only a quota (transfer) says 'per month'", () => {
    const line = (metric: string, used: number, limit: number) =>
      formatLimitLine(toStatus(metric, used, limit, "month", "2026-10-18", [80, 95]));
    expect(line("d1.storage_bytes", 4.8 * GB, 5 * GB)).toBe(
      "• d1.storage_bytes: 4.80 GB of 5.00 GB (96%) — past 95% of the free-plan limit",
    );
    expect(line("d1.db_max_bytes", 450 * MB, 500 * MB)).toBe(
      "• d1.db_max_bytes: 450.0 MB of 500.0 MB (90%) — past 80% of the free-plan limit",
    );
    expect(line("x.small_bytes", 900_000, 1_000_000)).toContain("900 KB of 1.0 MB");
    expect(line("github.packages_transfer_bytes", 0.9 * GB, 1 * GB)).toContain("per month");
    expect(
      formatLimitLine(toStatus("github.actions_minutes", 1900, 2000, "month", "2026-10", [95])),
    ).toContain("1,900 of 2,000 per month");
  });
});

/** A stand-in for Cloudflare's GraphQL: answers each of the three queries from its text. */
function cloudflare(over: { ai?: () => Response; storage?: () => Response } = {}) {
  const queries: string[] = [];
  const f = vi.fn(async (_url: string, init: RequestInit = {}) => {
    const q = String(JSON.parse(String(init.body)).query);
    queries.push(q);
    if (q.includes("aiInferenceAdaptiveGroups"))
      return (
        over.ai?.() ??
        Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  aiInferenceAdaptiveGroups: [
                    { sum: { totalNeurons: 6200 }, dimensions: { modelId: "m" } },
                  ],
                },
              ],
            },
          },
        })
      );
    if (q.includes("d1StorageAdaptiveGroups"))
      return (
        over.storage?.() ??
        Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  d1StorageAdaptiveGroups: [
                    {
                      max: { databaseSizeBytes: 460 * MB },
                      dimensions: { databaseId: "a", date: "2026-10-18" },
                    },
                    {
                      max: { databaseSizeBytes: 100 * MB },
                      dimensions: { databaseId: "b", date: "2026-10-18" },
                    },
                  ],
                  r2StorageAdaptiveGroups: [
                    {
                      max: { payloadSize: 3 * GB, metadataSize: 0 },
                      dimensions: { bucketName: "c", storageClass: "Standard", date: "2026-10-18" },
                    },
                  ],
                },
              ],
            },
          },
        })
      );
    return Response.json({
      data: {
        viewer: {
          accounts: [
            {
              workersInvocationsAdaptive: [
                {
                  sum: { requests: 10, errors: 0, cpuTimeUs: 1000 },
                  dimensions: { scriptName: "w" },
                },
              ],
            },
          ],
        },
      },
    });
  });
  return { f: f as unknown as typeof fetch, queries };
}

const env = (over: Partial<Env> = {}): Env => ({
  USAGE: createFakeD1(),
  CF_API_TOKEN: "tok",
  CF_ACCOUNT_ID: "acct",
  LIMIT_LEVELS: "50,80,95",
  TELEGRAM_BOT_TOKEN: "bot",
  TELEGRAM_CHAT_ID: "-1",
  ...over,
});

describe("the collect run reads them", () => {
  it("stores Neurons with the daily usage, keeps the storage levels as readings, and the ledger shows both", async () => {
    const e = env();
    const c = cloudflare();
    const s = await runCollect(e, NOW, c.f);
    expect(s.error).toBeUndefined();
    // Neurons for yesterday and today, next to the request counters.
    const ai = rawDb(e.USAGE)
      .prepare("SELECT date, metric, value FROM usage_daily WHERE product = 'ai'")
      .all() as Array<{ date: string; metric: string; value: number }>;
    expect(ai).toEqual([
      { date: "2026-10-17", metric: "neurons", value: 6200 },
      { date: "2026-10-18", metric: "neurons", value: 6200 },
    ]);
    const stored = (await loadReadings(e.USAGE)).filter((r) => r.target === "cloudflare:");
    expect(stored.map((r) => [r.metric, r.used])).toEqual([
      ["d1.db_max_bytes", 460 * MB],
      ["d1.storage_bytes", 560 * MB],
      ["r2.storage_bytes", 3 * GB],
    ]);
    // The site: Workers AI as a daily meter, the three storage levels as sizes that never reset.
    const { data } = await buildLedger(e, NOW);
    const cf = data.providers.find((p) => p.platform === "cloudflare");
    const meter = (k: string) => cf?.metrics.find((m) => m.key === k);
    expect(meter("ai.neurons")).toMatchObject({
      label: "Workers AI neurons",
      used: 6200,
      limit: 10_000,
      unit: "count",
      resets: true,
    });
    expect(meter("d1.db_max_bytes")).toMatchObject({
      label: "D1 largest database",
      used: 460 * MB,
      limit: 500 * MB,
      unit: "bytes",
      resets: false,
    });
    expect(meter("d1.storage_bytes")).toMatchObject({
      label: "D1 storage (all databases)",
      resets: false,
    });
    expect(meter("r2.storage_bytes")).toMatchObject({
      label: "R2 storage (Standard)",
      used: 3 * GB,
      limit: 10 * GB,
    });
    // The catalog ties each to its allowance row, so the Limits tab shows it as tracked.
    for (const k of ["ai.neurons", "d1.storage_bytes", "d1.db_max_bytes", "r2.storage_bytes"])
      expect(itemFor("cloudflare", k), k).toBeDefined();
  });

  it("a storage level past an alert threshold is announced once, in plain units", async () => {
    const e = env();
    const sent: string[] = [];
    const base = cloudflare();
    const f = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("telegram")) {
        sent.push(JSON.parse(String(init.body)).text);
        return new Response("{}");
      }
      return base.f(url, init);
    }) as unknown as typeof fetch;
    await runCollect(e, NOW, f);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("d1.db_max_bytes: 460.0 MB of 500.0 MB (92%)"); // 92% of the 500 MB per-database cap
    await runCollect(e, new Date(NOW.getTime() + 3_600_000), f);
    expect(sent).toHaveLength(1); // same level, same month: not again
  });

  it("a problem with one extra never stops the request counters or the other extra; it is reported by name", async () => {
    const e = env();
    const c = cloudflare({ ai: () => Response.json({ errors: [{ message: "unknown field" }] }) });
    const s = await runCollect(e, NOW, c.f);
    expect(s.error).toBe("Workers AI usage: graphql: unknown field");
    expect(s.written).toBe(2 * 3); // the request counters were still written (2 days × 3 rows: requests, errors, cpu_ms)
    expect((await loadReadings(e.USAGE)).filter((r) => r.target === "cloudflare:")).toHaveLength(3); // storage unaffected

    const e2 = env();
    const s2 = await runCollect(
      e2,
      NOW,
      cloudflare({ storage: () => new Response("", { status: 502 }) }).f,
    );
    expect(s2.error).toBe("D1 / R2 storage: graphql: 502");
    expect(
      rawDb(e2.USAGE).prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE product = 'ai'").get(),
    ).toEqual({ n: 2 }); // Neurons unaffected
  });

  it("an invalid LIMIT_LEVELS is reported once by the limit check, not again by the storage reading, which is still saved", async () => {
    const e = env({ LIMIT_LEVELS: "abc" });
    const s = await runCollect(e, NOW, cloudflare().f);
    expect(s.error?.split("; ")).toHaveLength(1);
    expect(s.error).toContain("LIMIT_LEVELS");
    expect((await loadReadings(e.USAGE)).filter((r) => r.target === "cloudflare:").length).toBe(3);
  });

  it("a second account keeps its own storage under its own key", async () => {
    const e = env({ CF_ACCOUNT_ID: "aaa,bbb" });
    await runCollect(e, NOW, cloudflare().f);
    const targets = [...new Set((await loadReadings(e.USAGE)).map((r) => r.target))].sort();
    expect(targets).toEqual(["cloudflare:aaa", "cloudflare:bbb"]);
  });
});

describe("the other free-tier services", () => {
  it("Umami, Gemini, Groq and Cerebras are in the catalog with sourced allowances, each saying why usage is not measured", () => {
    for (const id of ["umami", "gemini", "groq", "cerebras"] as const) {
      const cat = CATALOG.find((c) => c.id === id);
      expect(cat, id).toBeDefined();
      expect(cat?.unmeasured, id).toBeTruthy();
      expect(cat?.sources.length, id).toBeGreaterThan(0);
      expect(cat?.verified, id).toContain("2026");
      expect(cat?.items.length, id).toBeGreaterThan(2);
      // Nothing is measured on them, so no allowance claims a meter.
      expect(
        cat?.items.every((i) => i.match === undefined),
        id,
      ).toBe(true);
      expect(platformOf(id)).toBe(id);
    }
    const umami = CATALOG.find((c) => c.id === "umami");
    expect(umami?.items.find((i) => i.label === "Events")?.allowance).toBe("100,000 / month");
    expect(umami?.items.find((i) => i.label === "API access")?.allowance).toContain("Not on Hobby");
    expect(
      CATALOG.find((c) => c.id === "cerebras")?.items.find((i) =>
        i.label.startsWith("Tokens per day"),
      )?.allowance,
    ).toContain("1,000,000");
  });

  it("an allowance that resets daily or monthly but not on a UTC edge has no computed date (and says so)", () => {
    expect(cycleOf({ frequency: "Daily", resets: "midnight Pacific time" })).toBe("billing");
    expect(cycleOf({ frequency: "Monthly", resets: "your billing period" })).toBe("billing");
    expect(cycleOf({ frequency: "Daily", resets: "00:00 UTC" })).toBe("utc-day");
  });

  const page = async (platforms: string[]): Promise<PageData> => {
    const e = env();
    const ledger = await buildLedger(e, NOW);
    ledger.data.clients = [
      {
        id: "unbp",
        name: "UNBP",
        email: "o@unbp.in",
        status: "live",
        platforms,
        accounts: [],
        monitors: [],
        domains: [],
      },
    ];
    return {
      ledger,
      health: { uptime: null, now: NOW, domains: [] },
      runs: [],
      alerts: [],
      tz: "Asia/Kolkata",
    };
  };

  it("Consumption lists them for a project that uses them: not measurable, with the reason and the allowances", async () => {
    const html = renderConsumptionPage(
      await page(["umami", "gemini", "groq", "cerebras"]),
      "o@unbp.in",
    );
    for (const name of ["Umami Cloud", "Google Gemini API", "Groq", "Cerebras Inference"])
      expect(html).toContain(name);
    expect(html).toContain("Not measurable");
    expect(html).toContain("has no API (API access starts at Pro)");
    expect(html).toContain("Settings → Usage");
    expect(html).toContain("100,000 / month");
    expect(html).not.toContain("Paste it on the"); // it is not a token you can add
    expect(html).not.toContain("add a <code>usage:</code> block");
  });

  it("the Limits tab lists them beside the measured platforms", async () => {
    const html = renderLimitsPage(await page([]));
    for (const name of ["Umami Cloud", "Google Gemini API", "Groq", "Cerebras Inference"])
      expect(html).toContain(name);
    expect(html).toContain("Workers AI neurons");
  });

  it("the daily terms watch covers each of them", () => {
    const urls = readFileSync(new URL("../../watch/urls.yaml", import.meta.url), "utf8");
    for (const u of [
      "https://umami.is/pricing",
      "https://raw.githubusercontent.com/umami-software/docs/master/content/docs/cloud/index.mdx",
      "https://ai.google.dev/gemini-api/docs/rate-limits",
      "https://console.groq.com/docs/rate-limits",
      "https://inference-docs.cerebras.ai/support/rate-limits",
    ])
      expect(urls, u).toContain(`url: "${u}"`);
  });
});
