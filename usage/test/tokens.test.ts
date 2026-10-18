import { describe, expect, it, vi } from "vitest";
import { seal, unseal } from "../src/crypto";
import type { Env } from "../src/env";
import worker from "../src/index";
import { buildLedger } from "../src/ledger";
import { runProviders } from "../src/run";
import { loadReadings, recentAlerts } from "../src/store";
import {
  handleTokenApi,
  listTokens,
  loadManagedTokens,
  loadTargetStatus,
  requiredTokens,
  saveTargetStatus,
  tokenAlerts,
  tokensOverview,
  verifyToken,
} from "../src/tokens";
import { type PageData, renderTokensPage } from "../src/views";
import { createFakeD1 } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T11:00:00Z");
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); // 32 bytes
const SECRET = "ghp_THIS-IS-A-VERY-SECRET-TOKEN-9z8y";
const gh = { id: "acme", client: "Acme", kind: "github", token: "GH_ACME", account: "acme-co" };
const vc = { id: "beta", client: "Beta", kind: "vercel", token: "VERCEL_BETA", account: "team_1" };

const base = (over: Partial<Env> = {}): Env => ({
  USAGE: createFakeD1(),
  TOKEN_ENCRYPTION_KEY: KEY,
  PROVIDERS_JSON: JSON.stringify([gh, vc]),
  DASHBOARD_PASSWORD: "site-pw",
  TELEGRAM_BOT_TOKEN: "bot",
  TELEGRAM_CHAT_ID: "-1",
  ...over,
});

/** Platform stub: GitHub answers with minutes (and an expiry header), Vercel with an unblocked team. */
function platforms(
  over: {
    github?: () => Response;
    vercel?: () => Response;
    telegram?: number;
    githubExpiry?: string;
  } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.startsWith("https://api.github.com/")) {
      return (
        over.github?.() ??
        Response.json(
          { usageItems: [{ product: "actions", unitType: "minutes", grossQuantity: 100 }] },
          {
            headers: {
              "github-authentication-token-expiration":
                over.githubExpiry ?? "2026-11-17 11:07:28 UTC",
            },
          },
        )
      );
    }
    if (url.startsWith("https://api.vercel.com/"))
      return over.vercel?.() ?? Response.json({ softBlock: null });
    if (url.startsWith("https://api.telegram.org/"))
      return new Response("{}", { status: over.telegram ?? 200 });
    return new Response("{}", { status: 404 });
  });
  const sent = () =>
    calls
      .filter((c) => c.url.includes("telegram"))
      .map((c) => JSON.parse(String(c.init.body)).text as string);
  return { f: f as unknown as typeof fetch, calls, sent };
}

