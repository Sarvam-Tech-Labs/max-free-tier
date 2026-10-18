import { describe, expect, it } from "vitest";
import { CATALOG, PLATFORM_NAME } from "../src/catalog";
import type { Env } from "../src/env";
import {
  buildLedger,
  type Ledger,
  type LedgerProvider,
  type Meter,
  parseClients,
} from "../src/ledger";
import { FREE_PLAN_LIMITS, type LimitStatus } from "../src/limits";
import { KINDS } from "../src/providers";
import { saveReadings, upsertRows } from "../src/store";
import { fmtValue, groupByClient, renderClientsPage, renderPlatformsPage } from "../src/views";
import { createFakeD1 } from "./helpers/fake-d1";

const PERIOD = {
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
  anchor: "api" as const,
};
const meter = (key: string, used: number, limit: number, over: Partial<Meter> = {}): Meter => ({
  key,
  label: key,
  used,
  limit,
  unit: "count",
  resets: true,
  ...over,
});
const card = (
  over: Partial<LedgerProvider> & Pick<LedgerProvider, "id" | "platform">,
): LedgerProvider => ({
  name: over.id,
  account: "acct",
  plan: "Free",
  source: "official",
  auth: "read-only",
  period: PERIOD,
  metrics: [],
  ...over,
});

function ledger(): Ledger {
  return {
    series: [],
    data: {
      generatedAt: "2026-10-18T10:30:00.000Z",
      project: "Agency",
      clients: [
        {
          id: "acme",
          name: "Acme Books",
          email: "owner@acme.in",
          status: "live",
          platforms: ["cloudflare-workers"],
          accounts: [],
        },
        {
          id: "beta",
          name: "Beta Foods",
          status: "unconfirmed",
          platforms: ["vercel", "supabase"],
          accounts: [],
        },
        {
          id: "calm",
          name: "Calm Co",
          email: "hi@calm.in",
          status: "live",
          platforms: [],
          accounts: [],
        },
        {
          id: "evil",
          name: "<script>alert(1)</script>",
          email: 'x@y.in"><b>',
          status: "live",
          platforms: [],
          accounts: [],
        },
      ],
      providers: [
        card({
          id: "cf-acme",
          platform: "cloudflare",
          clientId: "acme",
          name: "Acme Books · Cloudflare",
          metrics: [
            meter("workers.requests", 96_000, 100_000, { label: "Workers requests (per day)" }),
            meter("kv.read", 10, 100_000),
          ],
        }),
        card({
          id: "gh-acme",
          platform: "github",
          clientId: "acme",
          metrics: [
            meter("github.actions_minutes", 1500, 2000, {
              unit: "minutes",
              label: "Actions minutes",
            }),
          ],
        }),
        card({
          id: "cf-calm",
          platform: "cloudflare",
          clientId: "calm",
          metrics: [meter("workers.requests", 100, 100_000)],
        }),
        card({
          id: "cf-stray",
          platform: "cloudflare",
          name: "Cloudflare",
          account: "stray-account",
          metrics: [meter("workers.requests", 5, 100_000)],
        }),
        card({
          id: "sb-calm",
          platform: "supabase",
          clientId: "calm",
          status: { label: "Alert", value: "Blog (def) is PAUSED" },
          metrics: [
            meter("supabase.abc.db_bytes", 450e6, 500e6, {
              unit: "bytes",
              resets: false,
              label: "Database size · abc",
            }),
            meter("supabase.xyz.db_bytes", 1e6, 500e6, {
              unit: "bytes",
              resets: false,
              note: "Last successful check 2026-10-18T01:00:00Z; the latest check failed",
            }),
          ],
        }),
      ],
    },
  };
}

