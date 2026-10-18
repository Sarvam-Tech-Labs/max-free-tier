import { describe, expect, it, vi } from "vitest";
import { handleConnectionApi } from "../src/connect";
import { loadConnections, slugOf, withConnections } from "../src/connections";
import type { Env } from "../src/env";
import worker from "../src/index";
import { buildLedger } from "../src/ledger";
import { runProviders } from "../src/run";
import { loadReadings } from "../src/store";
import { listTokens, loadTargetStatus, requiredTokens, tokensOverview } from "../src/tokens";
import { type PageData, renderTokensPage } from "../src/views";
import { createFakeD1 } from "./helpers/fake-d1";

const NOW = new Date("2026-10-18T11:00:00Z");
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const SECRET = "ghp_THIS-IS-A-VERY-SECRET-TOKEN-9z8y";
const registryGh = {
  id: "acme",
  client: "Acme",
  kind: "github",
  token: "GH_ACME",
  account: "acme-co",
};
const registryClients = [
  { id: "acme", name: "Acme", email: "ops@acme.test", status: "live", platforms: ["github"] },
  { id: "beta", name: "Beta Co", email: "beta@beta.test", status: "live", platforms: [] },
];

const base = (over: Partial<Env> = {}): Env => ({
  USAGE: createFakeD1(),
  TOKEN_ENCRYPTION_KEY: KEY,
  PROVIDERS_JSON: JSON.stringify([registryGh]),
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
const newClient = { name: "Octo Traders", email: "Octo@Traders.test" };

describe("POST /api/connections", () => {
  it("a new client: the account is found from the token, nothing else is typed", async () => {
    const e = base();
    const p = platforms();
    const res = await connect(e, { kind: "github", value: SECRET, newClient }, p.f);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(String(body.detail)).toContain("Connected for Octo Traders (octo-trader)");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.tokenName).toBe("GITHUB_OCTO_TRADERS");

    // The GitHub login came from GET /user, and the real check then used it.
    expect(p.calls[0]?.url).toBe("https://api.github.com/user");
    expect(p.calls.some((c) => c.url.includes("/users/octo-trader/settings/billing"))).toBe(true);

    // Stored encrypted; one connection row with the lower-cased email.
    const raw = await e.USAGE.prepare("SELECT * FROM tokens").all<Record<string, string>>();
    expect(JSON.stringify(raw.results)).not.toContain(SECRET);
    expect(await loadConnections(e.USAGE)).toMatchObject([
      {
        kind: "github",
        clientId: "octo-traders",
        clientName: "Octo Traders",
        email: "octo@traders.test",
        account: "octo-trader",
        tokenName: "GITHUB_OCTO_TRADERS",
      },
    ]);
    // Readings and a connected status exist at once.
    expect((await loadReadings(e.USAGE)).map((r) => r.target)).toContain("github:octo-traders");
    expect(await loadTargetStatus(e.USAGE)).toMatchObject([
      { target: "github:octo-traders", token: "GITHUB_OCTO_TRADERS", ok: true },
    ]);
    expect((await listTokens(e.USAGE))[0]).toMatchObject({
      name: "GITHUB_OCTO_TRADERS",
      last4: "9z8y",
    });
  });

  it("the new client and its platform then appear everywhere: ledger, sidebar emails, token list, hourly checks", async () => {
    const e = base();
    await connect(e, { kind: "github", value: SECRET, newClient }, platforms().f);

    const { data } = await buildLedger(e, NOW);
    expect(data.clients.find((c) => c.id === "octo-traders")).toMatchObject({
      name: "Octo Traders",
      email: "octo@traders.test",
    });
    expect(
      data.providers.some((p) => p.clientId === "octo-traders" && p.platform === "github"),
    ).toBe(true);
    expect(data.targets).toContainEqual({
      clientId: "octo-traders",
      platform: "github",
      token: "GITHUB_OCTO_TRADERS",
    });

    const o = await tokensOverview(e);
    expect(o.required.map((r) => r.name)).toEqual(["GH_ACME", "GITHUB_OCTO_TRADERS"]);
    expect(o.connections).toHaveLength(1);

    // The hourly run checks it with the saved token, and keeps checking the registry's own.
    const p = platforms();
    await runProviders(e, new Date("2026-10-18T12:30:00Z"), p.f);
    const urls = p.calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/users/octo-trader/settings/billing"))).toBe(true);
    expect(urls.some((u) => u.includes("/users/acme-co/settings/billing"))).toBe(false); // no GH_ACME token: not set
    const auth = p.calls.find((c) => c.url.includes("octo-trader"))?.init.headers as Record<
      string,
      string
    >;
    expect(auth.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it("an existing client keeps its identity; the connection only adds a platform", async () => {
    const e = base();
    const res = await connect(
      e,
      { kind: "resend", value: "re_abcdefghijkl", clientId: "beta" },
      platforms().f,
    );
    expect(res.status).toBe(200);
    const merged = await withConnections(e);
    const clients = JSON.parse(merged.CLIENTS_JSON as string) as Array<{ id: string }>;
    expect(clients.filter((c) => c.id === "beta")).toHaveLength(1); // not duplicated
    expect(clients).toHaveLength(2);
    const targets = JSON.parse(merged.PROVIDERS_JSON as string) as Array<{
      id: string;
      kind: string;
    }>;
    expect(targets).toContainEqual(
      expect.objectContaining({ id: "beta", kind: "resend", token: "RESEND_BETA" }),
    );
  });

  it("refuses a second connection of the same platform for a client, and one the registry already has", async () => {
    const e = base();
    const p = platforms();
    expect(
      (await connect(e, { kind: "resend", value: "re_abcdefghijkl", clientId: "beta" }, p.f))
        .status,
    ).toBe(200);
    const again = await connect(
      e,
      { kind: "resend", value: "re_zzzzzzzzzzzz", clientId: "beta" },
      p.f,
    );
    expect(again.status).toBe(409);
    expect(String((await json(again)).error)).toContain("Use Replace");
    const reg = await connect(e, { kind: "github", value: SECRET, clientId: "acme" }, p.f);
    expect(reg.status).toBe(409);
    expect(await loadConnections(e.USAGE)).toHaveLength(1);
    expect(await listTokens(e.USAGE)).toHaveLength(1); // the refused token was never saved
  });

  it("a platform that rejects the token: the reason is shown and nothing is saved", async () => {
    const e = base();
    const p = platforms({ github: () => new Response("no", { status: 401 }) });
    const res = await connect(e, { kind: "github", value: SECRET, newClient }, p.f);
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
    const res = await connect(e, { kind: "github", value: SECRET, newClient }, f);
    expect(res.status).toBe(422);
    expect(await loadConnections(e.USAGE)).toEqual([]);
  });

  it("GitHub organization billing: the organization is used as given, without asking GitHub whose token it is", async () => {
    const e = base();
    const p = platforms();
    const res = await connect(
      e,
      { kind: "github", value: SECRET, newClient, org: "octo-org" },
      p.f,
    );
    expect(res.status).toBe(200);
    expect(p.calls.some((c) => c.url === "https://api.github.com/user")).toBe(false);
    expect(p.calls.some((c) => c.url.includes("/organizations/octo-org/settings/billing"))).toBe(
      true,
    );
    expect((await loadConnections(e.USAGE))[0]).toMatchObject({ account: "octo-org", org: true });
    expect(
      (await connect(base(), { kind: "github", value: SECRET, newClient, org: "bad org!" }, p.f))
        .status,
    ).toBe(400);
  });

  it("Vercel: one team is used; several ask which; none explains; a wrong pick is refused", async () => {
    const one = base();
    const ok = await connect(
      one,
      { kind: "vercel", value: "vercel-token-1", newClient },
      platforms().f,
    );
    expect(ok.status).toBe(200);
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
      { kind: "vercel", value: "vercel-token-1", newClient },
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
      { kind: "vercel", value: "vercel-token-1", newClient, team: "team_b" },
      platforms({ teams: many }).f,
    );
    expect(picked.status).toBe(200);
    expect((await loadConnections(e.USAGE))[0]).toMatchObject({ account: "team_b" });
    const wrong = await connect(
      base(),
      { kind: "vercel", value: "vercel-token-1", newClient, team: "team_zzz" },
      platforms({ teams: many }).f,
    );
    expect(wrong.status).toBe(400);

    const none = await connect(
      base(),
      { kind: "vercel", value: "vercel-token-1", newClient },
      platforms({ teams: () => Response.json({ teams: [] }) }).f,
    );
    expect(none.status).toBe(422);
    expect(String((await json(none)).error)).toContain("no team");
    const denied = await connect(
      base(),
      { kind: "vercel", value: "vercel-token-1", newClient },
      platforms({ teams: () => new Response("", { status: 403 }) }).f,
    );
    expect(denied.status).toBe(422);
  });

  it("Supabase: the projects are found from the token (removed ones skipped); none is explained", async () => {
    const e = base();
    expect(
      (await connect(e, { kind: "supabase", value: "sbp_abcdefghijk", newClient }, platforms().f))
        .status,
    ).toBe(200);
    expect((await loadConnections(e.USAGE))[0]).toMatchObject({
      kind: "supabase",
      projects: ["abcd"],
    });
    const none = await connect(
      base(),
      { kind: "supabase", value: "sbp_abcdefghijk", newClient },
      platforms({ projects: () => Response.json([]) }).f,
    );
    expect(none.status).toBe(422);
    expect(String((await json(none)).error)).toContain("no projects");
    const bad = await connect(
      base(),
      { kind: "supabase", value: "sbp_abcdefghijk", newClient },
      platforms({ projects: () => new Response("", { status: 401 }) }).f,
    );
    expect(bad.status).toBe(422);
  });

  it("validates the request before touching any platform", async () => {
    const e = base();
    const p = platforms();
    const status = async (body: unknown) => (await connect(e, body, p.f)).status;
    expect(await status({ value: SECRET, newClient })).toBe(400); // no platform
    expect(await status({ kind: "nope", value: SECRET, newClient })).toBe(400);
    expect(await status({ kind: "github", value: "short", newClient })).toBe(400);
    expect(await status({ kind: "github", value: "has a space in it", newClient })).toBe(400);
    expect(
      await status({ kind: "github", value: SECRET, newClient: { name: "X", email: "a@b.test" } }),
    ).toBe(400);
    expect(
      await status({
        kind: "github",
        value: SECRET,
        newClient: { name: "Octo", email: "not-an-email" },
      }),
    ).toBe(400);
    expect(
      await status({
        kind: "github",
        value: SECRET,
        newClient: { name: "!!!", email: "a@b.test" },
      }),
    ).toBe(400);
    expect(await status({ kind: "github", value: SECRET })).toBe(400); // neither client nor newClient
    expect(await status({ kind: "github", value: SECRET, clientId: "ghost" })).toBe(404);
    expect(await status({ kind: "github", value: SECRET, newClient, expires: "tomorrow" })).toBe(
      400,
    );
    expect(await status({ kind: "github", value: SECRET, newClient, expires: "2020-01-01" })).toBe(
      400,
    );
    expect(p.calls).toHaveLength(0);
  });

  it("an explicit expiry is kept; a second new client with a clashing name gets its own id", async () => {
    const e = base();
    const p = platforms();
    await connect(
      e,
      { kind: "resend", value: "re_abcdefghijkl", newClient, expires: "2027-03-01" },
      p.f,
    );
    expect((await listTokens(e.USAGE))[0]?.expiresAt).toBe("2027-03-01T23:59:59.000Z");
    const second = await json(await connect(e, { kind: "github", value: SECRET, newClient }, p.f));
    expect(second.clientId).toBe("octo-traders-2");
    expect(second.tokenName).toBe("GITHUB_OCTO_TRADERS_2");
  });

  it("refuses without the site header or the encryption key, and wrong methods and paths", async () => {
    const e = base();
    const p = platforms();
    const noHeader = new Request("https://x.test/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "resend", value: "re_abcdefghijkl", newClient }),
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
    await connect(e, { kind: "github", value: SECRET, newClient }, platforms().f);
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
    expect(requiredTokens(await withConnections(e)).map((r) => r.name)).toEqual(["GH_ACME"]);
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

describe("withConnections", () => {
  it("is idempotent, never overrides a registry target, and leaves unreadable registry JSON alone", async () => {
    const e = base();
    await connect(e, { kind: "github", value: SECRET, newClient }, platforms().f);
    await e.USAGE.prepare(
      "INSERT INTO connections (id, kind, client_id, client_name, email, account, org, projects, token_name, created_at) VALUES ('x','github','acme','Acme',NULL,'someone',0,NULL,'GH_OTHER','2026-10-01T00:00:00Z')",
    ).run();
    const once = await withConnections(e);
    const twice = await withConnections(once);
    expect(twice.PROVIDERS_JSON).toBe(once.PROVIDERS_JSON);
    expect(twice.CLIENTS_JSON).toBe(once.CLIENTS_JSON);
    const targets = JSON.parse(once.PROVIDERS_JSON as string) as Array<{
      id: string;
      kind: string;
      account?: string;
    }>;
    expect(targets.filter((t) => t.id === "acme")).toEqual([
      expect.objectContaining({ account: "acme-co" }),
    ]); // registry wins

    const broken = base({ PROVIDERS_JSON: "{not json" });
    await broken.USAGE.prepare(
      "INSERT INTO connections (id, kind, client_id, client_name, email, account, org, projects, token_name, created_at) VALUES ('y','github','n','N',NULL,'n',0,'not json','GH_N','2026-10-01T00:00:00Z')",
    ).run();
    expect((await withConnections(broken)).PROVIDERS_JSON).toBe("{not json");
    expect((await loadConnections(broken.USAGE))[0]?.projects).toEqual([]); // a corrupt list costs only the list
  });

  it("without the table (not migrated yet) the registry alone is used", async () => {
    const e = base();
    await e.USAGE.prepare("DROP TABLE connections").run();
    expect(await withConnections(e)).toBe(e);
  });

  it("names a new client's platforms once even with several connections", async () => {
    const e = base();
    const p = platforms();
    await connect(e, { kind: "github", value: SECRET, newClient }, p.f);
    await connect(e, { kind: "resend", value: "re_abcdefghijkl", clientId: "octo-traders" }, p.f);
    const clients = JSON.parse((await withConnections(e)).CLIENTS_JSON as string) as Array<{
      id: string;
      platforms: string[];
    }>;
    expect(clients.filter((c) => c.id === "octo-traders")).toHaveLength(1);
  });

  it("slugOf keeps letters and digits, joins with dashes, and can come out empty", () => {
    expect(slugOf("  Prasadam (Bhakta Bandhu)! ")).toBe("prasadam-bhakta-bandhu");
    expect(slugOf("---")).toBe("");
    expect(slugOf("A".repeat(60)).length).toBe(40);
  });
});

describe("the Tokens page", () => {
  const dataFor = async (e: Env): Promise<PageData> => ({
    ledger: await buildLedger(e, NOW),
    health: { uptime: { ok: false, monitors: [] } as never, domains: [], now: NOW },
    runs: [],
    alerts: [],
    tz: "Asia/Kolkata",
  });

  it("offers Connect a platform with every client, and marks connected rows with Disconnect", async () => {
    const e = base();
    await connect(e, { kind: "resend", value: "re_abcdefghijkl", newClient }, platforms().f);
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e));
    expect(html).toContain("data-connect-open");
    expect(html).toContain('id="connect-dialog"');
    expect(html).toContain('<option value="beta">Beta Co · beta@beta.test</option>');
    expect(html).toContain(
      '<option value="octo-traders">Octo Traders · octo@traders.test</option>',
    );
    expect(html).toContain('<option value="__new__">A new client…</option>');
    expect(html).toContain('data-kind-help="vercel"');
    expect(html).toContain("On the site");
    expect(html).toContain("data-connection-delete=");
    expect(html).not.toContain('data-token-delete="RESEND_OCTO_TRADERS"'); // Disconnect replaces Delete for a connection
  });

  it("a connection whose token was deleted still shows Add token and Disconnect; names are escaped", async () => {
    const e = base();
    await connect(
      e,
      {
        kind: "resend",
        value: "re_abcdefghijkl",
        newClient: { name: "<b>x</b>y", email: "a@b.test" },
      },
      platforms().f,
    );
    await e.USAGE.prepare("DELETE FROM tokens").run();
    const html = renderTokensPage(await dataFor(e), await tokensOverview(e));
    expect(html).toContain('data-mode="add"');
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("<b>x</b>y");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;y");
  });

  it("with no usage blocks and no connections it says nothing is connected yet", async () => {
    const e = base({ PROVIDERS_JSON: undefined });
    expect(renderTokensPage(await dataFor(e), await tokensOverview(e))).toContain(
      "Nothing is connected yet",
    );
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
    const withHeader = await post({ ...basic, "X-Requested-With": "max-free-tier" });
    expect(withHeader.status).toBe(400); // reached the handler: no platform picked
    const page = await worker.fetch(new Request("https://x.test/tokens", { headers: basic }), e);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect a platform");
  });
});
