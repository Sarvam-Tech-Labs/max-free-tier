# Setup

About 20 minutes. You need: a Cloudflare account for the tools to run in (yours, not a client's — so a client hitting a
limit never takes monitoring down), membership in each client's Cloudflare account (read-only usage analytics), a
GitHub account, and Telegram.

**Deploys run in your private registry repo, never in this public one.** `wrangler deploy` prints the generated config
— client names, account ids — to the log, and anyone can read a public repo's Actions logs. The deploy workflows here
are *reusable*: your private repo calls them, so they run and log there.

## 1. Telegram
1. **@BotFather** → `/newbot` → copy the **bot token**.
2. Create a group, add your team, then add the bot (group → Add members).
3. Get the group's chat id (negative for groups):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[] | (.message // .my_chat_member).chat | {id, title}'
   ```

## 2. Your private registry repo
Create a **private** repo (e.g. `your-org/max-free-tier-clients`) with `clients.yaml` — start from
[`clients.example.yaml`](../clients.example.yaml) — and this `.github/workflows/deploy.yml`:
```yaml
name: Deploy max-free-tier
on:
  push:
    branches: [main]
    paths: [clients.yaml, .github/workflows/deploy.yml]
  schedule:
    - cron: "17 3 * * 1" # weekly: picks up new versions of the tools
  workflow_dispatch:
permissions:
  contents: read
jobs:
  uptime:
    uses: Sarvam-Tech-Labs/max-free-tier/.github/workflows/uptime.yml@main
    secrets: inherit
  usage:
    uses: Sarvam-Tech-Labs/max-free-tier/.github/workflows/usage.yml@main
    secrets: inherit
```
Deploying from a fork: point `uses:` at your fork and pass `with: { tool-repository: <you>/max-free-tier }`.
A deploy takes a few minutes of the private repo's free 2,000 Actions minutes a month.

## 3. Cloudflare tokens
- **Deploy token** — My Profile → API Tokens → Custom, scoped to **your** account: Workers Scripts: Edit · Workers KV
  Storage: Edit · D1: Edit · Account Settings: Read · User Details: Read · Memberships: Read.
- **Analytics token** — Custom, **Account Analytics: Read** only, with *Account Resources* including **every client
  account** in your registry. Read-only.
- Your **account id**: Workers & Pages → Account details.

## 4. Watchdog outside Cloudflare (2 minutes, recommended)
Most client sites run on Cloudflare too, so a Cloudflare outage would silence the monitor exactly when you need it.
Create a free [Healthchecks.io](https://healthchecks.io) check (period 1 minute, grace 5 minutes), connect its Telegram
integration to your group, and put its ping URL in the registry as `org.watchdog`. FlareWatch pings it every minute;
when the pings stop, Healthchecks.io alerts you.

## 5. Secrets — in the PRIVATE registry repo
```bash
R=<owner>/max-free-tier-clients
gh secret set CLOUDFLARE_API_TOKEN  --repo $R   # deploy token
gh secret set CLOUDFLARE_ACCOUNT_ID --repo $R
gh secret set USAGE_CF_API_TOKEN    --repo $R   # analytics token
gh secret set TELEGRAM_BOT_TOKEN    --repo $R
gh secret set TELEGRAM_CHAT_ID      --repo $R
gh secret set FLAREWATCH_ADMIN_BASIC_AUTH --repo $R   # status page password:
#   cd uptime && npx -y pnpm@12.11.2 install --ignore-scripts && npx -y pnpm@12.11.2 run auth:secret -- <user> '<password>'
# Optional — only if the registry has `usage:` blocks (GitHub / Resend / Supabase / Vercel). One JSON object, keys =
# the `token:` names in the registry. Tokens and scopes are listed in clients.example.yaml.
gh secret set PROVIDER_TOKENS --repo $R   # e.g. {"GH_ACME":"github_pat_…","RESEND_ACME":"re_…","SUPABASE":"sbp_…"}
```
The daily free-tier terms watch runs in your copy of *this* repo and holds no client data; it needs only
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set there too.

## 6. Deploy
```bash
gh workflow run "Deploy max-free-tier" --repo <owner>/max-free-tier-clients
gh workflow run "Free-tier terms watch" --repo <owner>/max-free-tier   # records the baseline; then runs daily
```
The uptime job's summary shows the status page URL.

## 7. The overview page (off until you set a password)
`https://max-free-tier-usage.<your-subdomain>.workers.dev/` shows every client against every free limit: what runs out
first, per-meter bars, daily history and projections (adapted from
[free-tier-maxxer](https://github.com/alemalvarez/free-tier-maxxer)). It lists every client's usage, so the Worker
answers **404 until you set the `DASHBOARD_PASSWORD` secret**, then requires it (HTTP Basic, any username):
```bash
gh secret set DASHBOARD_PASSWORD --repo $R   # a long random value; redeploy to apply
```
`/classic` is the original 7-day table with spike detection. No Cloudflare Access / Zero Trust is needed. The FlareWatch
status page is private behind its own password.

## 8. Also turn on (no code)
- In each client's Cloudflare account → Notifications: Workers usage notifications. D1 limit emails are automatic.
- Point every platform's usage/billing emails (Vercel, Supabase, Resend, GitHub) at one shared ops inbox.