describe("fmtValue", () => {
  it("formats counts, bytes and minutes", () => {
    expect(fmtValue("count", 12)).toBe("12");
    expect(fmtValue("count", 12_345)).toBe("12.3K");
    expect(fmtValue("count", 2_500_000)).toBe("2.5M");
    expect(fmtValue("bytes", 512)).toBe("512 B");
    expect(fmtValue("bytes", 2_500)).toBe("3 KB");
    expect(fmtValue("bytes", 450e6)).toBe("450.0 MB");
    expect(fmtValue("bytes", 1.5e9)).toBe("1.50 GB");
    expect(fmtValue("minutes", 1500)).toBe("1,500 min");
  });
});

describe("catalog", () => {
  it("every tracked Cloudflare limit has a catalog entry, and no catalog entry is both tracked-less and unexplained", () => {
    const cf = CATALOG.find((c) => c.id === "cloudflare");
    for (const metric of Object.keys(FREE_PLAN_LIMITS)) {
      expect(
        cf?.items.some((i) => i.match?.test(metric)),
        metric,
      ).toBe(true);
    }
    for (const cat of CATALOG) {
      expect(cat.items.length).toBeGreaterThan(0);
      expect(cat.sources.every((s) => s.startsWith("https://"))).toBe(true);
      for (const item of cat.items)
        expect(item.match !== undefined || !!item.why, `${cat.id}: ${item.label}`).toBe(true);
    }
  });
  it("covers every platform the collector can check, with a short name for each", () => {
    for (const kind of [...KINDS, "cloudflare"] as const) {
      expect(
        CATALOG.some((c) => c.id === kind),
        kind,
      ).toBe(true);
      expect(PLATFORM_NAME[kind]).toBeTruthy();
    }
  });
});

describe("parseClients", () => {
  it("keeps valid clients with defaults, drops malformed ones, tolerates junk", () => {
    expect(parseClients(undefined)).toEqual([]);
    expect(parseClients("nope")).toEqual([]);
    expect(parseClients('{"a":1}')).toEqual([]);
    expect(parseClients('[{"id":"a","name":"A"},{"id":1},{"name":"x"},null]')).toEqual([
      { id: "a", name: "A", status: "live", platforms: [], accounts: [] },
    ]);
  });
});

