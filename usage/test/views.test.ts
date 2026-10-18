import { describe, expect, it } from "vitest";
import { CATALOG, cycleOf, itemFor, platformOf } from "../src/catalog";
import type { UptimeView } from "../src/health";
import type { Ledger, LedgerProvider, Meter } from "../src/ledger";
import { shell } from "../src/theme";
import { daysUntil, formatInstant, nextReset, relative, safeZone, zoneLabel } from "../src/time";
import { accountsOf, type PageData, renderConsumptionPage, renderLimitsPage } from "../src/views";

const NOW = new Date("2026-10-18T11:00:00Z");
const unix = (iso: string) => Date.parse(iso) / 1000;

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
  auth: "read-only",
  metrics: [],
  ...over,
});
const client = (
  id: string,
  name: string,
  email: string | undefined,
  over: Record<string, unknown> = {},
) => ({
  id,
  name,
  ...(email ? { email } : {}),
  status: "live",
  platforms: [] as string[],
  accounts: [] as string[],
  monitors: [] as Array<{ id: string; name: string; url: string }>,
  domains: [] as string[],
  ...over,
});

const UPTIME: UptimeView = {
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
    shared_site: { status: "up", incidents: [] },
  },
};

function ledger(): Ledger {
  return {
    data: {
      generatedAt: NOW.toISOString(),
      project: "Agency",
      clients: [
        client("acme", "Acme Books", "owner@acme.in", {
          platforms: [
            "cloudflare-workers",
            "vercel",
            "resend",
            "github-actions",
            "supabase",
            "razorpay",
          ],
          monitors: [
            { id: "acme_site", name: "Website", url: "https://acme.in" },
            { id: "acme_api", name: "API", url: "https://acme.in/api" },
          ],
          domains: ["acme.in"],
        }),
        client("shared", "Shared Site", "shared@stl.in", {
          monitors: [{ id: "shared_site", name: "Site", url: "https://shared.in" }],
        }),
        client("shared2", "Shared App", "shared@stl.in", { platforms: ["vercel"] }),
        client("beta", "Beta Foods", undefined, { status: "unconfirmed", platforms: ["firebase"] }),
        client("evil", "<script>alert(1)</script>", 'x@y.in"><b>', {}),
      ],
      // The registry asks for a Vercel token for acme that has not been pasted yet.
      targets: [{ clientId: "acme", platform: "vercel", token: "VERCEL_ACME" }],
      providers: [
        card({
          id: "cf-acme",
          platform: "cloudflare",
          clientId: "acme",
          name: "Acme Books · Cloudflare",
          account: "0a1b2c3d",
          metrics: [
            meter("workers.requests", 96_000, 100_000, {
              label: "Workers requests",
              resetsAt: "2026-10-19T00:00:00.000Z",
            }),
            meter("kv.read", 10, 100_000, {
              label: "KV reads",
              resetsAt: "2026-10-19T00:00:00.000Z",
            }),
          ],
        }),
        card({
          id: "gh-acme",
          platform: "github",
          clientId: "acme",
          metrics: [
            meter("github.actions_minutes", 1500, 2000, {
              unit: "minutes",
              label: "Actions minutes (private repos)",
              resetsAt: "2026-11-01T00:00:00.000Z",
            }),
          ],
        }),
        card({
          id: "rs-acme",
          platform: "resend",
          clientId: "acme",
          metrics: [
            meter("resend.emails_daily", 20, 100, {
              label: "Emails per day",
              resetsAt: "2026-10-19T09:30:00.000Z",
            }),
          ],
        }),
        card({
          id: "sb-acme",
          platform: "supabase",
          clientId: "acme",
          account: "abc, def",
          status: { label: "Alert", value: "Blog (def) is PAUSED" },
          metrics: [
            meter("supabase.abc.db_bytes", 450e6, 500e6, {
              unit: "bytes",
              resets: false,
              label: "Database size · abc",
              confidence: "approximate",
            }),
            meter("supabase.abc.storage_bytes", 1e6, 1e9, {
              unit: "bytes",
              resets: false,
              label: "File storage · abc",
              note: "Last successful check 2026-10-18T01:00:00Z; the latest check failed",
            }),
          ],
        }),
        card({
          id: "cf-stray",
          platform: "cloudflare",
          name: "Cloudflare",
          metrics: [meter("workers.requests", 5, 100_000)],
        }),
      ],
    },
  };
}

