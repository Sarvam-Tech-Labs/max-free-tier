import { describe, expect, it, vi } from "vitest";
import { handleConnectionApi } from "../src/connect";
import { loadConnections, slugOf, withConnections } from "../src/connections";
import type { Env } from "../src/env";
import worker from "../src/index";
import { buildLedger } from "../src/ledger";
import { runProviders } from "../src/run";
import { loadReadings } from "../src/store";
import {
  listTokens,
  loadTargetStatus,
  requiredTokens,
  saveTargetStatus,
  tokenAlerts,
  tokensOverview,
} from "../src/tokens";
import { type PageData, renderConsumptionPage, renderTokensPage } from "../src/views";
import { createFakeD1 } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T11:00:00Z");
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const SECRET = "ghp_THIS-IS-A-VERY-SECRET-TOKEN-9z8y";
const OWNER = "octo@traders.test";

// Two projects under one email (ops@acme.test), one under another, one with no email at all.
const client = (id: string, name: string, email: string | undefined, platforms: string[]) => ({
  id,
  name,
  ...(email ? { email } : {}),
  status: "live",
  platforms,
  accounts: [],
  monitors: [],
  domains: [],
});
const registryClients = [
  client("acme", "Acme", "Ops@Acme.test", ["github-actions", "vercel"]),
  client("acme-web", "Acme Web", "ops@acme.test", ["github-actions"]),
  client("beta", "Beta Co", "beta@beta.test", []),
  client("loner", "Loner", undefined, ["github-actions"]),
];
const registryTargets = [
  { id: "acme", client: "Acme", kind: "github", token: "GH_ACME", account: "acme-co" },
  { id: "acme-web", client: "Acme Web", kind: "github", token: "GH_ACME_WEB", account: "acme-co" },
  { id: "loner", client: "Loner", kind: "github", token: "GH_LONER", account: "loner-co" },
];

const base = (over: Partial<Env> = {}): Env => ({
  USAGE: createFakeD1(),
  TOKEN_ENCRYPTION_KEY: KEY,
  PROVIDERS_JSON: JSON.stringify(registryTargets),
  CLIENTS_JSON: JSON.stringify(registryClients),
  DASHBOARD_PASSWORD: "site-pw",
  ...over,
});

interface Stub {
  github?: () => Response; // GET /user
  teams?: () => Response;
  projects?: () => Response;
}
/** Every platform endpoint a connection touches, recording each call. */
function platforms(over: Stub = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url === "https://api.github.com/user")
      return over.github?.() ?? Response.json({ login: "octo-trader" });
    if (url.startsWith("https://api.github.com/"))
      return Response.json(
        { usageItems: [{ product: "actions", unitType: "minutes", grossQuantity: 40 }] },
        { headers: { "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC" } },
      );
    if (url.startsWith("https://api.vercel.com/v2/teams?"))
      return (
        over.teams?.() ??
        Response.json({ teams: [{ id: "team_1", slug: "one", name: "Team One" }] })
      );
    if (url.startsWith("https://api.vercel.com/v2/teams/"))
      return Response.json({ softBlock: null });
    if (url === "https://api.supabase.com/v1/projects")
      return (
        over.projects?.() ??
        Response.json([
          { ref: "abcd", name: "Main", status: "ACTIVE_HEALTHY" },
          { ref: "gone", name: "Old", status: "REMOVED" },
        ])
      );
    if (url === "https://api.supabase.com/v1/projects/abcd/database/query")
      return Response.json([{ db: 1000, storage: 2000 }]);
    if (url === "https://api.resend.com/usage")
      return Response.json({
        object: "usage",
        emails: { daily: { used: 3, limit: 100 }, monthly: { used: 30, limit: 3000 } },
      });
    if (url.startsWith("https://api.telegram.org/")) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 404 });
  });
  return { f: f as unknown as typeof fetch, calls };
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
const connect = (e: Env, body: unknown, f: typeof fetch) =>
  handleConnectionApi(api("/api/connections", "POST", body), e, NOW, f);