const api = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://x.test${path}`, {
    method,
    headers: {
      "X-Requested-With": "max-free-tier",
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
/** The Authorization header a recorded platform call carried. */
const bearerOf = (call: { init: RequestInit } | undefined): string | undefined =>
  (call?.init.headers as Record<string, string> | undefined)?.Authorization;

describe("crypto", () => {
  it("round-trips, uses a fresh IV, and never stores the plaintext", async () => {
    const a = await seal(KEY, "GH_ACME", SECRET);
    const b = await seal(KEY, "GH_ACME", SECRET);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain(SECRET);
    expect(await unseal(KEY, "GH_ACME", a)).toBe(SECRET);
  });
  it("refuses a wrong key, altered data, a different name, and a bad key", async () => {
    const a = await seal(KEY, "GH_ACME", SECRET);
    const other = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");
    await expect(unseal(other, "GH_ACME", a)).rejects.toThrow();
    await expect(unseal(KEY, "GH_OTHER", a)).rejects.toThrow(); // bound to its name
    await expect(
      unseal(KEY, "GH_ACME", { ...a, ciphertext: `${a.ciphertext.slice(0, -4)}AAAA` }),
    ).rejects.toThrow();
    await expect(seal("not base64 !!", "X", "y")).rejects.toThrow(/valid base64/);
    await expect(seal(Buffer.from("short").toString("base64"), "X", "y")).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe("what the registry needs", () => {
  it("groups targets by token name, sorted; flags a name used for two platforms; ignores a broken registry", () => {
    const e = base({
      PROVIDERS_JSON: JSON.stringify([vc, gh, { ...gh, id: "second", client: "Second" }]),
    });
    const req = requiredTokens(e);
    expect(req.map((r) => [r.name, r.kind, r.targets.length, r.mixed])).toEqual([
      ["GH_ACME", "github", 2, false],
      ["VERCEL_BETA", "vercel", 1, false],
    ]);
    const mixed = requiredTokens(
      base({ PROVIDERS_JSON: JSON.stringify([gh, { ...vc, token: "GH_ACME" }]) }),
    );
    expect(mixed[0]?.mixed).toBe(true);
    expect(requiredTokens(base({ PROVIDERS_JSON: "nope" }))).toEqual([]);
  });
});

describe("POST /api/tokens", () => {
  it("verifies, stores ONLY ciphertext, connects the platform immediately, and never echoes the token", async () => {
    const e = base();
    const p = platforms();
    const res = await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      e,
      NOW,
      p.f,
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(String(body.detail)).toContain("GitHub accepted the token: read 3 meters");
    expect(body.expiresAt).toBe("2026-11-17T11:07:28.000Z"); // read from GitHub's header
    expect(JSON.stringify(body)).not.toContain(SECRET);

    // The GitHub call carried the token; nothing else did.
    expect(bearerOf(p.calls[0])).toBe(`Bearer ${SECRET}`);

    // Stored encrypted: no column holds the plaintext.
    const raw = await e.USAGE.prepare("SELECT * FROM tokens").all<Record<string, string>>();
    expect(JSON.stringify(raw.results)).not.toContain(SECRET);
    expect(raw.results[0]?.last4).toBe("9z8y");
    expect(await listTokens(e.USAGE)).toMatchObject([
      { name: "GH_ACME", last4: "9z8y", expiresAt: "2026-11-17T11:07:28.000Z" },
    ]);
    expect((await loadManagedTokens(e)).tokens).toEqual({ GH_ACME: SECRET });

    // Readings and a connected status exist right away: the site shows the platform without waiting an hour.
    const readings = await loadReadings(e.USAGE);
    expect(readings.map((r) => r.metric).sort()).toEqual([
      "github.actions_minutes",
      "github.codespaces_core_hours",
      "github.packages_transfer_bytes",
    ]);
    expect(readings.find((r) => r.metric === "github.actions_minutes")).toMatchObject({
      target: "github:acme",
      used: 100,
    });
    expect(await loadTargetStatus(e.USAGE)).toMatchObject([
      { target: "github:acme", token: "GH_ACME", ok: true },
    ]);
    expect((await recentAlerts(e.USAGE))[0]?.text).toBe("Token GH_ACME saved and verified");
    expect(JSON.stringify(await recentAlerts(e.USAGE))).not.toContain(SECRET);
  });

  it("an explicit expiry wins over none; replacing a token swaps it and clears the old expiry alert", async () => {
    const e = base();
    const p = platforms({ vercel: () => Response.json({ softBlock: null }) });
    const first = await handleTokenApi(
      api("/api/tokens", "POST", {
        name: "VERCEL_BETA",
        value: "vercel-token-1",
        expires: "2027-03-01",
      }),
      e,
      NOW,
      p.f,
    );
    expect(first.status).toBe(200);
    expect((await json(first)).expiresAt).toBe("2027-03-01T23:59:59.000Z");
    expect(
      String(
        (
          await json(
            await handleTokenApi(
              api("/api/tokens", "POST", { name: "VERCEL_BETA", value: "vercel-token-2" }),
              e,
              NOW,
              p.f,
            ),
          )
        ).detail,
      ),
    ).toContain("only the blocked check");
    expect((await loadManagedTokens(e)).tokens.VERCEL_BETA).toBe("vercel-token-2");
    expect((await listTokens(e.USAGE))[0]?.expiresAt).toBeNull(); // replaced without an expiry
  });

  it("a rejected token is not saved and the answer explains it without echoing the token", async () => {
    const e = base();
    const p = platforms({ github: () => new Response("no", { status: 403 }) });
    const res = await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      e,
      NOW,
      p.f,
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("GitHub rejected this token (HTTP 403)");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(await listTokens(e.USAGE)).toEqual([]);
    expect(await loadReadings(e.USAGE)).toEqual([]);
    for (const [status, text] of [
      [404, "could not find"],
      [500, "check failed"],
    ] as const) {
      const r = await handleTokenApi(
        api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
        e,
        NOW,
        platforms({ github: () => new Response("", { status }) }).f,
      );
      expect(String((await json(r)).error)).toContain(text);
    }
  });

  it("validates the request: name, registry membership, value, expiry, JSON", async () => {
    const e = base();
    const p = platforms();
    const post = async (body: unknown) =>
      handleTokenApi(api("/api/tokens", "POST", body), e, NOW, p.f);
    expect((await post({ name: "lowercase", value: SECRET })).status).toBe(400);
    expect((await post({ name: "NOT_IN_REGISTRY", value: SECRET })).status).toBe(404);
    expect((await post({ name: "GH_ACME", value: "short" })).status).toBe(400);
    expect((await post({ name: "GH_ACME", value: "has a space in it" })).status).toBe(400);
    expect((await post({ name: "GH_ACME", value: "x".repeat(5000) })).status).toBe(400);
    expect((await post({ name: "GH_ACME", value: SECRET, expires: "tomorrow" })).status).toBe(400);
    expect((await post({ name: "GH_ACME", value: SECRET, expires: "2020-01-01" })).status).toBe(
      400,
    ); // already passed
    expect((await post({ value: SECRET })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    const notJson = new Request("https://x.test/api/tokens", {
      method: "POST",
      headers: { "X-Requested-With": "max-free-tier", "Content-Type": "application/json" },
      body: "{not json",
    });
    expect((await handleTokenApi(notJson, e, NOW, p.f)).status).toBe(400);
    expect(p.calls).toHaveLength(0); // nothing reached a platform
    const mixed = base({ PROVIDERS_JSON: JSON.stringify([gh, { ...vc, token: "GH_ACME" }]) });
    expect(
      (
        await handleTokenApi(
          api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
          mixed,
          NOW,
          p.f,
        )
      ).status,
    ).toBe(409);
  });

  it("is off without TOKEN_ENCRYPTION_KEY", async () => {
    const res = await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      base({ TOKEN_ENCRYPTION_KEY: undefined }),
      NOW,
      platforms().f,
    );
    expect(res.status).toBe(409);
    expect(String((await json(res)).error)).toContain("TOKEN_ENCRYPTION_KEY");
  });
});

describe("cross-site protection", () => {
  const e = () => base();
  const p = platforms();
  const body = { name: "GH_ACME", value: SECRET };
  it("refuses a request without the custom header (what a cross-site form or fetch would send)", async () => {
    const r = new Request("https://x.test/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await handleTokenApi(r, e(), NOW, p.f)).status).toBe(403);
    const del = new Request("https://x.test/api/tokens/GH_ACME", { method: "DELETE" });
    expect((await handleTokenApi(del, e(), NOW, p.f)).status).toBe(403);
  });
  it("refuses another origin and cross-site fetches even with the header; and non-JSON posts", async () => {
    expect(
      (
        await handleTokenApi(
          api("/api/tokens", "POST", body, { Origin: "https://evil.example" }),
          e(),
          NOW,
          p.f,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleTokenApi(
          api("/api/tokens", "POST", body, { "Sec-Fetch-Site": "cross-site" }),
          e(),
          NOW,
          p.f,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleTokenApi(
          api("/api/tokens", "POST", body, { "Content-Type": "text/plain" }),
          e(),
          NOW,
          p.f,
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handleTokenApi(
          api("/api/tokens", "POST", body, {
            Origin: "https://x.test",
            "Sec-Fetch-Site": "same-origin",
          }),
          e(),
          NOW,
          platforms().f,
        )
      ).status,
    ).toBe(200);
    expect(p.calls).toHaveLength(0);
  });
  it("only through the site password: no password configured → 404, wrong → 401; the page is also protected", async () => {
    const ctx = {} as ExecutionContext;
    const req = (headers: Record<string, string> = {}) =>
      new Request("https://x.test/api/tokens", {
        method: "POST",
        headers: {
          "X-Requested-With": "max-free-tier",
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    expect((await worker.fetch(req(), base({ DASHBOARD_PASSWORD: undefined }), ctx)).status).toBe(
      404,
    );
    expect((await worker.fetch(req(), base(), ctx)).status).toBe(401);
    expect(
      (await worker.fetch(req({ Authorization: `Basic ${btoa("x:wrong")}` }), base(), ctx)).status,
    ).toBe(401);
    expect((await worker.fetch(new Request("https://x.test/tokens"), base(), ctx)).status).toBe(
      401,
    );
    const del = new Request("https://x.test/api/tokens/GH_ACME", {
      method: "DELETE",
      headers: { "X-Requested-With": "max-free-tier" },
    });
    expect((await worker.fetch(del, base(), ctx)).status).toBe(401);
  });
  it("pages carry anti-framing and no-referrer headers", async () => {
    const res = await worker.fetch(
      new Request("https://x.test/tokens", {
        headers: { Authorization: `Basic ${btoa("x:site-pw")}` },
      }),
      base(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("test and delete", () => {
  async function saved() {
    const e = base();
    const p = platforms();
    await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      e,
      NOW,
      p.f,
    );
    return e;
  }
  it("test re-verifies, refreshes status and the reported expiry; a failure is recorded", async () => {
    const e = await saved();
    const ok = await handleTokenApi(
      api("/api/tokens/GH_ACME/test", "POST"),
      e,
      new Date("2026-10-18T12:00:00Z"),
      platforms().f,
    );
    expect(ok.status).toBe(200);
    expect((await loadTargetStatus(e.USAGE))[0]).toMatchObject({
      ok: true,
      checkedAt: "2026-10-18T12:00:00.000Z",
    });
    const bad = await handleTokenApi(
      api("/api/tokens/GH_ACME/test", "POST"),
      e,
      new Date("2026-10-18T13:00:00Z"),
      platforms({ github: () => new Response("", { status: 401 }) }).f,
    );
    expect(bad.status).toBe(422);
    expect((await loadTargetStatus(e.USAGE))[0]).toMatchObject({
      ok: false,
      failCount: 1,
      okAt: "2026-10-18T12:00:00.000Z",
    });
    expect(
      (await handleTokenApi(api("/api/tokens/NOT_IN_REGISTRY/test", "POST"), e, NOW, platforms().f))
        .status,
    ).toBe(404);
    expect(
      (await handleTokenApi(api("/api/tokens/VERCEL_BETA/test", "POST"), e, NOW, platforms().f))
        .status,
    ).toBe(404); // nothing saved under that name
  });
  it("test can also verify a token that only exists in the deployment secret", async () => {
    const e = base({ PROVIDER_TOKENS: JSON.stringify({ GH_ACME: SECRET }) });
    const res = await handleTokenApi(
      api("/api/tokens/GH_ACME/test", "POST"),
      e,
      NOW,
      platforms().f,
    );
    expect(res.status).toBe(200);
  });
  it("delete removes the token, its readings and its status, so the platform reads as not connected again", async () => {
    const e = await saved();
    const res = await handleTokenApi(api("/api/tokens/GH_ACME", "DELETE"), e, NOW, platforms().f);
    expect(res.status).toBe(200);
    expect(await listTokens(e.USAGE)).toEqual([]);
    expect(await loadReadings(e.USAGE)).toEqual([]);
    expect(await loadTargetStatus(e.USAGE)).toEqual([]);
    expect(
      (await handleTokenApi(api("/api/tokens/GH_ACME", "DELETE"), e, NOW, platforms().f)).status,
    ).toBe(404);
    expect(
      (await handleTokenApi(api("/api/tokens/lowercase", "DELETE"), e, NOW, platforms().f)).status,
    ).toBe(400);
  });
  it("odd paths and methods are refused", async () => {
    const e = base();
    const p = platforms();
    expect((await handleTokenApi(api("/api/tokens", "GET"), e, NOW, p.f)).status).toBe(405);
    expect(
      (await handleTokenApi(api("/api/tokens/GH_ACME/other", "POST"), e, NOW, p.f)).status,
    ).toBe(404);
    expect((await handleTokenApi(api("/api/tokens/%E0%A4%A", "POST"), e, NOW, p.f)).status).toBe(
      400,
    ); // broken escape
  });
});

describe("hourly run uses and tracks the tokens", () => {
  it("pasted tokens beat the deployment secret; each outcome is recorded; a missing token is not 'failing'", async () => {
    const e = base({ PROVIDER_TOKENS: JSON.stringify({ GH_ACME: "from-the-secret" }) });
    await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      e,
      NOW,
      platforms().f,
    );
    const p = platforms();
    const s = await runProviders(e, new Date("2026-10-18T12:30:00Z"), p.f);
    expect(bearerOf(p.calls.find((c) => c.url.includes("github")))).toBe(`Bearer ${SECRET}`);
    // A missing token is "not connected yet", not an error of the run (so the site does not show "had errors" for it).
    expect(s.error).toBeUndefined();
    const statuses = await loadTargetStatus(e.USAGE);
    expect(statuses.map((x) => [x.target, x.ok])).toEqual([["github:acme", true]]); // no row for the missing token
    expect((await listTokens(e.USAGE))[0]?.expiresAt).toBe("2026-11-17T11:07:28.000Z"); // GitHub's date kept fresh
  });

  it("a saved token the site cannot decrypt is reported, and the run carries on", async () => {
    const e = base();
    await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      e,
      NOW,
      platforms().f,
    );
    const wrong = {
      ...e,
      TOKEN_ENCRYPTION_KEY: Buffer.from("fedcba9876543210fedcba9876543210").toString("base64"),
    };
    expect((await loadManagedTokens(wrong)).errors[0]).toContain("GH_ACME could not be decrypted");
    expect(
      (await loadManagedTokens({ ...e, TOKEN_ENCRYPTION_KEY: undefined })).errors[0],
    ).toContain("TOKEN_ENCRYPTION_KEY is not set");
    const s = await runProviders(wrong, NOW, platforms().f);
    expect(s.error).toContain("could not be decrypted");
  });

  const far = { githubExpiry: "2027-06-01 00:00:00 UTC" };
  const connectGithub = async (e: Env) =>
    handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      e,
      NOW,
      platforms(far).f,
    );

  it("a rejected token (401/403) alerts on the very first failed check, in plain words, then at most daily", async () => {
    const e = base();
    await connectGithub(e);
    const rejected = () => platforms({ ...far, github: () => new Response("", { status: 401 }) });
    const run = async (iso: string, p = rejected()) => {
      await runProviders(e, new Date(iso), p.f);
      return p.sent();
    };
    const first = await run("2026-10-18T12:30:00Z");
    expect(first).toHaveLength(1); // no waiting for a second failure
    expect(first[0]).toContain("GH_ACME (Acme · GitHub) was rejected: github: HTTP 401");
    expect(first[0]).toContain("probably expired or been revoked");
    expect(first[0]).not.toContain(SECRET);
    expect(await run("2026-10-18T13:30:00Z")).toEqual([]); // cooldown
    expect(await run("2026-10-19T12:31:00Z")).toHaveLength(1); // daily while it lasts
  });

  it("any other failure waits for two runs in a row (one blip is not a dead token); recovery is announced once", async () => {
    const e = base();
    await connectGithub(e);
    const down = () => platforms({ ...far, github: () => new Response("", { status: 503 }) });
    const run = async (iso: string, p = down()) => {
      await runProviders(e, new Date(iso), p.f);
      return p.sent();
    };
    expect(await run("2026-10-18T12:30:00Z")).toEqual([]); // first failure: could be a blip
    const second = await run("2026-10-18T13:30:00Z");
    expect(second).toHaveLength(1);
    expect(second[0]).toContain("GH_ACME (Acme · GitHub) keeps failing");
    expect(second[0]).toContain("last worked 2026-10-18");
    expect(second[0]).not.toContain("rejected");
    expect(await run("2026-10-18T14:30:00Z")).toEqual([]); // cooldown
    expect(await run("2026-10-19T14:31:00Z")).toHaveLength(1);

    // It works again: one "working again" note, counters reset, and the next failure starts counting afresh.
    const back = await run("2026-10-19T15:30:00Z", platforms(far));
    expect(back).toHaveLength(1);
    expect(back[0]).toContain("✅ Working again");
    expect(back[0]).toContain("GH_ACME (Acme · GitHub) is working again");
    expect((await loadTargetStatus(e.USAGE))[0]).toMatchObject({
      ok: true,
      failCount: 0,
      alertedAt: null,
    });
    expect(await run("2026-10-19T16:30:00Z", platforms(far))).toEqual([]); // not repeated
    expect(await run("2026-10-19T17:30:00Z")).toEqual([]); // a fresh blip again waits
    expect(
      (await recentAlerts(e.USAGE)).filter(
        (a) => a.source === "tokens" && a.text.includes("keeps failing"),
      ),
    ).toHaveLength(2);
  });

  it("a token that failed but was never alerted about recovers silently", async () => {
    const e = base();
    await connectGithub(e);
    const blip = platforms({ ...far, github: () => new Response("", { status: 503 }) });
    await runProviders(e, new Date("2026-10-18T12:30:00Z"), blip.f); // one failure: no alert
    const ok = platforms(far);
    await runProviders(e, new Date("2026-10-18T13:30:00Z"), ok.f);
    expect(ok.sent()).toEqual([]);
  });

  it("an undelivered token alert is retried and not marked as sent", async () => {
    const e = base();
    await saveTargetStatus(
      e.USAGE,
      "github:acme",
      "GH_ACME",
      false,
      "github: HTTP 401",
      "2026-10-18T10:00:00Z",
    );
    await saveTargetStatus(
      e.USAGE,
      "github:acme",
      "GH_ACME",
      false,
      "github: HTTP 401",
      "2026-10-18T11:00:00Z",
    );
    expect(await tokenAlerts(e, NOW, platforms({ telegram: 502 }).f)).toEqual([]);
    expect((await loadTargetStatus(e.USAGE))[0]?.alertedAt).toBeNull();
    expect((await recentAlerts(e.USAGE))[0]?.text).toContain("not delivered");
    const p = platforms();
    await tokenAlerts(e, NOW, p.f);
    expect(p.sent()).toHaveLength(1);
    expect((await loadTargetStatus(e.USAGE))[0]?.alertedAt).toBe(NOW.toISOString());
  });

  it("an expiring token is announced once at 30, 14, 7, 3 and 1 days, then daily once expired; a new token resets it", async () => {
    const e = base();
    const p = platforms();
    await handleTokenApi(
      api("/api/tokens", "POST", {
        name: "VERCEL_BETA",
        value: "vercel-token-1",
        expires: "2026-11-15",
      }),
      e,
      NOW,
      p.f,
    );
    await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET, expires: "2027-06-01" }),
      e,
      NOW,
      p.f,
    );
    const at = async (iso: string) => {
      const x = platforms();
      await tokenAlerts(e, new Date(iso), x.f);
      return x.sent();
    };
    // 28 days out: first warning (the 30-day step). The far-away GitHub token is not mentioned.
    const first = await at("2026-10-18T11:00:00Z");
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("VERCEL_BETA expires in 29 days (2026-11-15)");
    expect(first[0]).not.toContain("GH_ACME");
    expect(await at("2026-10-18T20:00:00Z")).toEqual([]); // same step: not again
    expect(await at("2026-10-28T11:00:00Z")).toEqual([]); // 19 days: still the 30-day step
    expect((await at("2026-11-02T11:00:00Z"))[0]).toContain("expires in 14 days"); // the 14-day step
    expect(await at("2026-11-03T11:00:00Z")).toEqual([]);
    expect((await at("2026-11-09T11:00:00Z"))[0]).toContain("expires in 7 days"); // 7
    expect(await at("2026-11-12T11:00:00Z")).toEqual([]); // 4 days left: still the 7-day step
    expect((await at("2026-11-13T11:00:00Z"))[0]).toContain("expires in 3 days"); // the 3-day step
    expect(await at("2026-11-14T11:00:00Z")).toEqual([]); // 2 days: still the 3-day step
    expect((await at("2026-11-15T11:00:00Z"))[0]).toContain("expires in 1 day (2026-11-15)"); // the 1-day step
  });

  it("an expired token is announced on the day it expires and then once a day; replacing it resets everything", async () => {
    const e = base();
    const p = platforms();
    await handleTokenApi(
      api("/api/tokens", "POST", {
        name: "VERCEL_BETA",
        value: "vercel-token-1",
        expires: "2026-10-25",
      }),
      e,
      NOW,
      p.f,
    );
    const at = async (iso: string) => {
      const x = platforms();
      await tokenAlerts(e, new Date(iso), x.f);
      return x.sent();
    };
    expect((await at("2026-10-24T12:00:00Z"))[0]).toContain("expires in 2 days");
    expect((await at("2026-10-26T00:30:00Z"))[0]).toContain("VERCEL_BETA expired on 2026-10-25");
    expect(await at("2026-10-26T12:00:00Z")).toEqual([]); // reminded within the day
    expect((await at("2026-10-27T01:00:00Z"))[0]).toContain("VERCEL_BETA expired on 2026-10-25"); // daily
    // Replacing the token clears the alert marker and the date.
    await handleTokenApi(
      api("/api/tokens", "POST", {
        name: "VERCEL_BETA",
        value: "vercel-token-2",
        expires: "2027-10-01",
      }),
      e,
      NOW,
      p.f,
    );
    expect((await listTokens(e.USAGE)).find((x) => x.name === "VERCEL_BETA")).toMatchObject({
      expiryAlertedAt: null,
      expiresAt: "2027-10-01T23:59:59.000Z",
    });
  });

  it("nothing to say → no message; a broken database is reported, never thrown", async () => {
    const e = base();
    const p = platforms();
    expect(await tokenAlerts(e, NOW, p.f)).toEqual([]);
    expect(p.sent()).toEqual([]);
    const broken = {
      ...e,
      USAGE: {
        prepare: () => {
          throw new Error("db down");
        },
      } as unknown as D1Database,
    };
    expect((await tokenAlerts(broken, NOW, p.f))[0]).toBe("token alerts: db down");
  });
});

describe("verifyToken", () => {
  it("reports blocked accounts and plans with nothing to measure in plain words", async () => {
    const req = requiredTokens(base())[1]; // VERCEL_BETA
    if (!req) throw new Error("fixture");
    const blocked = await verifyToken(
      req,
      "vercel-token-1",
      NOW,
      platforms({ vercel: () => Response.json({ softBlock: { reason: "FAIR_USE" } }) }).f,
    );
    expect(blocked.ok).toBe(true);
    const plain = await verifyToken(req, "vercel-token-1", NOW, platforms().f);
    expect(plain).toMatchObject({ ok: true, meters: 0 });
  });
});

describe("a platform with a recorded check is connected on the site", () => {
  it("Vercel Hobby (nothing to measure) shows as connected; a failing token shows its error", async () => {
    const e = base();
    await saveTargetStatus(e.USAGE, "vercel:beta", "VERCEL_BETA", true, null, NOW.toISOString());
    let { data } = await buildLedger(e, NOW);
    expect(data.providers).toMatchObject([{ platform: "vercel", clientId: "beta", metrics: [] }]);
    expect(data.providers[0]?.status).toBeUndefined();
    await saveTargetStatus(
      e.USAGE,
      "vercel:beta",
      "VERCEL_BETA",
      false,
      "vercel: HTTP 401",
      NOW.toISOString(),
    );
    ({ data } = await buildLedger(e, NOW));
    expect(data.providers[0]?.status?.value).toBe("Latest check failed: vercel: HTTP 401");
    expect(data.targets).toEqual([
      { clientId: "acme", platform: "github", token: "GH_ACME" },
      { clientId: "beta", platform: "vercel", token: "VERCEL_BETA" },
    ]);
  });
});

describe("Tokens page", () => {
  const dataFor = async (e: Env): Promise<PageData> => ({
    ledger: await buildLedger(e, NOW),
    health: { uptime: null, domains: [], now: NOW },
    runs: [],
    alerts: [],
    tz: "Asia/Kolkata",
  });

  it("lists what the registry needs with status, expiry and the right actions; never shows a token", async () => {
    const e = base();
    const p = platforms();
    await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET }),
      e,
      NOW,
      p.f,
    );
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e));
    expect(html).toContain("Connect a platform");
    expect(html).toContain("Not linked to an email"); // this registry fixture has no clients, so no sidebar
    expect(html).toContain("<code>GH_ACME</code>");
    expect(html).toContain("ends …9z8y");
    expect(html).not.toContain(SECRET);
    expect(html).toContain("Working"); // verified at save
    expect(html).toContain("Missing"); // VERCEL_BETA has no token yet
    expect(html).toContain('data-token-open="VERCEL_BETA" data-mode="add"');
    expect(html).toContain('data-token-open="GH_ACME" data-mode="replace"');
    expect(html).toContain('data-token-test="GH_ACME"');
    expect(html).toContain('data-token-delete="GH_ACME"');
    expect(html).not.toContain('data-token-delete="VERCEL_BETA"');
    expect(html).toContain("17 Nov 2026"); // GitHub's expiry, in IST
    expect(html).toContain('template data-help-for="VERCEL_BETA"');
    expect(html).toContain("https://vercel.com/account/tokens");
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("How tokens are kept");
    expect(html).toContain('aria-current="page"><svg'); // the Tokens link in the navbar is current
    expect(html).not.toContain("Token storage is not enabled");
  });

  it("failing, expiring and secret-only tokens are distinct; other saved tokens can be deleted", async () => {
    const e = base({ PROVIDER_TOKENS: JSON.stringify({ VERCEL_BETA: "from-the-secret" }) });
    await handleTokenApi(
      api("/api/tokens", "POST", { name: "GH_ACME", value: SECRET, expires: "2026-10-25" }),
      e,
      NOW,
      platforms().f,
    );
    await saveTargetStatus(
      e.USAGE,
      "github:acme",
      "GH_ACME",
      false,
      "github: HTTP 401 <b>",
      NOW.toISOString(),
    );
    // A saved token no client uses any more.
    await e.USAGE.prepare(
      "INSERT INTO tokens (name, ciphertext, iv, last4, created_at, updated_at) VALUES ('OLD_ONE','x','y','abcd','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
    ).run();
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e));
    expect(html).toContain("Failing");
    expect(html).toContain("github: HTTP 401 &lt;b&gt;"); // escaped
    expect(html).not.toContain("HTTP 401 <b>");
    expect(html).toContain("Expires in 7 days");
    expect(html).toContain("from the deployment secret");
    expect(html).not.toContain('data-token-delete="VERCEL_BETA"'); // it lives in the deployment secret: not deletable here
    expect(html).toContain("Other saved tokens");
    expect(html).toContain("<code>OLD_ONE</code>");
    expect(html).toContain('data-token-delete="OLD_ONE"');
  });

  it("without the encryption key every action is disabled and the page says why", async () => {
    const e = base({ TOKEN_ENCRYPTION_KEY: undefined });
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e));
    expect(html).toContain("Token storage is not enabled");
    expect(html).toContain('disabled title="Set the TOKEN_ENCRYPTION_KEY secret first"');
  });

  it("nothing in the registry needs a token → says so; names are escaped", async () => {
    const empty = base({ PROVIDERS_JSON: undefined });
    expect(renderTokensPage(await dataFor(empty), await tokensOverview(empty))).toContain(
      "Nothing is connected yet",
    );
    const evil = base({ PROVIDERS_JSON: JSON.stringify([{ ...gh, client: "<img src=x>" }]) });
    const html = renderTokensPage(await dataFor(evil), await tokensOverview(evil));
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
  });
});
