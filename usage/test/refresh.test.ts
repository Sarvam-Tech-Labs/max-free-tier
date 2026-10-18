import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DomainRow } from "../src/health";
import type { Ledger, LedgerProvider } from "../src/ledger";
import {
  COLLECT_CRON,
  nextDomainLookup,
  nextHourlyAt,
  nextMinuteAt,
  PROVIDERS_CRON,
  refreshRows,
} from "../src/refresh";
import { PROVIDERS_CRON as ROUTED } from "../src/run";
import { shell } from "../src/theme";
import { type PageData, renderConsumptionPage } from "../src/views";

const at = (s: string) => new Date(`2026-10-18T${s}Z`);
const iso = (d: Date) => d.toISOString();

describe("schedule", () => {
  it("matches the cron triggers scripts/sync.mjs generates, and the one index.ts routes", () => {
    const sync = readFileSync(new URL("../../scripts/sync.mjs", import.meta.url), "utf8");
    expect(sync).toContain(`const PROVIDERS_CRON = "${PROVIDERS_CRON}"`);
    expect(sync).toContain(`["${COLLECT_CRON}", PROVIDERS_CRON]`);
    expect(ROUTED).toBe(PROVIDERS_CRON);
  });

  it("nextHourlyAt is the next :minute, strictly after now", () => {
    expect(iso(nextHourlyAt(30, at("10:29:59")))).toBe("2026-10-18T10:30:00.000Z");
    expect(iso(nextHourlyAt(30, at("10:30:00")))).toBe("2026-10-18T11:30:00.000Z"); // that run is happening now
    expect(iso(nextHourlyAt(30, at("10:31:12")))).toBe("2026-10-18T11:30:00.000Z");
    expect(iso(nextHourlyAt(0, at("10:00:00")))).toBe("2026-10-18T11:00:00.000Z");
    expect(iso(nextHourlyAt(0, at("23:45:00")))).toBe("2026-10-19T00:00:00.000Z"); // across midnight
  });

  it("nextMinuteAt is the next whole minute", () => {
    expect(iso(nextMinuteAt(new Date("2026-10-18T10:00:00.000Z")))).toBe(
      "2026-10-18T10:01:00.000Z",
    );
    expect(iso(nextMinuteAt(new Date("2026-10-18T10:00:59.999Z")))).toBe(
      "2026-10-18T10:01:00.000Z",
    );
  });

  const dom = (checkedAt: string, error: string | null = null): DomainRow => ({
    domain: "a.in",
    expires: "2027-01-01T00:00:00.000Z",
    error,
    checkedAt,
  });
  it("a domain is looked up again on the first hourly run 24 hours after its last good lookup", () => {
    // Looked up at 13:00:00 yesterday: due exactly 13:00:00 today, picked up by that very run.
    expect(iso(nextDomainLookup([dom("2026-10-17T13:00:00.000Z")], at("12:10:00")))).toBe(
      "2026-10-18T13:00:00.000Z",
    );
    // Looked up at 13:00:05: due 13:00:05 today, so the 14:00 run.
    expect(iso(nextDomainLookup([dom("2026-10-17T13:00:05.000Z")], at("12:10:00")))).toBe(
      "2026-10-18T14:00:00.000Z",
    );
    // The soonest of several domains decides.
    expect(
      iso(
        nextDomainLookup(
          [dom("2026-10-18T09:00:00.000Z"), dom("2026-10-17T20:30:00.000Z")],
          at("12:10:00"),
        ),
      ),
    ).toBe("2026-10-18T21:00:00.000Z");
  });
  it("a failed lookup, or none yet, is retried on the very next hourly run", () => {
    expect(
      iso(nextDomainLookup([dom("2026-10-18T11:55:00.000Z", "RDAP HTTP 403")], at("12:10:00"))),
    ).toBe("2026-10-18T13:00:00.000Z");
    expect(iso(nextDomainLookup([], at("12:10:00")))).toBe("2026-10-18T13:00:00.000Z");
    // Overdue (the run was missed): the next run, never one in the past.
    expect(iso(nextDomainLookup([dom("2026-10-10T00:00:00.000Z")], at("12:10:00")))).toBe(
      "2026-10-18T13:00:00.000Z",
    );
  });
});

