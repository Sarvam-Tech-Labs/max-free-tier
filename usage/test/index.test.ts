import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { GRAPHQL_ENDPOINT, type UsageAccount } from "../src/graphql";
import worker from "../src/index";
import { addDays, isoDate, renderIndex, runCollect } from "../src/run";
import { upsertRows } from "../src/store";
import { createFakeD1, rawDb } from "./helpers/fake-d1";
import { SAMPLE_ACCOUNT } from "./helpers/fixtures";

const NOW = new Date("2026-09-14T13:00:00Z");

function env(over: Partial<Env> = {}): Env {
  return { USAGE: createFakeD1(), CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc", ...over };
}

/** GraphQL stub: same account for every date; webhooks 204. Records calls. */
function stubUpstream(account: UsageAccount | null = SAMPLE_ACCOUNT) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (url === GRAPHQL_ENDPOINT) {
      return Response.json({ data: { viewer: { accounts: account ? [account] : [] } } });
    }
    return new Response(null, { status: 204 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

/** GraphQL stub returning one D1 database whose rowsRead depends on the requested date. */
function stubByDate(
  byDate: Record<string, number>,
  fallback: number,
  webhookStatus = 204,
): typeof fetch {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url !== GRAPHQL_ENDPOINT) return new Response(null, { status: webhookStatus });
    const date = (JSON.parse(String(init.body)) as { variables: { date: string } }).variables.date;
    const rowsRead = byDate[date] ?? fallback;
    const g = {
      sum: { rowsRead, rowsWritten: 0, readQueries: 0, writeQueries: 0 },
      dimensions: { databaseId: "x" },
    };
    return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [g] }] } } });
  }) as unknown as typeof fetch;
}

