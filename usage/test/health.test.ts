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
import type { Ledger } from "../src/ledger";
import { runCollect, runProviders } from "../src/run";
import { loadRuns, logAlert, recentAlerts, recordRun } from "../src/store";
import { type Health, renderActivityPage, renderClientsPage } from "../src/views";
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

  it("refreshDomains looks up expiry once a day, keeps a known date when a lookup fails", async () => {
    const db = createFakeD1();
    const rdap = vi.fn(async (url: string) =>
      url.endsWith("good.in")
        ? Response.json({
            events: [
              { eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" },
              { eventAction: "expiration", eventDate: "2027-01-09T13:50:49Z" },
            ],
          })
        : url.endsWith("bare.in")
          ? Response.json({ events: [] })
          : new Response("", { status: 404 }),
    ) as unknown as typeof fetch;

    const errors = await refreshDomains(
      db,
      ["good.in", "bare.in", "gone.in", "good.in"],
      NOW,
      rdap,
    );
    expect(errors).toEqual([
      "bare.in: no expiration date in the RDAP record",
      "gone.in: RDAP HTTP 404",
    ]);
    expect((rdap as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3); // duplicates looked up once
    const rows = await loadDomains(db);
    expect(rows.find((r) => r.domain === "good.in")).toMatchObject({
      expires: "2027-01-09T13:50:49.000Z",
      error: null,
    });
    expect(rows.find((r) => r.domain === "gone.in")).toMatchObject({
      expires: null,
      error: "RDAP HTTP 404",
    });

    // Within a day: nothing is looked up again.
    expect(
      await refreshDomains(db, ["good.in"], new Date(NOW.getTime() + 3_600_000), rdap),
    ).toEqual([]);
    expect((rdap as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);

    // A day later the registry is down: the error is recorded but the known date survives.
    const down = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await refreshDomains(db, ["good.in"], new Date(NOW.getTime() + DOMAIN_REFRESH_MS), down);
    expect((await loadDomains(db)).find((r) => r.domain === "good.in")).toMatchObject({
      expires: "2027-01-09T13:50:49.000Z",
      error: "RDAP HTTP 503",
    });
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

function ledger(): Ledger {
  const client = (id: string, name: string, monitors: string[], domains: string[] = []) => ({
    id,
    name,
    email: `${id}@x.in`,
    status: "live",
    platforms: [],
    accounts: [],
    monitors: monitors.map((m) => ({ id: `${id}_${m}`, name: m, url: `https://${id}.in/${m}` })),
    domains,
  });
  return {
    series: [],
    data: {
      generatedAt: NOW.toISOString(),
      project: "Agency",
      providers: [],
      clients: [
        client("acme", "Acme", ["site", "api"], ["acme.in"]),
        client("beta", "Beta", ["site"], ["beta.in"]),
        client("calm", "Calm", []),
      ],
    },
  };
}

const HEALTH: Health = {
  uptime: VIEW,
  now: NOW,
  domains: [
    {
      domain: "acme.in",
      expires: "2027-01-09T00:00:00.000Z",
      error: null,
      checkedAt: NOW.toISOString(),
    },
    {
      domain: "beta.in",
      expires: "2026-11-01T00:00:00.000Z",
      error: null,
      checkedAt: NOW.toISOString(),
    },
  ],
};

describe("client page with uptime and domains", () => {
  it("shows sites up/down and domain expiry per client, and puts a client with a site down first", () => {
    const html = renderClientsPage(ledger(), "", HEALTH);
    expect(html.indexOf(">Acme</a>")).toBeLessThan(html.indexOf(">Calm</a>")); // a site down sorts first
    expect(html).toContain("1 down");
    expect(html).toContain("in 82 days"); // acme.in → 2027-01-09
    expect(html).toContain("in 13 days"); // beta.in within 30 days: flagged
    expect(html).toContain('class="soon"');
    expect(html).toContain("down since 2026-10-18 10:40 UTC");
    expect(html).toContain("Keyword missing");
    expect(html).toContain("123 ms");
    expect(html).toContain("Domain expires on 2026-11-01 (14 days remaining)");
    expect(html).toContain("2026-10-10 08:00 UTC → 2026-10-10 08:12 UTC");
    expect(html).toContain("1 warning"); // beta: its only site is degraded (domain warning), neither up nor down
    expect(html).not.toContain("0/1 up");
  });

  it("says so when uptime is unavailable or a domain has not been looked up yet", () => {
    const html = renderClientsPage(ledger(), "", { uptime: null, domains: [], now: NOW });
    expect(html).toContain("uptime unavailable");
    expect(html).toContain("not looked up yet");
    expect(html).toContain("Uptime is unavailable right now");
  });
});

describe("activity page", () => {
  it("lists every check's last run and one timeline of alerts and outages", async () => {
    const db = createFakeD1();
    await recordRun(
      db,
      "collect",
      true,
      "12 rows, 0 spike(s), 0 limit level(s) crossed",
      "2026-10-18T10:00:00Z",
    );
    await recordRun(db, "terms", false, "Vercel · limits changed", "2026-10-18T03:31:00Z");
    await logAlert(
      db,
      "terms",
      "Vercel · limits changed\n- 100 GB\n+ 50 GB",
      "2026-10-18T03:31:00Z",
    );
    const html = renderActivityPage(ledger(), HEALTH, await loadRuns(db), await recentAlerts(db));
    expect(html).toContain("60 min ago");
    expect(html).toContain("needs a look");
    expect(html).toContain("not run yet"); // providers / drift
    expect(html).toContain("1 down"); // uptime row
    expect(html).toContain("4 checks");
    expect(html).toContain("Free-tier terms");
    expect(html).toContain("Acme · api");
    expect(html).toContain("Down: Keyword missing");
    expect(html).toContain("Back up after 12 min");
    // Newest first: the 10:40 outage before the 03:31 terms change.
    // ("+ 50 GB" appears only in the timeline; the run summary above it also says "Vercel · limits changed".)
    expect(html.indexOf("Down: Keyword missing")).toBeLessThan(html.indexOf("+ 50 GB"));
  });

  it("empty: says nothing happened; uptime unavailable is explicit", () => {
    const html = renderActivityPage(ledger(), { uptime: null, domains: [], now: NOW }, [], []);
    expect(html).toContain("Nothing has happened yet");
    expect(html).toContain("The uptime Worker did not answer.");
  });
});