describe("renderClientsPage", () => {
  it("one row per client with email, sorted by how close each is to a limit; unmetered and unassigned are listed", () => {
    const html = renderClientsPage(ledger());
    const order = ["Acme Books", "Calm Co", "Beta Foods"].map((n) => html.indexOf(`>${n}</a>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1] as number); // acme 96% (workers) before calm 90% (supabase)
    expect(order[1]).toBeLessThan(order[2] as number); // metered before "not metered yet"
    expect(html).toContain("owner@acme.in");
    expect(html).toContain("96%");
    expect(html).toContain("not metered yet");
    expect(html).toContain("no email on file");
    expect(html).toContain("Not in the registry"); // the stray Cloudflare account is not hidden
    expect(html).toContain("1 alert");
    expect(html).toContain("Blog (def) is PAUSED");
    expect(html).toContain("Not confirmed as a live client");
    expect(html).toContain("Platforms on file: vercel, supabase");
    expect(html).toContain("the latest check failed");
    expect(html).toContain("1 client has no email in the registry"); // beta (evil and calm and acme have one)
  });

  it("search finds a client by email (case-insensitive), by name or id; a single hit opens its detail; no hit says so", () => {
    const l = ledger();
    const byEmail = renderClientsPage(l, "OWNER@acme.in");
    expect(byEmail).toContain("Acme Books");
    expect(byEmail).not.toContain("Calm Co");
    expect(byEmail).toMatch(/<details id="client-acme" open>/);
    expect(renderClientsPage(l, "calm")).toContain("hi@calm.in");
    expect(renderClientsPage(l, "beta")).toContain("Beta Foods");
    const none = renderClientsPage(l, "nobody@nowhere.in");
    expect(none).toContain("No client matches “nobody@nowhere.in”");
    expect(none).toContain('href="/clients"'); // Clear link
    expect(renderClientsPage(l)).not.toMatch(/<details id="client-acme" open>/); // several hits: collapsed
  });

  it("escapes everything that comes from the registry or the query", () => {
    const html = renderClientsPage(ledger(), '"><script>x</script>');
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    const all = renderClientsPage(ledger());
    expect(all).not.toContain("<script>alert(1)</script>");
    expect(all).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(all).not.toContain('x@y.in"><b>'); // the hostile email, raw
    expect(all).toContain("x@y.in&quot;&gt;&lt;b&gt;");
  });

  it("groupByClient: registry clients first, then the unassigned group only when there are orphans", () => {
    const l = ledger();
    const groups = groupByClient(l);
    expect(groups.map((g) => g.client.id)).toEqual(["acme", "beta", "calm", "evil", ""]);
    l.data.providers = l.data.providers.filter((p) => p.clientId);
    expect(groupByClient(l).map((g) => g.client.id)).toEqual(["acme", "beta", "calm", "evil"]);
  });
});

describe("renderPlatformsPage", () => {
  it("lists every platform's allowances with sources and as-of dates, and each client's share per tracked meter", () => {
    const html = renderPlatformsPage(ledger());
    for (const name of ["Cloudflare (", "GitHub (", "Resend (", "Supabase (", "Vercel ("])
      expect(html).toContain(name);
    expect(html).toContain("limits as of 2026-10-18");
    expect(html).toContain('href="https://developers.cloudflare.com/workers/platform/pricing/"');
    expect(html).toContain("Workers requests (per day)");
    expect(html).toContain("100,000 per day");
    expect(html).toContain("Acme Books"); // matrix column
    expect(html).toContain("Not in the registry"); // stray account column
    expect(html).toContain('title="96,000 of 100,000"'); // matrix cell tooltip: exact figures
    expect(html).toContain("96%");
    expect(html).toContain("2,000 per month"); // GitHub minutes allowance
    expect(html).toContain("worst of 2"); // two Supabase projects under one client
    expect(html).toContain("Not tracked here.");
    expect(html).toContain("Dashboard only: no API token can read it on the free plan"); // Vercel / Supabase egress
    expect(html).toContain("a paying client's site belongs on a paid plan");
    expect(html).toContain("no client on this platform yet"); // Resend has no cards
    expect(html).toContain("Blog (def) is PAUSED");
    expect(html).toContain("Free-tier limits by platform");
  });
});

describe("pages built from real ledger data", () => {
  it("end to end: registry clients, Cloudflare rows and a stored provider reading show up on both pages", async () => {
    const acct = "0123456789abcdef0123456789abcdef";
    const env: Env = {
      USAGE: createFakeD1(),
      CF_API_TOKEN: "t",
      CF_ACCOUNT_ID: acct,
      CLIENTS_JSON: JSON.stringify([
        {
          id: "acme",
          name: "Acme Books",
          email: "owner@acme.in",
          status: "live",
          platforms: [],
          accounts: [acct],
        },
      ]),
      PROVIDERS_JSON: JSON.stringify([
        { id: "acme", client: "Acme Books", kind: "github", token: "T", account: "acme-co" },
      ]),
    };
    await upsertRows(
      env.USAGE,
      [{ date: "2026-10-18", product: "workers", metric: "requests", dim: "w", value: 50_000 }],
      "t",
    );
    const reading: LimitStatus = {
      metric: "github.actions_minutes",
      used: 1000,
      limit: 2000,
      period: "month",
      periodKey: "2026-10",
      pct: 50,
      level: 50,
    };
    await saveReadings(env.USAGE, "github:acme", [reading], "2026-10-18T10:00:00Z");
    const l = await buildLedger(env, new Date("2026-10-18T10:30:00Z"));
    expect(l.data.providers.map((p) => [p.platform, p.clientId])).toEqual([
      ["cloudflare", "acme"],
      ["github", "acme"],
    ]);
    const clients = renderClientsPage(l, "owner@acme.in");
    expect(clients).toContain("50%");
    expect(clients).toContain("Workers requests (per day)");
    expect(renderPlatformsPage(l)).toContain("Acme Books");
  });
});
