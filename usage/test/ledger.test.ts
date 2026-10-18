import { describe, expect, it } from "vitest";
import { authorized } from "../src/auth";
import type { Env } from "../src/env";
import { buildLedger, labelFor, STALE_AFTER_MS } from "../src/ledger";
import type { LimitStatus } from "../src/limits";
import { saveReadings, upsertRows } from "../src/store";
import { createFakeD1 } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T10:30:00Z");
const ACCT = "0123456789abcdef0123456789abcdef";

function env(over: Partial<Env> = {}): Env {
  return { USAGE: createFakeD1(), CF_API_TOKEN: "t", CF_ACCOUNT_ID: ACCT, ...over };
}

const status = (
  metric: string,
  used: number,
  limit: number,
  over: Partial<LimitStatus> = {},
): LimitStatus => ({
  metric,
  used,
  limit,
  period: "month",
  periodKey: "2026-10",
  pct: (used / limit) * 100,
  level: null,
  ...over,
});

describe("labelFor", () => {
  it("names known meters, Supabase per project, and falls back to a readable name", () => {
    expect(labelFor("workers.requests")).toBe("Workers requests");
    expect(labelFor("github.actions_minutes")).toContain("Actions minutes");
    expect(labelFor("resend.emails_daily")).toBe("Emails per day");
    expect(labelFor("supabase.abc.db_bytes")).toBe("Database size · abc");
    expect(labelFor("supabase.abc.storage_bytes")).toBe("File storage · abc");
    expect(labelFor("resend.automation_runs")).toBe("Automation runs");
    expect(labelFor("plain")).toBe("Plain");
  });
});