type Target = { id: string; client: string; kind: string; token: string; account?: string };
const targetsOf = async (e: Env) =>
  JSON.parse((await withConnections(e)).PROVIDERS_JSON as string) as Target[];
const clientsOf = async (e: Env) =>
  JSON.parse((await withConnections(e)).CLIENTS_JSON as string) as Array<
    ReturnType<typeof client> & { synthetic?: boolean }
  >;

describe("email-first accounts", () => {
  it("registry usage is re-keyed from the project to its email; projects under one email share an account", async () => {
    const t = await targetsOf(base());
    // GH_ACME and GH_ACME_WEB are both GitHub for ops@acme.test (case-insensitive): one account, the first wins.
    expect(t.filter((x) => x.kind === "github" && x.id === "ops@acme.test")).toEqual([
      expect.objectContaining({ token: "GH_ACME", client: "ops@acme.test", account: "acme-co" }),
    ]);
    expect(t.some((x) => x.token === "GH_ACME_WEB")).toBe(false);
    // A project with no email keeps its own identity.
    expect(t.find((x) => x.token === "GH_LONER")).toMatchObject({ id: "loner", client: "Loner" });
    expect(t).toHaveLength(2);
  });

  it("is idempotent and leaves unreadable registry JSON alone; works before the table exists", async () => {
    const e = base();
    const once = await withConnections(e);
    const twice = await withConnections(once);
    expect(twice.PROVIDERS_JSON).toBe(once.PROVIDERS_JSON);
    expect(twice.CLIENTS_JSON).toBe(once.CLIENTS_JSON);
    expect((await withConnections(base({ PROVIDERS_JSON: "{not json" }))).PROVIDERS_JSON).toBe(
      "{not json",
    );
    expect((await withConnections(base({ CLIENTS_JSON: "[" }))).CLIENTS_JSON).toBe("[");
    await e.USAGE.prepare("DROP TABLE email_connections").run();
    expect(await targetsOf(e)).toHaveLength(2); // registry only, no crash
  });

  it("slugOf keeps letters and digits, joins with dashes, and can come out empty", () => {
    expect(slugOf("  Prasadam (Bhakta Bandhu)! ")).toBe("prasadam-bhakta-bandhu");
    expect(slugOf("---")).toBe("");
    expect(slugOf("A".repeat(60)).length).toBe(40);
  });
});

