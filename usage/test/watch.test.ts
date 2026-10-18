import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkTarget, type ProviderTarget, type TokenInfo } from "../src/providers";
import { runCollect, runProviders } from "../src/run";
import { recentAlerts, recordRun } from "../src/store";
import { requiredTokens, verifyToken } from "../src/tokens";
import { alertIfStale, STALE_RUN_MS } from "../src/watchdog";
import { createFakeD1 } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const vc: ProviderTarget = {
  id: "beta",
  client: "Beta",
  kind: "vercel",
  token: "VT",
  account: "team_1",
};

/** Telegram plus Vercel: the team record and, optionally, the token's own record. */
function stub(over: { meta?: () => Response; team?: () => Response; telegram?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.startsWith("https://api.telegram.org/"))
      return new Response("{}", { status: over.telegram ?? 200 });
    if (url === "https://api.vercel.com/v5/user/tokens/current")
      return over.meta?.() ?? new Response("{}", { status: 404 });
    if (url.startsWith("https://api.vercel.com/v2/teams/"))
      return over.team?.() ?? Response.json({ softBlock: null });
    return new Response("{}", { status: 404 });
  });
  const sent = () =>
    calls
      .filter((c) => c.url.includes("telegram"))
      .map((c) => JSON.parse(String(c.init.body)).text as string);
  return { f: f as unknown as typeof fetch, calls, sent };
}

const env = (over: Partial<Env> = {}): Env => ({
  USAGE: createFakeD1(),
  TELEGRAM_BOT_TOKEN: "bot",
  TELEGRAM_CHAT_ID: "-1",
  ...over,
});

describe("Vercel reports its own token's expiry and whether it leaked", () => {
  it("reads the expiry (a number or a numeric string), and a leak becomes a loud problem", async () => {
    const info: TokenInfo = {};
    const ok = stub({
      meta: () => Response.json({ token: { expiresAt: Date.parse("2027-01-31T10:00:00Z") } }),
    });
    expect(await checkTarget(vc, { VT: "x" }, NOW, [50], ok.f, info)).toEqual([]);
    expect(info.expiresAt).toBe("2027-01-31T10:00:00.000Z");
    expect(ok.calls.map((c) => c.url)).toContain("https://api.vercel.com/v5/user/tokens/current");

    const asString: TokenInfo = {};
    await checkTarget(
      vc,
      { VT: "x" },
      NOW,
      [50],
      stub({ meta: () => Response.json({ token: { expiresAt: "1798761600000" } }) }).f,
      asString,
    );
    expect(asString.expiresAt).toBe("2027-01-01T00:00:00.000Z"); // 1798761600000 ms, given as a string

    const leaked = await checkTarget(
      vc,
      { VT: "x" },
      NOW,
      [50],
      stub({ meta: () => Response.json({ token: { leakedAt: 1760000000000 } }) }).f,
    );
    expect(leaked).toMatchObject([{ metric: "vercel.token_leaked", level: 100 }]);
    expect(leaked[0]?.note).toContain("LEAKED");
    expect(leaked[0]?.note).toContain("revoke it");
  });

  it("a token that cannot read its own record still checks fine (no date, no failure); a block is still reported", async () => {
    const info: TokenInfo = {};
    expect(await checkTarget(vc, { VT: "x" }, NOW, [50], stub().f, info)).toEqual([]);
    expect(info.expiresAt).toBeUndefined();
    const none: TokenInfo = {};
    await checkTarget(
      vc,
      { VT: "x" },
      NOW,
      [50],
      stub({ meta: () => Response.json({ token: {} }) }).f,
      none,
    );
    expect(none.expiresAt).toBeUndefined();
    const blockedAndLeaked = await checkTarget(
      vc,
      { VT: "x" },
      NOW,
      [50],
      stub({
        meta: () => Response.json({ token: { leakedAt: 1 } }),
        team: () => Response.json({ softBlock: { reason: "overage" } }),
      }).f,
    );
    expect(blockedAndLeaked.map((s) => s.metric).sort()).toEqual([
      "vercel.blocked",
      "vercel.token_leaked",
    ]);
  });

  it("connecting a Vercel token fills in its expiry from Vercel, so nobody types it", async () => {
    const e = env({ PROVIDERS_JSON: JSON.stringify([vc]) });
    const req = requiredTokens(e)[0];
    if (!req) throw new Error("fixture");
    const v = await verifyToken(
      req,
      "vercel-token-1",
      NOW,
      stub({
        meta: () => Response.json({ token: { expiresAt: Date.parse("2027-02-01T00:00:00Z") } }),
      }).f,
    );
    expect(v).toMatchObject({ ok: true, expiresAt: "2027-02-01T00:00:00.000Z" });
  });
});

