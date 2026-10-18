import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { formatLimitLine } from "../src/limits";
import { checkTarget, type ProviderTarget, parseProviders, parseTokens } from "../src/providers";
import { PROVIDERS_CRON, runProviders } from "../src/run";
import { loadReadings } from "../src/store";
import { createFakeD1 } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T10:30:00Z");
const LEVELS = [50, 80, 95];
const TOKENS = { GH: "gh-secret", RS: "rs-secret", SB: "sb-secret", VC: "vc-secret" };

/** Routes by URL prefix; records every call. Unknown URLs (webhooks) → 200. */
function stub(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    for (const [prefix, h] of Object.entries(routes)) if (url.startsWith(prefix)) return h(init);
    return new Response("{}", { status: 200 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const gh: ProviderTarget = {
  id: "acme",
  client: "Acme",
  kind: "github",
  token: "GH",
  account: "acme",
};
const rs: ProviderTarget = { id: "acme", client: "Acme", kind: "resend", token: "RS" };
const sb: ProviderTarget = {
  id: "acme",
  client: "Acme",
  kind: "supabase",
  token: "SB",
  projects: ["aaa", "bbb", "ccc", "ddd"],
};
const vc: ProviderTarget = {
  id: "acme",
  client: "Acme",
  kind: "vercel",
  token: "VC",
  account: "team_1",
};

describe("parseProviders / parseTokens", () => {
  it("empty → []/{}; valid passes through", () => {
    expect(parseProviders(undefined)).toEqual([]);
    expect(parseProviders(" ")).toEqual([]);
    expect(parseTokens("")).toEqual({});
    expect(parseProviders(JSON.stringify([gh, sb]))).toHaveLength(2);
    expect(parseTokens('{"A":"x"}')).toEqual({ A: "x" });
  });
  it("rejects bad shapes", () => {
    expect(() => parseProviders("{}")).toThrow(/array/);
    expect(() => parseProviders(JSON.stringify([{ ...gh, kind: "netlify" }]))).toThrow(/kind/);
    expect(() => parseProviders(JSON.stringify([{ ...gh, account: undefined }]))).toThrow(
      /needs account/,
    );
    expect(() => parseProviders(JSON.stringify([{ ...sb, projects: [] }]))).toThrow(
      /needs projects/,
    );
    expect(() => parseTokens("[]")).toThrow(/PROVIDER_TOKENS/);
    expect(() => parseTokens('{"A":1}')).toThrow(/PROVIDER_TOKENS/);
  });
});

describe("checkTarget", () => {
  it("missing token → rejects without any call", async () => {
    const { f, calls } = stub({});
    await expect(checkTarget(gh, {}, NOW, LEVELS, f)).rejects.toThrow(
      /token GH is not set \(add it on the site's Tokens page\)/,
    );
    expect(calls).toHaveLength(0);
  });

  it("github: sums Actions minute SKUs for this UTC month; user vs org path; UA + bearer sent", async () => {
    const { f, calls } = stub({
      "https://api.github.com/": () =>
        Response.json({
          usageItems: [
            { product: "actions", sku: "actions_linux", unitType: "minutes", grossQuantity: 1500 },
            { product: "actions", sku: "actions_windows", unitType: "Minutes", grossQuantity: 120 },
            {
              product: "actions",
              sku: "actions_storage",
              unitType: "gigabyte-hours",
              grossQuantity: 99,
            },
            { product: "packages", unitType: "minutes", grossQuantity: 1000 },
          ],
        }),
    });
    const [s] = await checkTarget(gh, TOKENS, NOW, LEVELS, f);
    expect(s).toMatchObject({
      metric: "github.actions_minutes",
      used: 1620,
      limit: 2000,
      period: "month",
      periodKey: "2026-10",
      level: 80,
    });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/users/acme/settings/billing/usage/summary?year=2026&month=10",
    );
    const h = calls[0]?.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer gh-secret");
    expect(h["User-Agent"]).toBeTruthy();
    await checkTarget({ ...gh, org: true }, TOKENS, NOW, LEVELS, f);
    expect(calls[1]?.url).toContain("/organizations/acme/");
  });

  it("github: no minutes → a 0 reading (the overview shows it); HTTP error names the provider, never the token", async () => {
    const empty = stub({ "https://api.github.com/": () => Response.json({ usageItems: [] }) });
    expect(await checkTarget(gh, TOKENS, NOW, LEVELS, empty.f)).toMatchObject([
      { metric: "github.actions_minutes", used: 0, limit: 2000, level: null },
    ]);
    const denied = stub({ "https://api.github.com/": () => new Response("no", { status: 403 }) });
    const err = await checkTarget(gh, TOKENS, NOW, LEVELS, denied.f).catch((e: Error) => e.message);
    expect(err).toBe("github: HTTP 403");
  });

  it("resend: every capped quota with usage, daily vs monthly; null limits and zero usage skipped", async () => {
    const { f } = stub({
      "https://api.resend.com/usage": () =>
        Response.json({
          object: "usage",
          emails: { daily: { used: 96, limit: 100 }, monthly: { used: 1600, limit: 3000 } },
          contacts: { used: 0, limit: 1000 },
          domains: { used: 2, limit: 3 },
          broadcasts: { used: 4, limit: null },
          rate_limit: { limit: 10, duration: "1000ms" },
        }),
    });
    const out = await checkTarget(rs, TOKENS, NOW, LEVELS, f);
    expect(out.map((s) => [s.metric, s.period, s.level])).toEqual([
      ["resend.contacts", "month", null], // used 0 is kept: the overview shows it, no alert fires
      ["resend.domains", "month", 50],
      ["resend.emails_daily", "day", 95],
      ["resend.emails_monthly", "month", 50],
    ]);
  });

  it("resend: the reset time comes from the API (resets_at, or next_increase_at for AI credits); an unusable one is ignored", async () => {
    const { f } = stub({
      "https://api.resend.com/usage": () =>
        Response.json({
          object: "usage",
          emails: {
            daily: { used: 96, limit: 100, resets_at: "2026-10-19T09:30:00Z" },
            monthly: { used: 1, limit: 3000, resets_at: "not a date" },
          },
          ai_credits: { used: 1, limit: 5, next_increase_at: "2026-11-01T00:00:00Z" },
          domains: { used: 1, limit: 3 },
        }),
    });
    const out = await checkTarget(rs, TOKENS, NOW, LEVELS, f);
    const at = (m: string) => out.find((s) => s.metric === m)?.resetsAt;
    expect(at("resend.emails_daily")).toBe("2026-10-19T09:30:00.000Z");
    expect(at("resend.ai_credits")).toBe("2026-11-01T00:00:00.000Z");
    expect(at("resend.emails_monthly")).toBeUndefined();
    expect(at("resend.domains")).toBeUndefined();
  });

  it("resend: unexpected body throws", async () => {
    const { f } = stub({
      "https://api.resend.com/usage": () => Response.json({ name: "restricted_api_key" }),
    });
    await expect(checkTarget(rs, TOKENS, NOW, LEVELS, f)).rejects.toThrow(/unexpected/);
  });

  it("supabase: paused / unhealthy / invisible projects alert as notes; healthy one reports sizes via read-only SQL", async () => {
    const { f, calls } = stub({
      "https://api.supabase.com/v1/projects/aaa/database/query": () =>
        Response.json([{ db: "450000000", storage: 0 }]),
      "https://api.supabase.com/v1/projects": () =>
        Response.json([
          { ref: "aaa", name: "Shop", status: "ACTIVE_HEALTHY" },
          { ref: "bbb", name: "Blog", status: "INACTIVE" },
          { ref: "ccc", status: "RESTORING" },
        ]),
    });
    const out = await checkTarget(sb, TOKENS, NOW, LEVELS, f);
    expect(out.map((s) => [s.metric, s.level])).toEqual([
      ["supabase.aaa.db_bytes", 80],
      ["supabase.aaa.storage_bytes", null],
      ["supabase.bbb.status", 100],
      ["supabase.ccc.status", 100],
      ["supabase.ddd.status", 100],
    ]);
    expect(formatLimitLine(out[2] as never)).toMatch(/Blog \(bbb\) is PAUSED/);
    expect(out[3]?.note).toBe("ccc is RESTORING");
    expect(out[4]?.note).toMatch(/not visible/);
    const sql = calls.find((c) => c.url.endsWith("/database/query"));
    expect(JSON.parse(String(sql?.init.body)).read_only).toBe(true);
    expect(calls).toHaveLength(2); // paused / unhealthy projects get no SQL call
  });

  it("vercel: alerts only when the team is soft-blocked", async () => {
    const ok = stub({
      "https://api.vercel.com/v2/teams/team_1": () => Response.json({ softBlock: null }),
    });
    expect(await checkTarget(vc, TOKENS, NOW, LEVELS, ok.f)).toEqual([]);
    const blocked = stub({
      "https://api.vercel.com/": () =>
        Response.json({ softBlock: { reason: "FAIR_USE_LIMITS_EXCEEDED" } }),
    });
    const [s] = await checkTarget(vc, TOKENS, NOW, LEVELS, blocked.f);
    expect(s?.note).toMatch(/BLOCKED.*FAIR_USE_LIMITS_EXCEEDED/);
  });
});

function env(over: Partial<Env> = {}): Env {
  return {
    USAGE: createFakeD1(),
    PROVIDERS_JSON: JSON.stringify([gh, { ...vc, id: "beta", client: "Beta" }]),
    PROVIDER_TOKENS: JSON.stringify(TOKENS),
    TELEGRAM_BOT_TOKEN: "bot",
    TELEGRAM_CHAT_ID: "-1",
    ...over,
  };
}

describe("runProviders", () => {
  const minutes = (n: number) => ({
    "https://api.github.com/": () =>
      Response.json({
        usageItems: [{ product: "actions", unitType: "minutes", grossQuantity: n }],
      }),
  });

  it("nothing configured → no calls, no error", async () => {
    const { f, calls } = stub({});
    const s = await runProviders(env({ PROVIDERS_JSON: undefined }), NOW, f);
    expect(s.error).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("bad config → error summary, no calls", async () => {
    const { f, calls } = stub({});
    expect((await runProviders(env({ PROVIDER_TOKENS: "nope" }), NOW, f)).error).toBeTruthy();
    expect((await runProviders(env({ LIMIT_LEVELS: "500" }), NOW, f)).error).toMatch(
      /LIMIT_LEVELS/,
    );
    expect(calls).toHaveLength(0);
  });

  it("alerts once per level, isolates a failing target, and re-alerts when a higher level is crossed", async () => {
    const e = env();
    const vercelDown = { "https://api.vercel.com/": () => new Response("", { status: 500 }) };
    const first = stub({ ...minutes(1100), ...vercelDown });
    const s1 = await runProviders(e, NOW, first.f);
    expect(s1).toMatchObject({ limitAlerts: 1, notified: 1 });
    expect(s1.error).toBe("Beta · Vercel: vercel: HTTP 500");
    const msg = JSON.parse(String(first.calls.find((c) => c.url.includes("telegram"))?.init.body))
      .text as string;
    expect(msg).toContain("Acme · GitHub");
    expect(msg).toContain("github.actions_minutes: 1,100 of 2,000 per month (55%)");
    expect(msg).not.toContain("gh-secret");

    // Same level again: no repeat of the limit alert. Vercel has now failed twice in a row, so the one message
    // that does go out is the token alert.
    const again = stub({ ...minutes(1200), ...vercelDown });
    expect((await runProviders(e, NOW, again.f)).notified).toBe(0);
    const sent = (s: ReturnType<typeof stub>) =>
      s.calls
        .filter((c) => c.url.includes("telegram"))
        .map((c) => JSON.parse(String(c.init.body)).text as string);
    expect(sent(again)).toHaveLength(1);
    expect(sent(again)[0]).toContain("keeps failing");
    expect(sent(again)[0]).not.toContain("github.actions_minutes");

    // A higher level alerts again; the token alert is not repeated within a day.
    const higher = stub({ ...minutes(1700), ...vercelDown });
    expect((await runProviders(e, NOW, higher.f)).notified).toBe(1);
    expect(sent(higher)).toHaveLength(1);
    expect(sent(higher)[0]).toContain("github.actions_minutes");
  });

  it("failed notification → not marked, so the next run retries", async () => {
    const e = env({ PROVIDERS_JSON: JSON.stringify([gh]) });
    const down = stub({
      ...minutes(1900),
      "https://api.telegram.org/": () => new Response("", { status: 502 }),
    });
    expect((await runProviders(e, NOW, down.f)).notified).toBe(0);
    const up = stub(minutes(1900));
    expect((await runProviders(e, NOW, up.f)).notified).toBe(1);
  });

  it("stores every reading for the overview page, and a failed check keeps the previous one", async () => {
    const e = env({ PROVIDERS_JSON: JSON.stringify([gh]) });
    await runProviders(e, NOW, stub(minutes(300)).f); // 15% of 2,000: below every alert level
    const first = await loadReadings(e.USAGE);
    expect(first).toMatchObject([
      {
        target: "github:acme",
        metric: "github.actions_minutes",
        used: 300,
        limit: 2000,
        period: "month",
        note: null,
        checkedAt: NOW.toISOString(),
      },
    ]);

    const later = new Date("2026-10-18T11:30:00Z");
    const down = stub({ "https://api.github.com/": () => new Response("", { status: 503 }) });
    expect((await runProviders(e, later, down.f)).error).toContain("HTTP 503");
    expect(await loadReadings(e.USAGE)).toEqual(first); // still the 10:30 reading, so the page can show its age

    await runProviders(e, later, stub(minutes(450)).f);
    expect(await loadReadings(e.USAGE)).toMatchObject([
      { used: 450, checkedAt: later.toISOString() },
    ]);
  });

  it("scheduled() runs providers on PROVIDERS_CRON and the collect otherwise", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = async (cron: string) => {
      const waits: Promise<unknown>[] = [];
      await worker.scheduled({ cron } as ScheduledController, env({ PROVIDERS_JSON: undefined }), {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      } as unknown as ExecutionContext);
      await Promise.all(waits);
      return JSON.parse(String(log.mock.calls.at(-1)?.[0])).event;
    };
    expect(await run(PROVIDERS_CRON)).toBe("providers");
    expect(await run("0 * * * *")).toBe("collect");
    log.mockRestore();
  });
});
