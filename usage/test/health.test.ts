import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  DOMAIN_REFRESH_MS,
  daysUntil,
  domainsOf,
  loadDomains,
  readUptime,
  refreshDomains,
  type UptimeView,
} from "../src/health";
import worker from "../src/index";
import { handleIngest } from "../src/ingest";
import { runCollect, runProviders } from "../src/run";
import { loadRuns, logAlert, recentAlerts } from "../src/store";
import { createFakeD1 } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T11:00:00Z");
const unix = (iso: string) => Date.parse(iso) / 1000;

const VIEW: UptimeView = {
  lastUpdate: unix("2026-10-18T10:59:00Z"),
  monitors: {
    acme_site: {
      status: "up",
      incidents: [
        {
          start: [unix("2026-10-10T08:00:00Z")],
          end: unix("2026-10-10T08:12:00Z"),
          error: ["HTTP 502"],
        },
      ],
      latest: { loc: "SIN", ping: 123.4, time: unix("2026-10-18T10:59:00Z") },
    },
    acme_api: {
      status: "down",
      incidents: [{ start: [unix("2026-10-18T10:40:00Z")], error: ["Keyword missing"] }],
    },
    beta_site: {
      status: "degraded",
      warning: "Domain expires on 2026-11-01 (14 days remaining)",
      incidents: [],
    },
    watchdog: { status: "up", incidents: [] },
  },
};

const monitorWorker = (body: unknown, status = 200) =>
  ({
    fetch: vi.fn(async () => new Response(JSON.stringify(body), { status })),
  }) as unknown as Fetcher;