function data(over: Partial<PageData> = {}): PageData {
  return {
    ledger: ledger(),
    health: {
      uptime: UPTIME,
      now: NOW,
      domains: [
        {
          domain: "acme.in",
          expires: "2027-01-09T00:00:00.000Z",
          error: null,
          checkedAt: NOW.toISOString(),
        },
      ],
    },
    runs: [
      { name: "collect", at: "2026-10-18T10:00:00Z", ok: true, summary: "ok" },
      { name: "terms", at: "2026-10-18T03:30:00Z", ok: true, summary: "no changes" },
      { name: "drift", at: "2026-10-18T03:31:00Z", ok: false, summary: "docs drift" },
    ],
    alerts: [],
    tz: "Asia/Kolkata",
    ...over,
  };
}

const items = CATALOG.flatMap((c) => c.items);
const count = (html: string, re: RegExp): number => [...html.matchAll(re)].length;

describe("time", () => {
  it("formats exact instants in the org zone with UTC for the tooltip", () => {
    expect(formatInstant("2026-10-19T00:00:00Z", "Asia/Kolkata")).toEqual({
      text: "19 Oct 2026, 05:30 IST",
      utc: "19 Oct 2026, 00:00 UTC",
    });
    expect(formatInstant("2026-10-19T00:00:00Z", "UTC").text).toBe("19 Oct 2026, 00:00 UTC");
    expect(formatInstant("2026-12-31T20:00:00Z", "Asia/Kolkata").text).toBe(
      "1 Jan 2027, 01:30 IST",
    );
    expect(zoneLabel("Asia/Kolkata")).toBe("IST");
    expect(zoneLabel("Europe/Paris")).toBe("Europe/Paris");
  });
  it("safeZone falls back to IST for a typo", () => {
    expect(safeZone("Europe/Paris")).toBe("Europe/Paris");
    expect(safeZone("Not/AZone")).toBe("Asia/Kolkata");
    expect(safeZone(undefined)).toBe("Asia/Kolkata");
    expect(safeZone("  ")).toBe("Asia/Kolkata");
  });
  it("relative reads naturally in both directions", () => {
    expect(relative("2026-10-18T11:00:20Z", NOW)).toBe("just now");
    expect(relative("2026-10-18T11:30:00Z", NOW)).toBe("in 30 min");
    expect(relative("2026-10-19T00:00:00Z", NOW)).toBe("in 13 h");
    expect(relative("2026-11-01T00:00:00Z", NOW)).toBe("in 14 days"); // 13.6 days
    expect(relative("2026-10-18T03:30:00Z", NOW)).toBe("8 h ago");
  });
  it("nextReset: UTC midnight, the 1st of the next month (also across the year), nothing for provider-dependent cycles", () => {
    expect(nextReset("utc-day", NOW)).toBe("2026-10-19T00:00:00.000Z");
    expect(nextReset("utc-month", NOW)).toBe("2026-11-01T00:00:00.000Z");
    expect(nextReset("utc-month", new Date("2026-12-31T23:59:00Z"))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(nextReset("billing", NOW)).toBeUndefined();
    expect(nextReset("rolling", NOW)).toBeUndefined();
    expect(nextReset("none", NOW)).toBeUndefined();
  });
  it("daysUntil counts whole days, negative once past", () => {
    expect(daysUntil("2026-10-28T11:00:00Z", NOW)).toBe(10);
    expect(daysUntil("2026-10-17T11:00:00Z", NOW)).toBe(-1);
  });
});

describe("catalog", () => {
  it("every item is tracked or says why not; every tracked Cloudflare limit is listed", () => {
    for (const cat of CATALOG) {
      expect(cat.sources.every((s) => s.startsWith("https://"))).toBe(true);
      for (const item of cat.items)
        expect(item.match !== undefined || !!item.why, `${cat.id}: ${item.label}`).toBe(true);
    }
    expect(itemFor("cloudflare", "workers.requests")?.frequency).toBe("Daily");
    expect(itemFor("cloudflare", "r2.class_a")?.frequency).toBe("Monthly");
    expect(itemFor("resend", "resend.emails_daily")?.frequency).toBe("Rolling 24 h");
    expect(itemFor("supabase", "supabase.xyz.db_bytes")?.frequency).toBe("Never");
    expect(itemFor("github", "nope")).toBeUndefined();
  });
  it("cycleOf: calendar rules give a date, billing-cycle and rolling ones do not, sizes never reset", () => {
    expect(cycleOf({ frequency: "Daily", resets: "00:00 UTC" })).toBe("utc-day");
    expect(cycleOf({ frequency: "Monthly", resets: "1st of the month, 00:00 UTC" })).toBe(
      "utc-month",
    );
    expect(cycleOf({ frequency: "Monthly", resets: "1st of the month" })).toBe("utc-month");
    expect(cycleOf({ frequency: "Monthly", resets: "billing cycle" })).toBe("billing");
    expect(cycleOf({ frequency: "Rolling 24 h", resets: "x" })).toBe("rolling");
    expect(cycleOf({ frequency: "Daily", resets: "rolling" })).toBe("billing");
    expect(cycleOf({ frequency: "Never", resets: "a size" })).toBe("none");
    // Nothing that claims to reset daily or monthly may fall through to "none" by accident.
    for (const i of items)
      if (i.frequency === "Daily" || i.frequency === "Monthly")
        expect(cycleOf(i), i.label).not.toBe("none");
  });
  it("platformOf maps the registry's platform names, and ignores ones we do not monitor", () => {
    for (const p of [
      "cloudflare-workers",
      "cloudflare-pages",
      "d1",
      "r2",
      "kv",
      "queues",
      "workers-ai",
      "durable-objects",
    ])
      expect(platformOf(p), p).toBe("cloudflare");
    expect(platformOf("github-actions")).toBe("github");
    expect(platformOf("vercel")).toBe("vercel");
    expect(platformOf("razorpay")).toBeUndefined();
    expect(platformOf("firebase")).toBeUndefined();
  });
});

describe("design system shell", () => {
  const html = shell({
    title: "T <x>",
    active: "consumption",
    body: "<p>hi</p>",
    updated: "Updated 1 min ago",
    zone: "IST",
  });
  it("uses the STL brand: tokens, Inter, the real logo, glass navbar, two tabs", () => {
    expect(html).toContain("--bg-color:#0a0a0f");
    expect(html).toContain("--accent-primary:#6366f1");
    expect(html).toContain("--gradient-primary:linear-gradient(135deg,#6366f1,#22d3ee)");
    expect(html).toContain("fonts.googleapis.com/css2?family=Inter");
    expect(html).toContain(
      'd="M40 18C40 18 34 18 28 18C22 18 18 22 18 26C18 30 22 32 28 33C34 34 40 36 40 40C40 44 36 46 28 46C22 46 18 46 18 46"',
    ); // logo-icon.svg
    expect(html).toContain("backdrop-filter:blur(10px)");
    expect(html).toContain('<a class="tab" href="/consumption" aria-current="page">');
    expect(html).toContain('<a class="tab" href="/">');
    expect(html).toContain("Updated 1 min ago · times in IST");
    expect(html).toContain("T &lt;x&gt; · Free-tier monitor");
    expect(html).toContain('rel="icon"');
    expect(html).toContain('name="robots" content="noindex"');
  });
  it("is accessible: landmarks, labelled nav, focus style, reduced motion", () => {
    expect(html).toContain('aria-label="Sections"');
    expect(html).toContain(":focus-visible");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("<main>");
    expect(html).toContain("<footer>");
  });
});

describe("tab 1: free-tier limits", () => {
  it("lists every limit of every platform in one filterable table", () => {
    const html = renderLimitsPage(data());
    expect(count(html, /<tr data-platform="/g)).toBe(items.length);
    for (const c of CATALOG) expect(html).toContain(`data-chip="${c.id}"`);
    for (const id of ["q", "cat", "freq", "trk", "reset", "count", "none", "limits"])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain('data-tracked="1"');
    expect(html).toContain('data-tracked="0"');
    expect(html).toContain('data-category="Database"');
    expect(html).toContain('data-freq="Rolling 24 h"');
    expect(html).toMatch(/<option value="Builds">Builds<\/option>/);
    expect(html).toContain("Free-tier limits · Free-tier monitor");
    expect(html).toContain('aria-current="page">');
    expect(html).toContain("Tracked live");
    expect(html).toContain("Not tracked");
    expect(html).toContain("Daily reset");
    expect(html).toContain("05:30 IST"); // 00:00 UTC is 05:30 in IST
    expect(html).toContain("00:00 UTC, every day");
    expect(html).toContain("Dashboard only: no API token can read it on the free plan");
  });

  it("shows when each calendar-based limit next resets, exactly, in IST with UTC on hover", () => {
    const html = renderLimitsPage(data());
    expect(html).toContain('<span title="19 Oct 2026, 00:00 UTC">19 Oct 2026, 05:30 IST</span>'); // daily at 00:00 UTC
    expect(html).toContain('<span title="1 Nov 2026, 00:00 UTC">1 Nov 2026, 05:30 IST</span>'); // monthly on the 1st
    const utc = renderLimitsPage(data({ tz: "UTC" }));
    expect(utc).toContain("19 Oct 2026, 00:00 UTC</span>");
    expect(utc).toContain("times in UTC");
  });

  it("empty change history says what is watched; check badges show the last runs", () => {
    const html = renderLimitsPage(data());
    expect(html).toContain("No change detected yet");
    expect(html).toContain("Terms watch: no changes · 8 h ago");
    expect(html).toContain("Limits vs docs: changed · 7 h ago"); // 7.48 h
    const none = renderLimitsPage(data({ runs: [] }));
    expect(none).toContain("Terms watch: not run yet");
  });

  it("change history: platform badge, headline, and the exact lines coloured; only terms and drift entries", () => {
    const report =
      "===\n01. CHANGED: Vercel · limits (https://vercel.com/docs/limits)\n===\n--- @ old\n+++ @ new\n@@ -1 +1 @@\n-Fast Data Transfer 100 GB\n+Fast Data Transfer 50 GB <b>";
    const html = renderLimitsPage(
      data({
        alerts: [
          { at: "2026-10-18T03:31:00Z", source: "terms", text: report },
          {
            at: "2026-10-17T03:31:00Z",
            source: "drift",
            text: "DRIFT kv.write: docs say 500/day, limits.ts has 1,000/day",
          },
          {
            at: "2026-10-18T10:00:00Z",
            source: "usage",
            text: "usage alert that is not a limit change",
          },
        ],
      }),
    );
    expect(count(html, /<article class="event"/g)).toBe(2);
    expect(html).toContain("01. CHANGED: Vercel · limits (https://vercel.com/docs/limits)");
    expect(html).toContain('<span class="add">+Fast Data Transfer 50 GB &lt;b&gt;</span>'); // escaped
    expect(html).toContain('<span class="del">-Fast Data Transfer 100 GB</span>');
    expect(html).toContain('<span class="hunk">@@ -1 +1 @@</span>');
    expect(html).not.toContain('class="add">+++'); // file header lines are not additions
    expect(html).toContain("Free-tier terms");
    expect(html).toContain("Limits vs docs");
    expect(html).toContain("DRIFT kv.write");
    expect(html).not.toContain("usage alert that is not a limit change");
    expect(html).toContain("19 Oct 2026"); // not here: shown in IST as 18 Oct 09:01
    expect(html).toContain("18 Oct 2026, 09:01 IST");
  });

  it("sources: every platform with its plan, as-of date, provenance and links", () => {
    const html = renderLimitsPage(data());
    expect(html).toContain("Where these numbers come from");
    expect(html).toContain('href="https://developers.cloudflare.com/workers/platform/pricing/"');
    expect(html).toContain("free-tier-maxxer");
    expect(html).toContain("as of 2026-10-11");
  });
});

describe("tab 2: consumption", () => {
  it("accountsOf groups clients by owner email, alphabetical, no-email last; shared emails group together", () => {
    const a = accountsOf(data().ledger);
    expect(a.map((x) => x.email)).toEqual(
      ['x@y.in"><b>', "owner@acme.in", "shared@stl.in", ""].sort((p, q) =>
        p === "" ? 1 : q === "" ? -1 : p.localeCompare(q),
      ),
    );
    expect(a.find((x) => x.email === "shared@stl.in")?.clients.map((c) => c.name)).toEqual([
      "Shared Site",
      "Shared App",
    ]);
  });

  it("sidebar: collapsible, every email with its project count, selected one marked, attention dot", () => {
    const html = renderConsumptionPage(data(), "owner@acme.in");
    expect(html).toContain('id="accounts"');
    expect(html).toContain("data-sidebar-toggle");
    expect(html).toContain('aria-controls="accounts"');
    expect(html).toContain('aria-label="Collapse the account list"');
    expect(html).toContain('href="/consumption?email=owner%40acme.in" aria-current="page"');
    expect(html).toContain('href="/consumption?email=shared%40stl.in"');
    expect(html).toContain('href="/consumption?email=none"');
    expect(html).toContain("No email on file");
    expect(html).toContain("2 projects"); // shared@stl.in
    expect(html).toContain("1 project");
    expect(html).toContain('class="dot"'); // acme has a site down, a paused project and usage at 96%
  });

  it("picking an email shows its platforms in a fixed order with consumption, exact reset time and frequency", () => {
    const html = renderConsumptionPage(data(), "owner@acme.in");
    const order = ["Cloudflare", "Vercel", "Resend", "GitHub", "Supabase"].map((p) =>
      html.indexOf(`<h2>${p}</h2>`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('96,000 <span class="muted">of 100,000</span>');
    expect(html).toContain("96%");
    expect(html).toContain(
      'title="19 Oct 2026, 00:00 UTC"><div class="d">19 Oct 2026</div><div class="t">05:30 IST · in 13 h</div>',
    ); // Cloudflare daily
    expect(html).toContain("in 13 h");
    expect(html).toContain(
      'title="19 Oct 2026, 09:30 UTC"><div class="d">19 Oct 2026</div><div class="t">15:00 IST · in 23 h</div>',
    ); // Resend: time from the API
    expect(html).toContain(
      'title="1 Nov 2026, 00:00 UTC"><div class="d">1 Nov 2026</div><div class="t">05:30 IST · in 14 days</div>',
    ); // GitHub monthly
    expect(html).toContain("1,500 min");
    expect(html).toContain(">Daily</span>");
    expect(html).toContain(">Monthly</span>");
    expect(html).toContain(">Rolling 24 h</span>");
    expect(html).toContain(">Never</span>"); // sizes
    expect(html).toContain("a size, not a quota");
    expect(html).toContain("approximate");
    expect(html).toContain("the latest check failed");
    expect(html).toContain("Blog (def) is PAUSED");
  });

  it("a platform on file but not connected says so and why, and still lists what the plan includes", () => {
    const html = renderConsumptionPage(data(), "owner@acme.in");
    expect(html).toContain("Not connected");
    expect(html).toContain("Vercel's Hobby plan"); // apostrophes are not escaped
    // The registry asks for VERCEL_ACME: the hint names it and points to the Tokens page.
    expect(html).toContain(
      'Waiting for <code>VERCEL_ACME</code>. Paste it on the <a href="/tokens">Tokens page</a>',
    );
    // Collapsed by default, so the list of what the plan includes cannot push real data off the page.
    expect(html).toMatch(
      /<details[^>]*><summary>[\s\S]*?What the free plan includes \(11 limits\)/,
    );
    expect(html).not.toMatch(/<details open/);
    expect(html).toContain("Fast Data Transfer");
    expect(html).toContain("100 GB / month");
    expect(html).toContain("Date not exposed by Vercel");
    expect(html).toContain("Also uses razorpay, which are not monitored");
    expect(html).toContain(
      "Other limits on this plan that can&#39;t be measured".replace("&#39;", "'"),
    );
  });

  it("status strip: sites down, domain expiry in IST, highest usage; details list every site and domain", () => {
    const html = renderConsumptionPage(data(), "owner@acme.in");
    expect(html).toContain("1 down");
    expect(html).toContain("acme.in");
    expect(html).toContain("82 days");
    expect(html).toContain("9 Jan 2027, 05:30 IST");
    expect(html).toContain("Highest usage");
    expect(html).toContain("Workers requests · Cloudflare");
    expect(html).toContain("Keyword missing");
    expect(html).toContain("123 ms");
    expect(html).toContain("Sites and domains");
    expect(html).toContain("domain registration");
    const ok = renderConsumptionPage(data(), "shared@stl.in");
    expect(ok).toContain("1/1 up");
    expect(ok).not.toContain("1 down");
  });

  it("uptime unavailable, domain not looked up, domain expiring soon and expired are all explicit", () => {
    const d = data();
    expect(
      renderConsumptionPage({ ...d, health: { ...d.health, uptime: null } }, "owner@acme.in"),
    ).toContain("Uptime is unavailable right now");
    expect(
      renderConsumptionPage({ ...d, health: { ...d.health, domains: [] } }, "owner@acme.in"),
    ).toContain("not looked up yet");
    const at = (iso: string | null, error: string | null = null) => ({
      ...d,
      health: {
        ...d.health,
        domains: [{ domain: "acme.in", expires: iso, error, checkedAt: NOW.toISOString() }],
      },
    });
    expect(renderConsumptionPage(at("2026-11-01T00:00:00.000Z"), "owner@acme.in")).toContain(
      "expires soon",
    );
    expect(renderConsumptionPage(at("2026-10-01T00:00:00.000Z"), "owner@acme.in")).toContain(
      "expired",
    );
    expect(renderConsumptionPage(at(null, "RDAP HTTP 503"), "owner@acme.in")).toContain(
      "lookup failed",
    );
  });

  it("selection: email in any case, 'none' for clients without one, unknown or empty falls back to what needs attention", () => {
    const d = data();
    expect(renderConsumptionPage(d, "OWNER@ACME.IN")).toMatch(/<h1>owner@acme\.in<\/h1>/);
    expect(renderConsumptionPage(d, "none")).toContain("<h1>No email on file</h1>");
    expect(renderConsumptionPage(d, "none")).toContain("Beta Foods");
    expect(renderConsumptionPage(d, "none")).toContain("unconfirmed");
    expect(renderConsumptionPage(d, "nobody@x.in")).toMatch(/<h1>(owner@acme\.in|x@y\.in)/);
    expect(renderConsumptionPage(d, "")).toContain("<h1>");
    const shared = renderConsumptionPage(d, "shared@stl.in");
    expect(shared).toContain("Shared Site");
    expect(shared).toContain("Shared App");
  });

  it("escapes everything that comes from the registry", () => {
    const html = renderConsumptionPage(data(), 'x@y.in"><b>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('x@y.in"><b>');
    expect(html).toContain("x@y.in&quot;&gt;&lt;b&gt;");
  });

  it("no clients at all: a plain empty state, not an error", () => {
    const d = data();
    d.ledger.data.clients = [];
    d.ledger.data.providers = [];
    expect(renderConsumptionPage(d)).toContain("No clients in the registry yet");
  });

  it("an owner with nothing connected still lists the platforms on file", () => {
    const d = data();
    d.ledger.data.providers = [];
    const html = renderConsumptionPage(d, "owner@acme.in");
    expect(html).toContain("Not connected");
    expect(html).toContain("No Cloudflare account is linked");
    expect(html).toContain("Nothing connected yet");
    // Resend has no usage block in the registry: the hint says what to add first, then where to paste the token.
    expect(html).toContain("Not set up yet: add a <code>usage:</code> block for Resend");
  });
});