describe("the hourly checks watch each other", () => {
  it("says nothing when the other run never happened or is on time", async () => {
    const e = env();
    const p = stub();
    expect(await alertIfStale(e, NOW, p.f, "providers", "platform check")).toEqual([]);
    await recordRun(e.USAGE, "providers", true, "ok", hoursAgo(1));
    expect(await alertIfStale(e, NOW, p.f, "providers", "platform check")).toEqual([]);
    await recordRun(
      e.USAGE,
      "providers",
      true,
      "ok",
      new Date(NOW.getTime() - STALE_RUN_MS).toISOString(),
    );
    expect(await alertIfStale(e, NOW, p.f, "providers", "platform check")).toEqual([]); // exactly at the limit
    expect(p.sent()).toEqual([]);
  });

  it("warns once when it is more than 3 hours overdue, again only after a day, and retries an undelivered warning", async () => {
    const e = env();
    await recordRun(e.USAGE, "providers", true, "ok", hoursAgo(4));
    const lost = stub({ telegram: 502 });
    expect(await alertIfStale(e, NOW, lost.f, "providers", "platform check")).toEqual([]);
    expect((await recentAlerts(e.USAGE)).filter((a) => a.source === "stale:providers")).toEqual([]); // not logged: undelivered

    const p = stub();
    expect(await alertIfStale(e, NOW, p.f, "providers", "platform check")).toEqual([]);
    expect(p.sent()).toHaveLength(1);
    expect(p.sent()[0]).toContain("⚠️ The hourly platform check has not run for 4 hours");
    expect(p.sent()[0]).toContain("last run 2026-10-18 08:00 UTC");

    const again = stub();
    await alertIfStale(
      e,
      new Date(NOW.getTime() + 3_600_000),
      again.f,
      "providers",
      "platform check",
    );
    expect(again.sent()).toEqual([]); // within the day

    const nextDay = stub();
    await alertIfStale(
      e,
      new Date(NOW.getTime() + 25 * 3_600_000),
      nextDay.f,
      "providers",
      "platform check",
    );
    expect(nextDay.sent()).toHaveLength(1);
    // The two runs are tracked separately.
    const other = stub();
    await recordRun(e.USAGE, "collect", true, "ok", hoursAgo(5));
    await alertIfStale(e, NOW, other.f, "collect", "Cloudflare usage check");
    expect(other.sent()[0]).toContain("Cloudflare usage check has not run for 5 hours");
  });

  it("a broken database is reported, never thrown", async () => {
    const broken = env({
      USAGE: {
        prepare: () => {
          throw new Error("db down");
        },
      } as unknown as D1Database,
    });
    expect((await alertIfStale(broken, NOW, stub().f, "collect", "x"))[0]).toBe(
      "stale-run check: db down",
    );
  });

  it("runProviders warns about a quiet collect run, and runCollect about a quiet platform run (even unconfigured)", async () => {
    const e = env();
    await recordRun(e.USAGE, "collect", true, "ok", hoursAgo(6));
    const a = stub();
    await runProviders(e, NOW, a.f);
    expect(a.sent().some((t) => t.includes("Cloudflare usage check has not run for 6 hours"))).toBe(
      true,
    );

    const e2 = env(); // no CF_API_TOKEN: the run records its misconfiguration, but still looks at the other one
    await recordRun(e2.USAGE, "providers", true, "ok", hoursAgo(7));
    const b = stub();
    const summary = await runCollect(e2, NOW, b.f);
    expect(summary.error).toContain("CF_API_TOKEN / CF_ACCOUNT_ID not set");
    expect(
      b
        .sent()
        .some((t) =>
          t.includes("platform check (GitHub, Vercel, Resend, Supabase) has not run for 7 hours"),
        ),
    ).toBe(true);
  });
});