describe("readUptime", () => {
  it("reads FlareWatch's /view over the binding; null when unbound, failing or malformed", async () => {
    const mw = monitorWorker(VIEW);
    expect(await readUptime({ MONITOR_WORKER: mw })).toEqual(VIEW);
    expect((mw.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "https://internal/view",
    );
    expect(await readUptime({})).toBeNull();
    expect(await readUptime({ MONITOR_WORKER: monitorWorker(VIEW, 500) })).toBeNull();
    expect(await readUptime({ MONITOR_WORKER: monitorWorker({ nope: 1 }) })).toBeNull();
    const throwing = {
      fetch: async () => {
        throw new Error("no such service");
      },
    } as unknown as Fetcher;
    expect(await readUptime({ MONITOR_WORKER: throwing })).toBeNull();
  });
});

describe("domains", () => {
  it("domainsOf collects live clients' domains and tolerates junk", () => {
    expect(
      domainsOf(JSON.stringify([{ domains: ["a.in", 3] }, { domains: ["b.com"] }, {}])),
    ).toEqual(["a.in", "b.com"]);
    expect(domainsOf(undefined)).toEqual([]);
    expect(domainsOf("nope")).toEqual([]);
    expect(domainsOf("{}")).toEqual([]);
  });

  /** IANA bootstrap + one registry per TLD: .in answers with dates, .zz is not in the list, .org only offers http. */
  function registry() {
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "https://data.iana.org/rdap/dns.json") {
        return Response.json({
          services: [
            [["in"], ["https://rdap.registry.in/"]],
            [["org"], ["http://insecure.example/"]],
          ],
        });
      }
      if (url.endsWith("/domain/good.in")) {
        return Response.json({
          events: [
            { eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" },
            { eventAction: "expiration", eventDate: "2027-01-09T13:50:49Z" },
          ],
        });
      }
      if (url.endsWith("/domain/bare.in")) return Response.json({ events: [] });
      return new Response("", { status: 404 });
    });
    return { f: f as unknown as typeof fetch, calls };
  }

  it("refreshDomains asks the registry IANA names (never rdap.org, which refuses Cloudflare), one bootstrap per batch", async () => {
    const db = createFakeD1();
    const r = registry();
    const errors = await refreshDomains(
      db,
      ["good.in", "bare.in", "gone.in", "GOOD.in", "x.zz", "x.org"],
      NOW,
      r.f,
    );
    expect(errors).toEqual([
      "bare.in: no expiration date in the RDAP record",
      "gone.in: RDAP HTTP 404",
      "x.zz: no RDAP service for .zz",
      "x.org: no RDAP service for .org",
    ]);
    expect(r.calls.filter((u) => u.includes("data.iana.org"))).toHaveLength(1);
    expect(r.calls.some((u) => u.includes("rdap.org"))).toBe(false);
    expect(r.calls).toContain("https://rdap.registry.in/domain/good.in");
    expect(r.calls.filter((u) => u.endsWith("/domain/good.in"))).toHaveLength(1); // duplicates (any case) once
    const rows = await loadDomains(db);
    expect(rows.find((x) => x.domain === "good.in")).toMatchObject({
      expires: "2027-01-09T13:50:49.000Z",
      error: null,
    });
    expect(rows.find((x) => x.domain === "gone.in")).toMatchObject({
      expires: null,
      error: "RDAP HTTP 404",
    });
  });

  it("a successful lookup is kept for a day; a failed one is retried on the next run", async () => {
    const db = createFakeD1();
    await refreshDomains(db, ["good.in", "gone.in"], NOW, registry().f);
    const later = registry();
    const hour = new Date(NOW.getTime() + 3_600_000);
    await refreshDomains(db, ["good.in", "gone.in"], hour, later.f);
    expect(later.calls.filter((u) => u.includes("/domain/"))).toEqual([
      "https://rdap.registry.in/domain/gone.in",
    ]);
    const nothing = registry();
    expect(await refreshDomains(db, ["good.in"], hour, nothing.f)).toEqual([]);
    expect(nothing.calls).toEqual([]); // no bootstrap either when nothing is due
  });

  it("a registry or bootstrap outage is reported, and a known date survives it", async () => {
    const db = createFakeD1();
    await refreshDomains(db, ["good.in"], NOW, registry().f);
    const down = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const errors = await refreshDomains(
      db,
      ["good.in"],
      new Date(NOW.getTime() + DOMAIN_REFRESH_MS),
      down,
    );
    expect(errors).toEqual(["good.in: RDAP bootstrap HTTP 503"]);
    expect((await loadDomains(db)).find((x) => x.domain === "good.in")).toMatchObject({
      expires: "2027-01-09T13:50:49.000Z", // still known
      error: "RDAP bootstrap HTTP 503",
    });
    const garbled = vi.fn(async () => Response.json({ nope: 1 })) as unknown as typeof fetch;
    expect(await refreshDomains(createFakeD1(), ["good.in"], NOW, garbled)).toEqual([
      "good.in: RDAP bootstrap list was unreadable",
    ]);
    expect(await refreshDomains(db, [], NOW, down)).toEqual([]);
  });

  it("daysUntil counts whole days, negative once past", () => {
    expect(daysUntil("2026-10-28T11:00:00Z", NOW)).toBe(10);
    expect(daysUntil("2026-10-17T11:00:00Z", NOW)).toBe(-1);
  });
});

