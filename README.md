# max-free-tier

**Run every client site on free tiers — and hear about trouble before your client does.**

Free tiers fail silently. When a Cloudflare Worker hits 100,000 requests or D1 hits its daily row limit, things just
stop until 00:00 UTC. Providers also quietly change what "free" includes. `max-free-tier` watches all three for every
site you run, from one config file, and posts to one Telegram chat. It runs entirely on free tiers itself.

| What goes wrong | What max-free-tier does | Built on |
|---|---|---|
| A site is down, slow, returns the wrong page, or its SSL / domain is about to expire | 1-minute HTTP checks with keyword assertions, domain-registration checks, private status page with one group per client | [FlareWatch](https://github.com/saminnet/flarewatch) (MIT), on Cloudflare Workers |
| A Cloudflare free-tier limit is running out (Workers requests, D1 rows, KV, R2, Queues, Durable Objects) | Hourly usage across **all** your clients' Cloudflare accounts with one read-only token; alerts at 50 / 80 / 95 % of each free limit, plus spike detection | [usage-guard-collector](https://github.com/HowardZlh/usage-guard-collector) (MIT) + our multi-account, %-of-limit and Telegram additions (going upstream) |
| GitHub Actions minutes, Resend email quotas or Supabase database / storage running out; a Supabase project paused; Vercel blocking an account | Hourly read-only API checks per client, same 50 / 80 / 95 % alerts; paused / blocked alerts daily until fixed | Endpoints and token scopes from [free-tier-maxxer](https://github.com/alemalvarez/free-tier-maxxer)'s live-verified research (MIT) |
| The free tier itself changes — a limit added, changed or removed | Daily diff of Cloudflare's pricing & limits pages **at their Markdown source** (exact line changes), plus Vercel, Supabase, Resend, Firebase and GitHub Actions pricing | [urlwatch](https://github.com/thp/urlwatch) (BSD), on GitHub Actions |

```
clients.yaml (private repo) ──▶ GitHub Actions ──▶ FlareWatch      (uptime, status page) ─┐
                                               └─▶ usage collector  (free-tier limits)  ──┼─▶ one Telegram chat
watch/urls.yaml ─────────────▶ GitHub Actions ──▶ urlwatch          (free-tier terms)   ──┘
```

## Why

- **One registry, many clients.** Every site's domains, checks, Cloudflare account, repos and platforms live in one
  YAML file. Monitors are generated from it.
- **Your client list stays private.** The registry lives in *your* private repo; deploys read it at run time and the
  generated configs exist only inside the CI run. Nothing client-specific is ever committed here (CI enforces it).
- **Costs nothing.** Cloudflare Workers free plan + GitHub Actions. Read-only analytics access to client accounts.
- **Built from proven open-source parts**, vendored as `git subtree`s so upstream fixes keep flowing in.

## Quick start

1. **Create a private registry repo** with a `clients.yaml` — copy [`clients.example.yaml`](clients.example.yaml) — and
   a 15-line deploy workflow that calls this repo's reusable workflows ([`docs/SETUP.md`](docs/SETUP.md#2-your-private-registry-repo)).
   Deploys run and log only there, so client data never shows up in public Actions logs.
   Validate locally: `pnpm install && node scripts/sync.mjs --registry path/to/clients.yaml --dry-run`.
2. **Make a Telegram bot** (@BotFather) and add it to a group.
3. **Add the secrets** to the private repo (Cloudflare tokens, Telegram) and, recommended, a free Healthchecks.io
   watchdog so you also hear about it when Cloudflare itself is down.
4. **Run `Deploy max-free-tier`** in the private repo. To also get the daily free-tier terms watch, fork this repo and
   add the two Telegram secrets to the fork.

Full walkthrough: [`docs/SETUP.md`](docs/SETUP.md).

## What's watched for free-tier changes

[`watch/urls.yaml`](watch/urls.yaml): Cloudflare Workers pricing & limits, D1, KV, Queues, Workers Logs, Durable Objects,
R2, Workers AI, Pages — plus Vercel limits, Supabase, Resend, Firebase pricing and GitHub Actions billing. PRs adding
more providers are very welcome.

Not covered, because Vercel Hobby and Supabase Free show them only in their logged-in dashboards (no API token can
read them): Vercel bandwidth / requests / invocations, Supabase egress / realtime / edge invocations. Their own
warning emails remain the signal there.

## Related projects

- [free-tier-maxxer](https://github.com/alemalvarez/free-tier-maxxer) — a local dashboard of one person's own free-tier
  usage (GitHub, PostHog, Langfuse, Supabase, Vercel, Resend), including browser-session captures for the numbers above.
  Use it for a single side project; use max-free-tier for many client accounts with unattended alerts.

## Develop

```bash
pnpm install
pnpm sync:example        # validate + render the example registry (what CI runs)
pnpm test                # registry/generator tests
cd usage && pnpm install && pnpm test   # collector tests (upstream coverage gate kept)
```

`uptime/` and `usage/` are `git subtree`s — see [`docs/UPSTREAM.md`](docs/UPSTREAM.md) for pulling updates and the
changes we're contributing back.

## License

MIT © Sarvam Tech Labs. Vendored components keep their own licenses — see [`NOTICE`](NOTICE).
