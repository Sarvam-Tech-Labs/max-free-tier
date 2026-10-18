# CLAUDE.md — max-free-tier

Agency ops hub for client sites on free tiers. Read `README.md` first. This file is the working guide + runbook.

## Ground rules
- **This repo is public. Client data never goes in it.** The real registry lives in a private repo
  (it calls the reusable deploy workflows here); `clients.yaml` and generated configs are gitignored and CI fails if either is committed.
  Locally, keep the private registry checked out next to this repo (`pnpm sync` reads `../<registry>/clients.yaml` —
  adjust the path in `package.json`) and never commit after running it: `git checkout uptime/packages/config` resets.
- **Deploys never run in this public repo.** `uptime.yml` / `usage.yml` are reusable (`workflow_call`) and run from the
  private registry repo's `deploy.yml` (`secrets: inherit`): wrangler prints vars (client names, account ids) and public
  Actions logs are public. Never add a push/dispatch trigger to them here.
- **No secrets in git.** Tokens live in GitHub Actions secrets, Worker secrets, and (platform tokens) encrypted in D1 via the
  site's Tokens page (`usage/src/tokens.ts`, key = TOKEN_ENCRYPTION_KEY). Never ask the user to paste a token into chat.
- **Connecting a platform is self-service on the site** (Tokens page → Connect a platform: `usage/src/connect.ts`,
  `connections.ts`, table `email_connections`). It needs no registry edit and no deploy, so when the user wants GitHub /
  Resend / Supabase / Vercel connected, point them there rather than adding a `usage:` block. **Data model: the EMAIL is the
  identity.** One account per (email, platform) holds the one token; projects (registry clients) hang off the email and list
  the platforms they use. Never model a token or a meter per project. Registry `usage:` blocks are re-keyed to the client's
  email at read time (`withConnections`) and win over a site connection for the same email and platform.
- **Reuse before building.** FlareWatch and usage-guard-collector are vendored `git subtree`s; urlwatch is installed.
  Fix gaps upstream-first (`docs/UPSTREAM.md`); keep our own code to the registry, generator and glue.
- Client Cloudflare accounts belong to the clients: read-only analytics access only.

## "Something is wrong with <client>"
1. **Find it** in the private registry: platforms, Cloudflare account, repos, `local:` folder. Read that project's docs.
2. **Down or broken?** Status page / Telegram alert text (status code, missing keyword, SSL/domain warning).
   Reproduce: `curl -sS -o /dev/null -w '%{http_code}' <url>`.
3. **Free-tier limit?** The site (usage Worker: `/` Free-tier limits + change history, `/consumption?email=` per owner, `/tokens` connect platforms and paste/test/delete their tokens, `/classic` spikes; needs DASHBOARD_PASSWORD) or its Telegram alert. Cloudflare free limits hard-stop until 00:00 UTC
   (`usage/src/limits.ts` has the cited numbers).
4. **Logs:** Cloudflare → Workers & Pages → the Worker → Logs, or `npx wrangler tail` in the project.
5. **Not on Cloudflare** (Vercel, Supabase, Firebase, Resend, GitHub Actions): clients with a registry `usage:` block
   get hourly alerts (`usage/src/providers.ts`: Actions minutes, Resend quotas, Supabase size + paused, Vercel block);
   otherwise that platform's dashboard/CLI. Supabase free projects pause after a week of inactivity.
   A provider alert run logs `{"event":"providers",…}`; an `error` there names the client + platform + HTTP status
   (401/403 = token or scope wrong, 404 on GitHub = wrong account or not on the enhanced billing platform).

## "The free tier changed" (Telegram diff from the daily terms watch)
1. For Cloudflare the diff is the docs' Markdown source — find the commit in `cloudflare/cloudflare-docs` for context.
2. `scripts/limits-drift.mjs` (daily, job `limits`) compares `FREE_PLAN_LIMITS` with Cloudflare's docs source and posts DRIFT / UNVERIFIABLE to Telegram. If a number we rely on changed: update `usage/src/limits.ts` (`FREE_PLAN_LIMITS`, `LIMITS_AS_OF`) or
   `usage/src/providers.ts` (`PROVIDER_LIMITS`: GitHub minutes, Supabase sizes) and the tests.
3. A new `<Render file="x" product="y"/>` line on a Cloudflare page = a new partial
   (`src/content/partials/y/x.mdx`): add it to `watch/urls.yaml`.

## Gotchas
- FlareWatch pins pnpm v12; its auto-switch is broken on Windows → `npx -y pnpm@12.11.2 …` inside `uptime/`.
  Install with `--ignore-scripts`: its `prepare` script (`vp config`) otherwise sets this repo's `core.hooksPath`
  to `uptime/.vite-hooks/_` (upstream's lint hook, which assumes FlareWatch is the repo root) and blocks every commit.
  Fix: `git config --unset core.hooksPath`.
- FlareWatch's badge tests hard-code the demo monitor ids, so they fail with any real config (reported upstream).

## Layout
- `clients.example.yaml` — registry format. `scripts/sync.mjs` — generator (+ `sync.test.mjs`).
- `uptime/` — FlareWatch. `usage/` — usage-guard-collector + our additions (`cd usage && pnpm test`).
- `watch/urls.yaml` — free-tier terms watch list (urlwatch).
- `.github/workflows/` — `ci.yml`, `uptime.yml`, `usage.yml` (deploys, gated on secrets), `freetier-watch.yml` (daily).