describe("date helpers", () => {
  it("isoDate / addDays are UTC and cross month boundaries", () => {
    expect(isoDate(NOW)).toBe("2026-09-14");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("runCollect", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("missing secrets → error summary, no fetch", async () => {
    const { f } = stubUpstream();
    const s = await runCollect(env({ CF_API_TOKEN: undefined }), NOW, f);
    expect(s).toEqual({
      date: "2026-09-14",
      written: 0,
      spikes: 0,
      notified: 0,
      error: expect.stringContaining("CF_API_TOKEN"),
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("collects yesterday + today, writes rows, no spike without history", async () => {
    const e = env();
    const { f, calls } = stubUpstream();
    const s = await runCollect(e, NOW, f);
    expect(calls.map((c) => (c.body as { variables: { date: string } }).variables.date)).toEqual([
      "2026-09-13",
      "2026-09-14",
    ]);
    expect(s).toEqual({ date: "2026-09-14", written: 18 * 2, spikes: 0, notified: 0 });
    const n = rawDb(e.USAGE).prepare("SELECT COUNT(*) AS n FROM usage_daily").get() as {
      n: number;
    };
    expect(n.n).toBe(36);
  });

  it("empty upstream → written 0, no error", async () => {
    const { f } = stubUpstream(null);
    const s = await runCollect(env(), NOW, f);
    expect(s).toEqual({ date: "2026-09-14", written: 0, spikes: 0, notified: 0 });
  });

  it("upstream 5xx → error summary, nothing written", async () => {
    const e = env();
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 502 }));
    const s = await runCollect(e, NOW);
    expect(s.error).toBe("graphql: 502");
    expect(s.written).toBe(0);
  });

  it("spike with webhook: notifies once, marks, and does not repeat on the next run", async () => {
    const e = env({
      DISCORD_WEBHOOK_URL: "https://d.example/hook",
      THRESHOLDS_JSON: '{"d1.rows_read": 1000}',
    });
    // 7 days of baseline: 100 rows_read/day
    const hist = [];
    for (let i = 1; i <= 7; i++) {
      hist.push({
        date: addDays("2026-09-14", -i),
        product: "d1" as const,
        metric: "rows_read",
        dim: "db-1",
        value: 100,
      });
    }
    await upsertRows(e.USAGE, hist, "seed");
    const { f, calls } = stubUpstream(); // SAMPLE_ACCOUNT has rows_read 50_000 → 500×

    const s1 = await runCollect(e, NOW, f);
    expect(s1.spikes).toBe(1);
    expect(s1.notified).toBe(1);
    const hook = calls.filter((c) => c.url === "https://d.example/hook");
    expect(hook).toHaveLength(1);
    expect((hook[0] as { body: { content: string } }).body.content).toContain(
      "d1.rows_read: 50,000 today",
    );

    const s2 = await runCollect(e, new Date("2026-09-14T19:00:00Z"), f);
    expect(s2.spikes).toBe(1);
    expect(s2.notified).toBe(0);
    expect(calls.filter((c) => c.url === "https://d.example/hook")).toHaveLength(1);
  });

  it("spike without webhook: reported in summary, nothing marked (a webhook added later still fires)", async () => {
    const e = env({ THRESHOLDS_JSON: '{"d1.rows_read": 1000}' });
    const f = stubByDate({ "2026-09-14": 9_000_000 }, 1);
    const s = await runCollect(e, NOW, f);
    expect(s).toEqual({ date: "2026-09-14", written: 8, spikes: 1, notified: 0 });
    const n = rawDb(e.USAGE).prepare("SELECT COUNT(*) AS n FROM spike_notified").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it("failed webhook → not marked, so the next run retries", async () => {
    const e = env({
      SLACK_WEBHOOK_URL: "https://s.example/hook",
      THRESHOLDS_JSON: '{"d1.rows_read": 1000}',
    });
    const f = stubByDate({ "2026-09-14": 9_000_000 }, 1, 500);
    const s = await runCollect(e, NOW, f);
    expect(s.spikes).toBe(1);
    expect(s.notified).toBe(0);
    const n = rawDb(e.USAGE).prepare("SELECT COUNT(*) AS n FROM spike_notified").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it("bad THRESHOLDS_JSON → error summary (rows still written)", async () => {
    const e = env({ THRESHOLDS_JSON: "{nope" });
    const { f } = stubUpstream();
    const s = await runCollect(e, NOW, f);
    expect(s.written).toBe(36);
    expect(s.error).toBeTruthy();
  });

  it("non-Error throw is stringified", async () => {
    const e = env();
    const f = vi.fn(async () => {
      throw "raw";
    }) as unknown as typeof fetch;
    expect((await runCollect(e, NOW, f)).error).toBe("raw");
  });
});

describe("renderIndex / fetch handler", () => {
  afterEach(() => vi.useRealTimers());
  it("empty DB renders the hint and 7 date columns", async () => {
    const html = await renderIndex(env(), NOW);
    expect(html).toContain("No rows yet");
    expect(html).toContain("<th>09-08</th>");
    expect(html).toContain("<th>09-14</th>");
    expect(html).not.toContain("<th>09-07</th>");
  });

  const PASSWORD = "correct horse";
  const basic = (pw: string) => ({ Authorization: `Basic ${btoa(`anyone:${pw}`)}` });
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
  const assets = {
    fetch: vi.fn(
      async (r: Request) => new Response(`<html>overview ${new URL(r.url).pathname}</html>`),
    ),
  } as unknown as Fetcher;

  it("without DASHBOARD_PASSWORD every path is 404, even with credentials", async () => {
    const e = env({ ASSETS: assets });
    for (const path of ["/", "/data.js", "/classic"]) {
      expect((await worker.fetch(new Request(`https://x.test${path}`), e, ctx)).status).toBe(404);
      const withAuth = new Request(`https://x.test${path}`, { headers: basic("") });
      expect((await worker.fetch(withAuth, e, ctx)).status).toBe(404);
    }
  });

  it("with it: no or wrong credentials → 401 + challenge; POST → 404", async () => {
    const e = env({ DASHBOARD_PASSWORD: PASSWORD, ASSETS: assets });
    const bad = [
      {},
      basic("wrong"),
      { Authorization: "Basic !!!not-base64" },
      { Authorization: "Bearer x" },
    ];
    for (const headers of bad) {
      const res = await worker.fetch(new Request("https://x.test/", { headers }), e, ctx);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    }
    const post = new Request("https://x.test/", { method: "POST", headers: basic(PASSWORD) });
    expect((await worker.fetch(post, e, ctx)).status).toBe(404);
  });

  it("with the right password: / serves the overview, /data.js + /series.js the readings, /classic the table", async () => {
    // The handler uses the real clock; pin it so the 7-day window still covers the fixture row.
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const e = env({ DASHBOARD_PASSWORD: PASSWORD, ASSETS: assets, ORG_NAME: "Acme Agency" });
    await upsertRows(
      e.USAGE,
      [{ date: "2026-09-14", product: "kv", metric: "read", dim: "ns", value: 12 }],
      "2026-09-14T01:00:00Z",
    );
    const get = (path: string) =>
      worker.fetch(new Request(`https://x.test${path}`, { headers: basic(PASSWORD) }), e, ctx);

    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("Content-Type")).toContain("text/html");
    expect(home.headers.get("Cache-Control")).toBe("no-store");
    expect(await home.text()).toContain("overview /index.html");

    const data = await get("/data.js");
    expect(data.headers.get("Content-Type")).toContain("javascript");
    expect(data.headers.get("Cache-Control")).toBe("no-store");
    const body = await data.text();
    expect(body.startsWith("window.FTM_DATA = ")).toBe(true);
    expect(body).toContain("Acme Agency");
    expect(body).toContain("Workers requests");

    const series = await (await get("/series.js")).text();
    expect(series).toContain("window.FTM_SERIES = ");
    expect(series).toContain("kv.read");

    const classic = await get("/classic");
    expect(classic.status).toBe(200);
    const html = await classic.text();
    expect(html).toContain("<code>kv.read</code>");
    expect(html).toContain("Last collected 2026-09-14T01:00:00Z");

    const clients = await get("/clients?q=zzz");
    expect(clients.status).toBe(200);
    expect(clients.headers.get("Cache-Control")).toBe("no-store");
    expect(await clients.text()).toContain("No client matches “zzz”");
    const platforms = await get("/platforms");
    expect(platforms.status).toBe(200);
    expect(await platforms.text()).toContain("Free-tier limits by platform");
    for (const path of ["/clients", "/platforms"]) {
      const anon = await worker.fetch(new Request(`https://x.test${path}`), e, ctx);
      expect(anon.status).toBe(401); // the new pages are behind the same password
    }

    expect((await get("/other")).status).toBe(404);
    // No ASSETS binding → the overview page cannot be served.
    const noAssets = env({ DASHBOARD_PASSWORD: PASSWORD });
    const res = await worker.fetch(
      new Request("https://x.test/", { headers: basic(PASSWORD) }),
      noAssets,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("scheduled() runs the collect via waitUntil and logs a summary without the token", async () => {
    const e = env({ CF_API_TOKEN: "SECRET-TOKEN" });
    vi.stubGlobal("fetch", async () => Response.json({ data: { viewer: { accounts: [] } } }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let pending: Promise<unknown> | undefined;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    await worker.scheduled(
      { scheduledTime: NOW.getTime(), cron: "0 */6 * * *", noRetry() {} } as ScheduledController,
      e,
      ctx,
    );
    await pending;
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('"event":"collect"');
    expect(line).not.toContain("SECRET-TOKEN");
    log.mockRestore();
    vi.unstubAllGlobals();
  });
});