describe("ingest", () => {
  const env = (over: Partial<Env> = {}): Env => ({
    USAGE: createFakeD1(),
    INGEST_TOKEN: "tok-123",
    ...over,
  });
  const post = (body: unknown, token = "tok-123") =>
    new Request("https://x.test/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("records a clean run without an alert, and a changed run with one", async () => {
    const e = env();
    expect((await handleIngest(post({ check: "terms", ok: true, text: "" }), e, NOW)).status).toBe(
      204,
    );
    expect(await recentAlerts(e.USAGE)).toEqual([]);
    expect((await loadRuns(e.USAGE))[0]).toMatchObject({
      name: "terms",
      ok: true,
      summary: "no changes",
    });

    const later = new Date(NOW.getTime() + 86_400_000);
    expect(
      (
        await handleIngest(
          post({
            check: "terms",
            ok: false,
            text: "\n\nVercel · limits changed\n- 100 GB\n+ 50 GB",
          }),
          e,
          later,
        )
      ).status,
    ).toBe(204);
    expect((await loadRuns(e.USAGE))[0]).toMatchObject({
      ok: false,
      summary: "Vercel · limits changed",
    });
    expect((await recentAlerts(e.USAGE))[0]).toMatchObject({
      source: "terms",
      text: "Vercel · limits changed\n- 100 GB\n+ 50 GB",
    });
    expect((await handleIngest(post({ check: "drift", ok: false }), e, later)).status).toBe(204);
    expect((await recentAlerts(e.USAGE))[0]?.text).toContain("no details sent");
  });

  it("rejects: no token configured (404), wrong token (401), bad body (400)", async () => {
    expect(
      (await handleIngest(post({ check: "terms", ok: true }), env({ INGEST_TOKEN: undefined })))
        .status,
    ).toBe(404);
    expect((await handleIngest(post({ check: "terms", ok: true }, "wrong"), env())).status).toBe(
      401,
    );
    const noAuth = new Request("https://x.test/ingest", { method: "POST", body: "{}" });
    expect((await handleIngest(noAuth, env())).status).toBe(401);
    for (const bad of [
      "not json",
      { check: "other", ok: true },
      { check: "terms", ok: "yes" },
      { check: "drift", ok: false, text: 5 },
    ]) {
      expect((await handleIngest(post(bad), env())).status).toBe(400);
    }
  });

  it("is reachable through the Worker without the site password, and only by POST", async () => {
    const e = env({ DASHBOARD_PASSWORD: "site-pw" });
    const ctx = {} as ExecutionContext;
    expect((await worker.fetch(post({ check: "drift", ok: true }), e, ctx)).status).toBe(204);
    expect((await worker.fetch(new Request("https://x.test/ingest"), e, ctx)).status).toBe(401); // GET is a site page → login
  });
});

describe("runs and alerts are recorded for the Activity page", () => {
  it("collect: records the run; a limit alert is logged with its delivery outcome", async () => {
    const e: Env = { USAGE: createFakeD1() };
    await runCollect(e, NOW, vi.fn() as unknown as typeof fetch);
    expect((await loadRuns(e.USAGE))[0]).toMatchObject({
      name: "collect",
      ok: false,
      summary: "CF_API_TOKEN / CF_ACCOUNT_ID not set",
    });
  });

  it("providers: a crossed level is sent, logged, and the run recorded", async () => {
    const e: Env = {
      USAGE: createFakeD1(),
      PROVIDERS_JSON: JSON.stringify([
        { id: "acme", client: "Acme", kind: "github", token: "GH", account: "acme" },
      ]),
      PROVIDER_TOKENS: '{"GH":"x"}',
    };
    const f = vi.fn(async () =>
      Response.json({
        usageItems: [{ product: "actions", unitType: "minutes", grossQuantity: 1900 }],
      }),
    ) as unknown as typeof fetch;
    await runProviders(e, NOW, f);
    const [alert] = await recentAlerts(e.USAGE);
    expect(alert?.source).toBe("providers");
    expect(alert?.text).toContain("github.actions_minutes");
    expect(alert?.text).toContain("(no alert channel configured)");
    expect((await loadRuns(e.USAGE))[0]).toMatchObject({
      name: "providers",
      ok: true,
      summary: "1 limit level(s) crossed",
    });
  });

  it("logAlert drops entries older than 90 days", async () => {
    const db = createFakeD1();
    await logAlert(db, "usage", "old", "2026-06-01T00:00:00Z");
    await logAlert(db, "usage", "new", NOW.toISOString());
    expect((await recentAlerts(db)).map((a) => a.text)).toEqual(["new"]);
  });
});