describe("POST /api/connections", () => {
  it("an email and a token: the account is found from the token, nothing else is typed", async () => {
    const e = base();
    const p = platforms();
    const res = await connect(
      e,
      { kind: "github", value: SECRET, email: ` ${OWNER.toUpperCase()} ` },
      p.f,
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(String(body.detail)).toContain(`Connected for ${OWNER} (octo-trader)`);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.tokenName).toBe("GITHUB_OCTO_TRADERS_TEST");

    expect(p.calls[0]?.url).toBe("https://api.github.com/user"); // login from the token
    expect(p.calls.some((c) => c.url.includes("/users/octo-trader/settings/billing"))).toBe(true);

    const raw = await e.USAGE.prepare("SELECT * FROM tokens").all<Record<string, string>>();
    expect(JSON.stringify(raw.results)).not.toContain(SECRET);
    expect(await loadConnections(e.USAGE)).toMatchObject([
      {
        kind: "github",
        email: OWNER,
        account: "octo-trader",
        tokenName: "GITHUB_OCTO_TRADERS_TEST",
      },
    ]);
    expect((await loadReadings(e.USAGE)).map((r) => r.target)).toContain(`github:${OWNER}`);
    expect(await loadTargetStatus(e.USAGE)).toMatchObject([
      { target: `github:${OWNER}`, token: "GITHUB_OCTO_TRADERS_TEST", ok: true },
    ]);
    expect((await listTokens(e.USAGE))[0]).toMatchObject({
      name: "GITHUB_OCTO_TRADERS_TEST",
      last4: "9z8y",
    });
  });

  it("a new email appears in the sidebar and everywhere else, without being shown as a project", async () => {
    const e = base();
    await connect(e, { kind: "github", value: SECRET, email: OWNER }, platforms().f);

    const clients = await clientsOf(e);
    const placeholder = clients.find((c) => c.email === OWNER);
    expect(placeholder).toMatchObject({ synthetic: true, name: OWNER, platforms: ["github"] });
    expect(clients).toHaveLength(registryClients.length + 1);

    const { data } = await buildLedger(e, NOW);
    expect(data.providers.find((p) => p.email === OWNER && p.platform === "github")).toBeTruthy();
    expect(data.targets).toContainEqual({
      clientId: OWNER,
      platform: "github",
      token: "GITHUB_OCTO_TRADERS_TEST",
    });

    const o = await tokensOverview(e);
    expect(o.required.map((r) => r.name)).toContain("GITHUB_OCTO_TRADERS_TEST");
    expect(o.connections).toHaveLength(1);

    // The hourly run checks it with the saved token.
    const p = platforms();
    await runProviders(e, new Date("2026-10-18T12:30:00Z"), p.f);
    const used = p.calls.find((c) => c.url.includes("/users/octo-trader/settings/billing"));
    const auth = (used?.init.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe(`Bearer ${SECRET}`);
  });

  it("an email that already has projects just gains the platform", async () => {
    const e = base();
    expect(
      (
        await connect(
          e,
          { kind: "resend", value: "re_abcdefghijkl", email: "BETA@beta.test" },
          platforms().f,
        )
      ).status,
    ).toBe(200);
    expect((await clientsOf(e)).filter((c) => c.email === "beta@beta.test")).toHaveLength(1); // no placeholder
    expect(await targetsOf(e)).toContainEqual(
      expect.objectContaining({
        id: "beta@beta.test",
        kind: "resend",
        token: "RESEND_BETA_BETA_TEST",
      }),
    );
  });

  it("one account per email and platform: refused whether the registry or an earlier connection has it", async () => {
    const e = base();
    const p = platforms();
    // ops@acme.test already has GitHub from the registry (either of its projects).
    const reg = await connect(e, { kind: "github", value: SECRET, email: "ops@acme.test" }, p.f);
    expect(reg.status).toBe(409);
    expect(String((await json(reg)).error)).toContain("Use Replace");
    expect(
      (await connect(e, { kind: "resend", value: "re_abcdefghijkl", email: OWNER }, p.f)).status,
    ).toBe(200);
    expect(
      (
        await connect(
          e,
          { kind: "resend", value: "re_zzzzzzzzzzzz", email: OWNER.toUpperCase() },
          p.f,
        )
      ).status,
    ).toBe(409);
    expect(await loadConnections(e.USAGE)).toHaveLength(1);
    expect(await listTokens(e.USAGE)).toHaveLength(1); // a refused token is never saved
  });

  it("the same platform for a different email is a separate account", async () => {
    const e = base();
    const p = platforms();
    await connect(e, { kind: "resend", value: "re_abcdefghijkl", email: OWNER }, p.f);
    const other = await connect(
      e,
      { kind: "resend", value: "re_zzzzzzzzzzzz", email: "two@traders.test" },
      p.f,
    );
    expect(other.status).toBe(200);
    expect(await loadConnections(e.USAGE)).toHaveLength(2);
  });

  it("a platform that rejects the token: the reason is shown and nothing is saved", async () => {
    const e = base();
    const res = await connect(
      e,
      { kind: "github", value: SECRET, email: OWNER },
      platforms({ github: () => new Response("no", { status: 401 }) }).f,
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(String(body.error)).toContain("GitHub rejected this token (HTTP 401)");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(await loadConnections(e.USAGE)).toEqual([]);
    expect(await listTokens(e.USAGE)).toEqual([]);
  });

  it("a token that passes discovery but fails the real check is not saved either", async () => {
    const e = base();
    const f = vi.fn(async (url: string) =>
      url === "https://api.github.com/user"
        ? Response.json({ login: "octo" })
        : new Response("", { status: 403 }),
    ) as unknown as typeof fetch;
    expect((await connect(e, { kind: "github", value: SECRET, email: OWNER }, f)).status).toBe(422);
    expect(await loadConnections(e.USAGE)).toEqual([]);
  });

  it("GitHub organization billing: the organization is used as given, without asking whose token it is", async () => {
    const e = base();
    const p = platforms();
    expect(
      (await connect(e, { kind: "github", value: SECRET, email: OWNER, org: "octo-org" }, p.f))
        .status,
    ).toBe(200);
    expect(p.calls.some((c) => c.url === "https://api.github.com/user")).toBe(false);
    expect(p.calls.some((c) => c.url.includes("/organizations/octo-org/settings/billing"))).toBe(
      true,
    );
    expect((await loadConnections(e.USAGE))[0]).toMatchObject({ account: "octo-org", org: true });
    expect(
      (await connect(base(), { kind: "github", value: SECRET, email: OWNER, org: "bad org!" }, p.f))
        .status,
    ).toBe(400);
    const none = await connect(
      base(),
      { kind: "github", value: SECRET, email: OWNER },
      platforms({ github: () => Response.json({}) }).f,
    );
    expect(none.status).toBe(422);
  });

  it("Vercel: one team is used; several ask which; none explains; a wrong pick is refused", async () => {
    const one = base();
    expect(
      (await connect(one, { kind: "vercel", value: "vercel-token-1", email: OWNER }, platforms().f))
        .status,
    ).toBe(200);
    expect((await loadConnections(one.USAGE))[0]).toMatchObject({
      kind: "vercel",
      account: "team_1",
    });

    const many = () =>
      Response.json({
        teams: [
          { id: "team_a", slug: "a", name: "Alpha" },
          { id: "team_b", slug: "b" },
        ],
      });
    const e = base();
    const asked = await connect(
      e,
      { kind: "vercel", value: "vercel-token-1", email: OWNER },
      platforms({ teams: many }).f,
    );
    expect(asked.status).toBe(409);
    expect((await json(asked)).choose).toEqual([
      { id: "team_a", name: "Alpha" },
      { id: "team_b", name: "b" },
    ]);
    expect(await loadConnections(e.USAGE)).toEqual([]);
    const picked = await connect(
      e,
      { kind: "vercel", value: "vercel-token-1", email: OWNER, team: "team_b" },
      platforms({ teams: many }).f,
    );
    expect(picked.status).toBe(200);
    expect((await loadConnections(e.USAGE))[0]).toMatchObject({ account: "team_b" });
    expect(
      (
        await connect(
          base(),
          { kind: "vercel", value: "vercel-token-1", email: OWNER, team: "team_zzz" },
          platforms({ teams: many }).f,
        )
      ).status,
    ).toBe(400);

    const none = await connect(
      base(),
      { kind: "vercel", value: "vercel-token-1", email: OWNER },
      platforms({ teams: () => Response.json({ teams: [] }) }).f,
    );
    expect(none.status).toBe(422);
    expect(String((await json(none)).error)).toContain("no team");
    expect(
      (
        await connect(
          base(),
          { kind: "vercel", value: "vercel-token-1", email: OWNER },
          platforms({ teams: () => new Response("", { status: 403 }) }).f,
        )
      ).status,
    ).toBe(422);
  });

  it("Supabase: the projects are found from the token (removed ones skipped); none is explained", async () => {
    const e = base();
    expect(
      (
        await connect(
          e,
          { kind: "supabase", value: "sbp_abcdefghijk", email: OWNER },
          platforms().f,
        )
      ).status,
    ).toBe(200);
    expect((await loadConnections(e.USAGE))[0]).toMatchObject({
      kind: "supabase",
      projects: ["abcd"],
    });
    const none = await connect(
      base(),
      { kind: "supabase", value: "sbp_abcdefghijk", email: OWNER },
      platforms({ projects: () => Response.json([]) }).f,
    );
    expect(none.status).toBe(422);
    expect(String((await json(none)).error)).toContain("no projects");
    expect(
      (
        await connect(
          base(),
          { kind: "supabase", value: "sbp_abcdefghijk", email: OWNER },
          platforms({ projects: () => new Response("", { status: 401 }) }).f,
        )
      ).status,
    ).toBe(422);
  });

  it("validates the request before touching any platform", async () => {
    const e = base();
    const p = platforms();
    const status = async (body: unknown) => (await connect(e, body, p.f)).status;
    expect(await status({ value: SECRET, email: OWNER })).toBe(400); // no platform
    expect(await status({ kind: "nope", value: SECRET, email: OWNER })).toBe(400);
    expect(await status({ kind: "github", value: SECRET })).toBe(400); // no email
    expect(await status({ kind: "github", value: SECRET, email: "not-an-email" })).toBe(400);
    expect(
      await status({ kind: "github", value: SECRET, email: `${"a".repeat(250)}@b.test` }),
    ).toBe(400);
    expect(await status({ kind: "github", value: "short", email: OWNER })).toBe(400);
    expect(await status({ kind: "github", value: "has a space in it", email: OWNER })).toBe(400);
    expect(await status({ kind: "github", value: SECRET, email: OWNER, expires: "tomorrow" })).toBe(
      400,
    );
    expect(
      await status({ kind: "github", value: SECRET, email: OWNER, expires: "2020-01-01" }),
    ).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  it("an explicit expiry is kept; two emails whose names collide get distinct token names", async () => {
    const e = base();
    const p = platforms();
    await connect(
      e,
      { kind: "resend", value: "re_abcdefghijkl", email: "a.b@x.test", expires: "2027-03-01" },
      p.f,
    );
    expect((await listTokens(e.USAGE))[0]?.expiresAt).toBe("2027-03-01T23:59:59.000Z");
    // "a.b@x.test" and "a_b@x.test" both become RESEND_A_B_X_TEST.
    const second = await json(
      await connect(e, { kind: "resend", value: "re_zzzzzzzzzzzz", email: "a_b@x.test" }, p.f),
    );
    expect(second.tokenName).toBe("RESEND_A_B_X_TEST_2");
  });

  it("refuses without the site header or the encryption key, and wrong methods and paths", async () => {
    const e = base();
    const p = platforms();
    const noHeader = new Request("https://x.test/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "resend", value: "re_abcdefghijkl", email: OWNER }),
    });
    expect((await handleConnectionApi(noHeader, e, NOW, p.f)).status).toBe(403);
    expect(
      (
        await handleConnectionApi(
          api("/api/connections", "POST", {}),
          base({ TOKEN_ENCRYPTION_KEY: undefined }),
          NOW,
          p.f,
        )
      ).status,
    ).toBe(409);
    expect((await handleConnectionApi(api("/api/connections", "GET"), e, NOW, p.f)).status).toBe(
      405,
    );
    expect(
      (await handleConnectionApi(api("/api/connections/a/b", "POST", {}), e, NOW, p.f)).status,
    ).toBe(404);
    const garbage = new Request("https://x.test/api/connections", {
      method: "POST",
      headers: { "X-Requested-With": "max-free-tier", "Content-Type": "application/json" },
      body: "{nope",
    });
    expect((await handleConnectionApi(garbage, e, NOW, p.f)).status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });
});

describe("DELETE /api/connections/ID", () => {
  it("disconnects: the connection, its token and its readings go; the registry's own stays", async () => {
    const e = base();
    await connect(e, { kind: "github", value: SECRET, email: OWNER }, platforms().f);
    const [c] = await loadConnections(e.USAGE);
    const res = await handleConnectionApi(
      api(`/api/connections/${c?.id}`, "DELETE"),
      e,
      NOW,
      platforms().f,
    );
    expect(res.status).toBe(200);
    expect(await loadConnections(e.USAGE)).toEqual([]);
    expect(await listTokens(e.USAGE)).toEqual([]);
    expect(await loadReadings(e.USAGE)).toEqual([]);
    expect(await loadTargetStatus(e.USAGE)).toEqual([]);
    expect(requiredTokens(await withConnections(e)).map((r) => r.name)).toEqual([
      "GH_ACME",
      "GH_LONER",
    ]);
    expect((await clientsOf(e)).some((x) => x.synthetic)).toBe(false); // the placeholder goes with the last connection
    expect(
      (await handleConnectionApi(api(`/api/connections/${c?.id}`, "DELETE"), e, NOW, platforms().f))
        .status,
    ).toBe(404);
    expect(
      (await handleConnectionApi(api("/api/connections/%E0%A4%A", "DELETE"), e, NOW, platforms().f))
        .status,
    ).toBe(400);
  });
});

describe("pages", () => {
  const dataFor = async (e: Env): Promise<PageData> => ({
    ledger: await buildLedger(e, NOW),
    health: { uptime: { ok: false, monitors: [] } as never, domains: [], now: NOW },
    runs: [],
    alerts: [],
    tz: "Asia/Kolkata",
  });

  it("Consumption: an email's platform account is one card, with the projects that use it", async () => {
    const e = base();
    const p = platforms();
    await runProviders(e, NOW, p.f); // no tokens yet: nothing connected
    await e.USAGE.prepare(
      "INSERT INTO tokens (name, ciphertext, iv, last4, created_at, updated_at) VALUES ('GH_ACME','x','y','abcd','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
    ).run();
    const ledger = await buildLedger(e, NOW);
    const html = renderConsumptionPage({ ...(await dataFor(e)), ledger }, "ops@acme.test");
    expect(html).toContain("Used by Acme, Acme Web"); // both projects share the one GitHub account
    expect(html).toContain("Waiting for"); // its token is not saved yet
    expect(html).toContain("GH_ACME");
  });

  it("an email that only has connections is listed without a fake project", async () => {
    const e = base();
    await connect(e, { kind: "resend", value: "re_abcdefghijkl", email: OWNER }, platforms().f);
    const html = renderConsumptionPage(await dataFor(e), OWNER);
    expect(html).toContain(OWNER);
    expect(html).toContain("Emails per day");
    expect(html).not.toContain("Used by");
    expect(html).not.toContain(`<span class="badge">${OWNER}</span>`);
  });

  it("Tokens: Connect a platform asks for an email (with the known ones suggested); connected rows can be disconnected", async () => {
    const e = base();
    await connect(e, { kind: "resend", value: "re_abcdefghijkl", email: OWNER }, platforms().f);
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e), OWNER);
    expect(html).toContain("data-connect-open");
    expect(html).toContain('id="connect-dialog"');
    expect(html).toContain('name="email" type="email" list="c-emails"');
    expect(html).toContain('<option value="beta@beta.test">');
    expect(html).toContain('<option value="ops@acme.test">');
    expect(html).not.toContain("Which client is this for?");
    expect(html).toContain("On the site");
    expect(html).toContain("data-connection-delete=");
    expect(html).not.toContain('data-token-delete="RESEND_OCTO_TRADERS_TEST"'); // Disconnect replaces Delete
  });

  it("Tokens has the Consumption layout: an email sidebar, and one card per platform for the picked email", async () => {
    const e = base();
    const o = await tokensOverview(e);
    const html = renderTokensPage(await dataFor(e), o, "OPS@acme.test");
    // Sidebar of owner emails, linking within the Tokens tab, the picked one marked.
    expect(html).toContain('class="card sidebar"');
    expect(html).toContain('href="/tokens?email=beta%40beta.test"');
    expect(html).toContain('href="/tokens?email=ops%40acme.test" aria-current="page"');
    expect(html).toContain('<div class="e" title="ops@acme.test">');
    // Header card: the email, its projects, and Connect prefilled with it.
    expect(html).toContain("<h1>ops@acme.test</h1>");
    expect(html).toContain('data-connect-open data-email="ops@acme.test"');
    // GitHub: its token, with the projects that share the account.
    expect(html).toContain('aria-label="GitHub"');
    expect(html).toContain("<code>GH_ACME</code>");
    expect(html).toContain("Used by Acme, Acme Web");
    // Vercel is declared by a project but has no token: a card with Connect Vercel prefilled for this email.
    expect(html).toContain('aria-label="Vercel"');
    expect(html).toContain("No Vercel token for this email yet");
    expect(html).toContain('data-kind="vercel" data-email="ops@acme.test"');
    // Another email's platforms are not shown here.
    expect(html).not.toContain("<code>GH_LONER</code>");
    // Switching email shows that one instead.
    const beta = renderTokensPage(await dataFor(e), o, "beta@beta.test");
    expect(beta).toContain("<h1>beta@beta.test</h1>");
    expect(beta).toContain("No platform is on file for this email yet");
    expect(beta).not.toContain("<code>GH_ACME</code>");
  });

  it("the sidebar flags an email whose tokens are missing; the picked default is the first that needs a look", async () => {
    const e = base();
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e));
    expect(html).toContain('class="dot"');
    // ops@acme.test (missing GH_ACME) sorts before nothing worse here: it is chosen when none is asked for.
    expect(html).toMatch(/aria-current="page"/);
  });

  it("a connection whose token was deleted still shows Add token and Disconnect; emails are escaped", async () => {
    const e = base();
    await connect(
      e,
      { kind: "resend", value: "re_abcdefghijkl", email: "x<b>y@z.test" },
      platforms().f,
    ).catch(() => {});
    // An email with markup is not a valid address, so nothing was created; use a valid one and delete its token.
    await connect(e, { kind: "resend", value: "re_abcdefghijkl", email: OWNER }, platforms().f);
    await e.USAGE.prepare("DELETE FROM tokens").run();
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e), OWNER);
    expect(html).toContain('data-mode="add"');
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("x<b>y");
  });

  it("with no usage blocks and no connections, an email with no platforms says so; with no emails at all, nothing is connected", async () => {
    const e = base({ PROVIDERS_JSON: undefined });
    expect(renderTokensPage(await dataFor(e), await tokensOverview(e), "beta@beta.test")).toContain(
      "No platform is on file for this email yet",
    );
    const none = base({ PROVIDERS_JSON: undefined, CLIENTS_JSON: undefined });
    const html = renderTokensPage(await dataFor(none), await tokensOverview(none));
    expect(html).toContain("Nothing is connected yet");
    expect(html).toContain("data-connect-open"); // still a way in, without a sidebar
    expect(html).not.toContain('class="card sidebar"');
  });
});

