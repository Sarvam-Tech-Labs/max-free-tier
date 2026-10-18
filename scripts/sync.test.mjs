// pnpm test — the registry is the only thing people edit, so its validation and generation are what can break.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientsInfo, DEFAULT_ORG, groups, load, loadOrg, monitors, render, usageConfig } from "./sync.mjs";

const yaml = (body) => `clients:\n${body}`;
const ACCT = "0123456789abcdef0123456789abcdef";

test("rejects bad registries with a clear message", () => {
  assert.throws(() => load("nope: 1"), /`clients` must be a non-empty list/);
  assert.throws(() => load(yaml("  - { id: Bad_Id, name: x, status: live }")), /bad id/);
  assert.throws(() => load(yaml("  - { id: a, name: x, status: live }\n  - { id: a, name: y, status: live }")), /duplicate id a/);
  assert.throws(() => load(yaml("  - { id: a, status: live }")), /has no name/);
  assert.throws(() => load(yaml("  - { id: a, name: x, status: up }")), /status must be/);
  assert.throws(() => load(yaml("  - { id: a, name: x, status: live, cloudflare: { account_id: 123 } }")), /32 hex/);
  assert.throws(() => load(yaml("  - { id: a, name: x, status: live, monitors: [{ id: m, name: M, url: 'http://x' }] }")), /https url/);
  assert.throws(
    () => load(yaml("  - { id: a, name: x, status: live, monitors: [{ id: m, name: M, url: 'https://x' }, { id: m, name: N, url: 'https://y' }] }")),
    /two monitors with id m/,
  );
});

const clients = load(
  yaml(`  - id: acme
    name: Acme
    status: live
    cloudflare: { account_id: "${ACCT}" }
    domains: [acme.in]
    monitors:
      - { id: site, name: Website, url: "https://acme.in", keyword: Acme }
      - { id: short, name: Short, url: "https://a.in", expect: [200, 301] }
  - id: draft
    name: Draft
    status: unconfirmed
    monitors: [{ id: site, name: Site, url: "https://draft.example" }]
  - id: old
    name: Old
    status: paused
    cloudflare: { account_id: "ffffffffffffffffffffffffffffffff" }
`),
);

test("only live clients are monitored; ids are client-prefixed; domains become registration checks", () => {
  const m = monitors(clients);
  assert.deepEqual(
    m.map((x) => x.id),
    ["acme_site", "acme_short", "acme_domain_acme_in"],
  );
  assert.deepEqual(m[0], {
    id: "acme_site",
    name: "Acme · Website",
    method: "GET",
    target: "https://acme.in",
    expectedCodes: [200],
    responseKeyword: "Acme",
    timeout: 10000,
  });
  assert.deepEqual(m[1].expectedCodes, [200, 301]);
  assert.equal(m[1].responseKeyword, undefined);
  assert.deepEqual(m[2], { id: "acme_domain_acme_in", name: "Acme · acme.in registration", method: "DOMAIN", target: "acme.in", domainExpiryDays: 30 });
  assert.deepEqual(groups(clients), { Acme: ["acme_site", "acme_short", "acme_domain_acme_in"] });
});

test("usage config watches every non-paused Cloudflare account, labelled, hourly, limit alerts on", () => {
  const cfg = usageConfig(clients, '{ "compatibility_date": "2026-09-01" }');
  assert.equal(cfg.vars.CF_ACCOUNT_ID, ACCT);
  assert.deepEqual(JSON.parse(cfg.vars.ACCOUNT_LABELS_JSON), { [ACCT]: "Acme" });
  assert.equal(cfg.vars.LIMIT_LEVELS, "50,80,95");
  assert.deepEqual(cfg.triggers.crons, ["0 * * * *"]);
  assert.equal(cfg.compatibility_date, "2026-09-01");
  // The overview page: served from public/ through the Worker (which enforces the password), no preview URLs.
  assert.equal(cfg.preview_urls, false);
  assert.deepEqual(cfg.assets, { directory: "public", binding: "ASSETS", run_worker_first: true, html_handling: "none" });
  assert.equal(cfg.vars.ORG_NAME, "max-free-tier");
  assert.equal(usageConfig(clients, '{ "compatibility_date": "2026-09-01" }', { name: "Acme Agency" }).vars.ORG_NAME, "Acme Agency");
  assert.throws(() => usageConfig(clients, "{}"), /compatibility_date not found/);
});

