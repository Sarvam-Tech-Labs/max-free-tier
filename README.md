# max-free-tier

**Run every client site on free tiers — and hear about trouble before your client does.**

Free tiers fail silently. When a Cloudflare Worker hits 100,000 requests or D1 hits its daily row limit, things just
stop until 00:00 UTC. Providers also quietly change what "free" includes. `max-free-tier` watches all three for every
site you run, from one config file, and posts to one Telegram chat. It runs entirely on free tiers itself.

| What goes wrong | What max-free-tier does | Built on |
|---|---|---|
| A site is down, slow, returns the wrong page, or its SSL / domain is about to expire | 1-minute HTTP checks with keyword assertions, domain-registration checks, private status page with one group per client | [FlareWatch](https://github.com/saminnet/flarewatch) (MIT), on Cloudflare Workers |
| A Cloudflare free-tier limit is running out (Workers requests, D1 rows, KV, R2, Queues, Durable Objects) | Hourly usage across **all** your clients' Cloudflare accounts with one read-only token; alerts at 50 / 80 / 95 % of each free limit, plus spike detection | [usage-guard-collector](https://github.com/HowardZlh/usage-guard-collector) (MIT) + our multi-account, %-of-limit and Telegram additions (going upstream) |
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

1. **Use this repo** — fork it (or "Use this template").
2. **Create a private registry repo** with a `clients.yaml` — copy [`clients.example.yaml`](clients.example.yaml).
   Validate locally: `pnpm install && node scripts/sync.mjs --registry path/to/clients.yaml --dry-run`.
3. **Make a Telegram bot** (@BotFather) and add it to a group.
4. **Add the variable and secrets** listed in [`docs/SETUP.md`](docs/SETUP.md) (Cloudflare tokens, Telegram, registry).
5. **Run the deploy workflows** — `Deploy uptime monitor` and `Deploy usage collector`. The free-tier terms watch runs
   daily on its own.

Full walkthrough: [`docs/SETUP.md`](docs/SETUP.md).

## What's watched for free-tier changes

[`watch/urls.yaml`](watch/urls.yaml): Cloudflare Workers pricing & limits, D1, KV, Queues, Workers Logs, Durable Objects,
R2, Workers AI, Pages — plus Vercel limits, Supabase, Resend, Firebase pricing and GitHub Actions billing. PRs adding
more providers are very welcome.

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