describe("alerts", () => {
  it("a status recorded under an old per-project key is ignored, not alerted forever", async () => {
    const e = base({ TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "-1" });
    const p = platforms();
    for (let i = 0; i < 3; i++)
      await saveTargetStatus(
        e.USAGE,
        "github:acme",
        "GH_ACME",
        false,
        "old failure",
        NOW.toISOString(),
      );
    expect(await tokenAlerts(await withConnections(e), NOW, p.f)).toEqual([]);
    expect(p.calls.filter((c) => c.url.includes("telegram"))).toHaveLength(0);
    // The same failures under the email key do alert.
    for (let i = 0; i < 3; i++)
      await saveTargetStatus(
        e.USAGE,
        "github:ops@acme.test",
        "GH_ACME",
        false,
        "new failure",
        NOW.toISOString(),
      );
    await tokenAlerts(await withConnections(e), NOW, p.f);
    expect(p.calls.filter((c) => c.url.includes("telegram"))).toHaveLength(1);
  });
});

describe("routing", () => {
  const basic = { Authorization: `Basic ${btoa("x:site-pw")}` };
  it("/api/connections is behind the site password and the same guards; the page is served", async () => {
    const e = base();
    const url = "https://x.test/api/connections";
    const post = (headers: Record<string, string>) =>
      worker.fetch(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: "{}",
        }),
        e,
      );
    expect((await post({})).status).toBe(401);
    expect((await post(basic)).status).toBe(403); // right password, but no site header
    expect((await post({ ...basic, "X-Requested-With": "max-free-tier" })).status).toBe(400); // reached the handler
    const page = await worker.fetch(new Request("https://x.test/tokens", { headers: basic }), e);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect a platform");
  });
});