test("usage: other platforms of live clients become PROVIDERS_JSON + a :30 cron; token names only", () => {
  const reg = load(
    yaml(`  - id: acme
    name: Acme
    status: live
    usage:
      github: { account: acme-co, org: true, token: GH_ACME }
      resend: { token: RESEND_ACME }
      supabase: { projects: [abcdefghij], token: SUPABASE }
  - id: draft
    name: Draft
    status: unconfirmed
    usage: { vercel: { account: team_x, token: VERCEL_DRAFT } }
`),
  );
  const cfg = usageConfig(reg, '{ "compatibility_date": "2026-09-01" }');
  assert.deepEqual(cfg.triggers.crons, ["0 * * * *", "30 * * * *"]);
  assert.deepEqual(JSON.parse(cfg.vars.PROVIDERS_JSON), [
    { id: "acme", client: "Acme", kind: "github", token: "GH_ACME", account: "acme-co", org: true },
    { id: "acme", client: "Acme", kind: "resend", token: "RESEND_ACME" },
    { id: "acme", client: "Acme", kind: "supabase", token: "SUPABASE", projects: ["abcdefghij"] },
  ]);
  assert.equal(usageConfig(clients, '{ "compatibility_date": "2026-09-01" }').vars.PROVIDERS_JSON, undefined);

  const bad = (u) => () => load(yaml(`  - { id: a, name: A, status: live, usage: ${u} }`));
  assert.throws(bad("{ netlify: { token: X } }"), /unknown platform/);
  assert.throws(bad("{ resend: { token: re_live_123 } }"), /must name a key/);
  assert.throws(bad("{ github: { token: GH } }"), /needs account/);
  assert.throws(bad("{ supabase: { token: SB, projects: [] } }"), /project refs/);
});

test("email identifies a client: optional, must look like an email, unique case-insensitively; non-paused clients go to CLIENTS_JSON", () => {
  const bad = (a, b = "") => () => load(yaml(`  - { id: a, name: A, status: live${a} }\n${b}`));
  assert.throws(bad(", email: not-an-email"), /email must be an email address/);
  assert.throws(bad(", email: 42"), /email must be an email address/);
  assert.throws(
    bad(", email: Owner@Acme.in", "  - { id: b, name: B, status: live, email: owner@acme.in }"),
    /used by two clients/,
  );
  const reg = load(
    yaml(`  - { id: a, name: A, status: live, email: Owner@Acme.IN, platforms: [vercel], cloudflare: { account_id: "${ACCT}" } }
  - { id: b, name: B, status: unconfirmed }
  - { id: c, name: C, status: paused, email: c@c.in }
`),
  );
  assert.deepEqual(clientsInfo(reg), [
    { id: "a", name: "A", email: "owner@acme.in", status: "live", platforms: ["vercel"], accounts: [ACCT] },
    { id: "b", name: "B", status: "unconfirmed", platforms: [], accounts: [] },
  ]);
  assert.deepEqual(JSON.parse(usageConfig(reg, '{ "compatibility_date": "2026-09-01" }').vars.CLIENTS_JSON).map((c) => c.id), ["a", "b"]);
});

test("render produces the three generated files with the do-not-edit header", () => {
  const files = render(load(yaml(`  - { id: a, name: A, status: live, monitors: [{ id: s, name: S, url: "https://a.example" }] }`)));
  assert.deepEqual(Object.keys(files).sort(), [
    "uptime/packages/config/src/public.ts",
    "uptime/packages/config/src/worker.ts",
    "usage/wrangler.generated.jsonc",
  ]);
  for (const content of Object.values(files)) assert.match(content, /^\/\/ GENERATED by scripts\/sync\.mjs/);
  assert.match(files["uptime/packages/config/src/public.ts"], /"visibility": "private"/);
});

test("org: optional; names the status page, sets the alert time zone, url must be https", () => {
  assert.deepEqual(loadOrg("clients: []"), DEFAULT_ORG);
  const org = loadOrg("org: { name: Acme Agency, url: https://acme.example, timeZone: Asia/Kolkata }");
  assert.deepEqual(org, { name: "Acme Agency", url: "https://acme.example", timeZone: "Asia/Kolkata" });
  assert.throws(() => loadOrg("org: { url: http://x }"), /https/);
  assert.throws(() => loadOrg("org: [1]"), /mapping/);
  const one = load(yaml("  - { id: a, name: A, status: live }"));
  const files = render(one, org);
  assert.ok(files["uptime/packages/config/src/public.ts"].includes('"title": "Acme Agency — Status"'));
  assert.ok(files["uptime/packages/config/src/public.ts"].includes('"link": "https://acme.example"'));
  assert.ok(files["uptime/packages/config/src/worker.ts"].includes('"timeZone": "Asia/Kolkata"'));
  assert.ok(!render(one)["uptime/packages/config/src/public.ts"].includes('"links"'));
});

test("org.watchdog: optional dead-man ping, monitored every minute in its own group; must be https", () => {
  const one = load(yaml("  - { id: a, name: A, status: live }"));
  assert.ok(!render(one)["uptime/packages/config/src/worker.ts"].includes("watchdog"));
  const files = render(one, loadOrg("org: { name: X, watchdog: https://hc-ping.com/abc }"));
  assert.match(files["uptime/packages/config/src/worker.ts"], /"id": "watchdog",[\s\S]*"target": "https:\/\/hc-ping\.com\/abc"/);
  assert.match(files["uptime/packages/config/src/public.ts"], /"Monitoring": \[\s*"watchdog"\s*\]/);
  assert.throws(() => loadOrg("org: { watchdog: http://x }"), /watchdog must be an https URL/);
});