describe("buildLedger · Cloudflare", () => {
  it("one account: every limit as a meter (0 when unused), daily vs monthly resets", async () => {
    const e = env({ ACCOUNT_LABELS_JSON: JSON.stringify({ [ACCT]: "Acme" }) });
    await upsertRows(
      e.USAGE,
      [
        { date: "2026-10-18", product: "workers", metric: "requests", dim: "w", value: 4000 },
        { date: "2026-10-02", product: "r2", metric: "class_a", dim: "b", value: 250_000 },
        { date: "2026-10-18", product: "r2", metric: "class_a", dim: "b", value: 50_000 },
        { date: "2026-10-18", product: "mystery", metric: "thing", dim: "x", value: 9 },
      ],
      "2026-10-18T10:00:00Z",
    );
    const { data } = await buildLedger(e, NOW);
    expect(data.generatedAt).toBe("2026-10-18T10:30:00.000Z");
    expect(data.project).toBe("max-free-tier");
    const [cf] = data.providers;
    expect(cf?.name).toBe("Acme · Cloudflare");
    expect(cf?.metrics).toHaveLength(11);
    const m = (k: string) => cf?.metrics.find((x) => x.key === k);
    expect(m("workers.requests")).toMatchObject({
      used: 4000,
      limit: 100_000,
      unit: "count",
      resets: true,
    });
    expect(m("workers.requests")?.period?.start).toBe("2026-10-18T00:00:00.000Z");
    expect(m("workers.requests")?.period?.end).toBe("2026-10-19T00:00:00.000Z");
    expect(m("workers.requests")?.resetsAt).toBe("2026-10-19T00:00:00.000Z"); // next UTC midnight
    expect(m("r2.class_a")?.used).toBe(300_000); // month to date, not just today
    expect(m("r2.class_a")?.period?.start).toBe("2026-10-01T00:00:00.000Z");
    expect(m("r2.class_a")?.period?.end).toBe("2026-11-01T00:00:00.000Z");
    expect(m("r2.class_a")?.resetsAt).toBe("2026-11-01T00:00:00.000Z"); // 1st of next month
    expect(m("kv.read")?.used).toBe(0);
  });

  it("several accounts: separate cards keyed by account; unlabelled single account is plain 'Cloudflare'", async () => {
    const other = "fedcba9876543210fedcba9876543210";
    const e = env({
      CF_ACCOUNT_ID: `${ACCT},${other}`,
      ACCOUNT_LABELS_JSON: JSON.stringify({ [ACCT]: "Acme" }),
      ORG_NAME: " Agency ",
    });
    await upsertRows(
      e.USAGE,
      [{ date: "2026-10-18", product: "kv", metric: "read", dim: "n", value: 7 }],
      "t",
      other,
    );
    const { data } = await buildLedger(e, NOW);
    expect(data.project).toBe("Agency");
    expect(data.providers.map((p) => p.name)).toEqual(["Acme · Cloudflare", "Cloudflare"]);
    expect(new Set(data.providers.map((p) => p.id)).size).toBe(2);
    expect(data.providers[0]?.metrics.find((x) => x.key === "kv.read")?.used).toBe(0);
    expect(data.providers[1]?.metrics.find((x) => x.key === "kv.read")?.used).toBe(7);
  });

  it("no Cloudflare accounts configured → no Cloudflare card; broken JSON settings do not break the page", async () => {
    const none = await buildLedger(env({ CF_ACCOUNT_ID: undefined }), NOW);
    expect(none.data.providers).toEqual([]);
    const broken = await buildLedger(
      env({ LIMITS_JSON: "{", ACCOUNT_LABELS_JSON: "[1]", PROVIDERS_JSON: "nope" }),
      NOW,
    );
    expect(broken.data.providers).toHaveLength(1);
    expect(broken.data.providers[0]?.metrics).toHaveLength(11); // fell back to the free-plan table
    expect(broken.data.providers[0]?.name).toBe("Cloudflare");
  });

  it("LIMITS_JSON overrides apply and 0 removes a meter", async () => {
    const { data } = await buildLedger(env({ LIMITS_JSON: '{"kv.read": 5, "kv.write": 0}' }), NOW);
    const keys = data.providers[0]?.metrics.map((m) => m.key);
    expect(keys).toContain("kv.read");
    expect(keys).not.toContain("kv.write");
    expect(data.providers[0]?.metrics.find((m) => m.key === "kv.read")?.limit).toBe(5);
  });

  it("monthly period rolls over the year", async () => {
    const { data } = await buildLedger(env(), new Date("2026-12-31T23:00:00Z"));
    const r2 = data.providers[0]?.metrics.find((m) => m.key === "r2.class_a");
    expect(r2?.period).toMatchObject({
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("buildLedger · other platforms", () => {
  const targets = JSON.stringify([
    { id: "acme", client: "Acme", kind: "github", token: "T", account: "acme-co" },
    { id: "acme", client: "Acme", kind: "supabase", token: "T", projects: ["abc", "def"] },
    { id: "acme", client: "Acme", kind: "resend", token: "T" },
    { id: "beta", client: "Beta", kind: "vercel", token: "T", account: "team_1" },
  ]);

  it("maps stored readings: units, sizes don't reset, problems become a status, no readings → no card", async () => {
    const e = env({ CF_ACCOUNT_ID: undefined, PROVIDERS_JSON: targets });
    const t = "2026-10-18T10:00:00Z";
    await saveReadings(e.USAGE, "github:acme", [status("github.actions_minutes", 1500, 2000)], t);
    await saveReadings(
      e.USAGE,
      "supabase:acme",
      [
        status("supabase.abc.db_bytes", 450e6, 500e6),
        status("supabase.abc.storage_bytes", 0, 1e9),
        status("supabase.def.status", 1, 1, { note: "Blog (def) is PAUSED", period: "day" }),
      ],
      t,
    );
    await saveReadings(
      e.USAGE,
      "resend:acme",
      [status("resend.emails_daily", 96, 100, { period: "day" })],
      t,
    );

    const { data } = await buildLedger(e, NOW);
    expect(data.providers.map((p) => p.name)).toEqual([
      "Acme · GitHub",
      "Acme · Supabase",
      "Acme · Resend",
    ]);

    const [gh, sb, rs] = data.providers;
    expect(gh?.account).toBe("acme-co");
    expect(gh?.metrics[0]).toMatchObject({
      unit: "minutes",
      used: 1500,
      limit: 2000,
      resets: true,
    });
    expect(gh?.metrics[0]?.note).toBeUndefined();

    expect(sb?.account).toBe("abc, def");
    expect(sb?.metrics.map((m) => m.key)).toEqual([
      "supabase.abc.db_bytes",
      "supabase.abc.storage_bytes",
    ]);
    expect(sb?.metrics[0]).toMatchObject({
      unit: "bytes",
      resets: false,
      confidence: "approximate",
    });
    expect(sb?.metrics[0]?.period).toBeUndefined();
    expect(sb?.status).toEqual({ label: "Alert", value: "Blog (def) is PAUSED" });

    expect(rs?.metrics[0]?.period?.end).toBe("2026-10-19T00:00:00.000Z"); // daily quota
    expect(rs?.metrics[0]?.resetsAt).toBe("2026-10-19T00:00:00.000Z"); // no API time stored → the calendar rule
    expect(sb?.metrics[0]?.resetsAt).toBeUndefined(); // sizes never reset
    expect(rs?.auth).toContain("full-access");
  });

  it("a reset time stored from the platform's API becomes the meter's exact reset; without one the calendar rule applies", async () => {
    const e = env({ CF_ACCOUNT_ID: undefined, PROVIDERS_JSON: targets });
    await saveReadings(
      e.USAGE,
      "resend:acme",
      [
        status("resend.emails_daily", 20, 100, {
          period: "day",
          resetsAt: "2026-10-19T09:30:00.000Z",
        }),
        status("resend.domains", 1, 3),
      ],
      "2026-10-18T10:00:00Z",
    );
    const { data } = await buildLedger(e, NOW);
    const [rs] = data.providers;
    const at = (k: string) => rs?.metrics.find((m) => m.key === k)?.resetsAt;
    expect(at("resend.emails_daily")).toBe("2026-10-19T09:30:00.000Z");
    expect(at("resend.domains")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("a reading older than the stale window carries a note; a fresh one does not", async () => {
    const e = env({ CF_ACCOUNT_ID: undefined, PROVIDERS_JSON: targets });
    const old = new Date(NOW.getTime() - STALE_AFTER_MS - 60_000).toISOString();
    await saveReadings(e.USAGE, "github:acme", [status("github.actions_minutes", 1, 2000)], old);
    const { data } = await buildLedger(e, NOW);
    expect(data.providers[0]?.metrics[0]?.note).toContain(`Last successful check ${old}`);
  });

  it("only-problem target (no numeric meters) still gets a card", async () => {
    const e = env({ CF_ACCOUNT_ID: undefined, PROVIDERS_JSON: targets });
    await saveReadings(
      e.USAGE,
      "vercel:beta",
      [status("vercel.blocked", 1, 1, { note: "account BLOCKED by Vercel" })],
      "2026-10-18T10:00:00Z",
    );
    const { data } = await buildLedger(e, NOW);
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]).toMatchObject({ name: "Beta · Vercel", metrics: [] });
    expect(data.providers[0]?.status?.value).toBe("account BLOCKED by Vercel");
  });

  it("saveReadings replaces the target's whole set", async () => {
    const e = env({ CF_ACCOUNT_ID: undefined, PROVIDERS_JSON: targets });
    await saveReadings(
      e.USAGE,
      "supabase:acme",
      [status("supabase.abc.db_bytes", 1, 500e6), status("supabase.def.db_bytes", 1, 500e6)],
      "2026-10-18T10:00:00Z",
    );
    await saveReadings(
      e.USAGE,
      "supabase:acme",
      [status("supabase.abc.db_bytes", 2, 500e6)],
      "2026-10-18T11:00:00Z",
    );
    const { data } = await buildLedger(e, NOW);
    expect(data.providers[0]?.metrics).toHaveLength(1);
    expect(data.providers[0]?.metrics[0]?.used).toBe(2);
  });
});

describe("authorized", () => {
  const req = (h?: string) =>
    new Request("https://x.test/", h ? { headers: { Authorization: h } } : {});
  const basic = (user: string, pw: string) => `Basic ${btoa(`${user}:${pw}`)}`;
  it("accepts any username with the right password, including one that contains a colon", async () => {
    expect(await authorized(req(basic("stl", "s3cret")), "s3cret")).toBe(true);
    expect(await authorized(req(basic("", "s3cret")), "s3cret")).toBe(true);
    expect(await authorized(req(basic("u", "a:b:c")), "a:b:c")).toBe(true);
  });
  it("rejects wrong, empty, missing and malformed credentials", async () => {
    expect(await authorized(req(basic("stl", "nope")), "s3cret")).toBe(false);
    expect(await authorized(req(basic("stl", "")), "s3cret")).toBe(false);
    expect(await authorized(req(), "s3cret")).toBe(false);
    expect(await authorized(req("Bearer s3cret"), "s3cret")).toBe(false);
    expect(await authorized(req("Basic ***"), "s3cret")).toBe(false);
  });
});