describe("refreshRows", () => {
  const base = {
    runs: [
      { name: "collect", at: "2026-10-18T10:00:00Z", ok: true, summary: "42 rows" },
      { name: "providers", at: "2026-10-18T10:30:00Z", ok: false, summary: "boom" },
    ],
    domains: [
      {
        domain: "a.in",
        expires: "2027-01-01T00:00:00.000Z",
        error: null,
        checkedAt: "2026-10-18T09:00:00.000Z",
      },
    ],
    now: at("11:00:00"),
    cloudflare: true,
    platforms: ["GitHub", "Resend"],
    sites: true,
    domainCount: 1,
  };

  it("lists only what is on the page, with each source's last run and next run", () => {
    const rows = refreshRows(base);
    expect(rows.map((r) => r.key)).toEqual(["cloudflare", "platforms", "uptime", "domains"]);
    const by = (k: string) => rows.find((r) => r.key === k);
    expect(by("cloudflare")).toMatchObject({
      every: "Every hour",
      lastAt: "2026-10-18T10:00:00Z",
      failed: false,
      nextAt: "2026-10-18T12:00:00.000Z",
    });
    expect(by("platforms")).toMatchObject({
      label: "GitHub, Resend",
      failed: true,
      note: "boom",
      nextAt: "2026-10-18T11:30:00.000Z",
    });
    expect(by("uptime")).toMatchObject({
      every: "Every minute",
      lastAt: null,
      period: 60_000,
      nextAt: "2026-10-18T11:01:00.000Z",
    });
    expect(by("domains")).toMatchObject({
      every: "Daily",
      lastAt: "2026-10-18T09:00:00.000Z",
      nextAt: "2026-10-19T09:00:00.000Z",
    });
    expect(
      refreshRows({ ...base, cloudflare: false, platforms: [], sites: false, domainCount: 0 }),
    ).toEqual([]);
    expect(
      refreshRows({ ...base, runs: [], domains: [] }).find((r) => r.key === "cloudflare"),
    ).toMatchObject({ lastAt: null, failed: false });
    const bad = refreshRows({
      ...base,
      domains: [{ ...base.domains[0], error: "RDAP HTTP 403" } as DomainRow],
    });
    expect(bad.find((r) => r.key === "domains")).toMatchObject({
      failed: true,
      note: "RDAP HTTP 403",
    });
  });
});

describe("Data refresh card on the Consumption tab", () => {
  const card = (id: string, platform: LedgerProvider["platform"]): LedgerProvider => ({
    id,
    platform,
    clientId: "acme",
    name: id,
    account: "x",
    plan: "Free",
    auth: "read-only",
    metrics: [],
  });
  const ledger: Ledger = {
    data: {
      generatedAt: "2026-10-18T11:00:00.000Z",
      project: "Agency",
      clients: [
        {
          id: "acme",
          name: "Acme",
          email: "owner@acme.in",
          status: "live",
          platforms: ["cloudflare-workers", "github-actions"],
          accounts: [],
          monitors: [{ id: "acme_site", name: "Website", url: "https://acme.in" }],
          domains: ["acme.in"],
        },
        {
          id: "bare",
          name: "Bare",
          email: "bare@x.in",
          status: "live",
          platforms: [],
          accounts: [],
          monitors: [],
          domains: [],
        },
      ],
      targets: [],
      providers: [card("cf", "cloudflare"), card("gh", "github")],
    },
  };
  const data = (over: Partial<PageData> = {}): PageData => ({
    ledger,
    health: {
      uptime: null,
      now: at("11:00:00"),
      domains: [
        {
          domain: "acme.in",
          expires: "2027-01-09T00:00:00.000Z",
          error: null,
          checkedAt: "2026-10-18T11:00:00.000Z",
        },
      ],
    },
    runs: [
      { name: "collect", at: "2026-10-18T10:00:00Z", ok: true, summary: "ok" },
      { name: "providers", at: "2026-10-18T10:30:00Z", ok: false, summary: "one token failed" },
    ],
    alerts: [],
    tz: "Asia/Kolkata",
    ...over,
  });

  it("says how often each kind of data refreshes, when it last did, and when it next will (live timer + exact time)", () => {
    const html = renderConsumptionPage(data(), "owner@acme.in");
    expect(html).toContain('aria-label="Data refresh"');
    for (const label of ["Cloudflare usage", "GitHub", "Site uptime", "Domain expiry"])
      expect(html).toContain(label);
    expect(html).toContain("Every hour");
    expect(html).toContain("Every minute");
    expect(html).toContain("Daily");
    // Live timers carry the milliseconds left; hourly and daily ones reload the page after the refresh, the per-minute one loops.
    expect(html).toContain('<div class="cd" data-left="3600000" data-reload>');
    expect(html).toContain('<div class="cd" data-left="1800000" data-reload>');
    expect(html).toContain('<div class="cd" data-left="60000" data-every="60000">');
    expect(html).toContain('<div class="cd" data-left="86400000" data-reload>');
    // Exact times in the viewer's zone (IST), UTC on hover.
    expect(html).toContain("18 Oct 2026, 17:30 IST"); // 12:00 UTC: next Cloudflare refresh
    expect(html).toContain("18 Oct 2026, 17:00 IST"); // 11:30 UTC: next platform refresh
    expect(html).toContain('title="18 Oct 2026, 12:00 UTC"');
    // Last refreshed, and a run that finished with errors is flagged.
    expect(html).toContain("60 min ago");
    expect(html).toContain("had errors");
    expect(html).toContain('title="one token failed"');
  });

  it("an email with nothing that refreshes shows no card; a source that never ran says so", () => {
    expect(renderConsumptionPage(data(), "bare@x.in")).not.toContain('aria-label="Data refresh"');
    const html = renderConsumptionPage(data({ runs: [] }), "owner@acme.in");
    expect(html).toContain("Not yet");
  });

  it("the page script counts the timers down and reloads once after a scheduled refresh", () => {
    const page = shell({ title: "t", active: "consumption", body: "", updated: "u", zone: "IST" });
    expect(page).toContain("querySelectorAll('.cd')");
    expect(page).toContain("data-reload");
    expect(page).toContain("location.reload()");
    expect(page).toContain("refreshing…");
  });
});
