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
# Encrypts tokens pasted on the site's Tokens page. Generate once; keep it (losing it means re-pasting the tokens):
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))' | gh secret set TOKEN_ENCRYPTION_KEY --repo $R
```
The daily free-tier terms watch runs in your copy of *this* repo and holds no client data; it needs only
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set there too.

## 6. Deploy
```bash
gh workflow run "Deploy max-free-tier" --repo <owner>/max-free-tier-clients
gh workflow run "Free-tier terms watch" --repo <owner>/max-free-tier   # records the baseline; then runs daily
```
The uptime engine runs headless (no separate status page, no second login): you look at uptime on the site, below, and
get Telegram alerts. If an earlier version deployed FlareWatch's status page, delete that `flarewatch` Worker and its
`flarewatch-state` KV namespace once: nothing redeploys them.

## 7. The site (off until you set a password)
`https://max-free-tier-usage.<your-subdomain>.workers.dev/` has two tabs. **Free-tier limits** lists every platform's
allowances (filter by platform, category, how it resets) and every change we detect to them. **Consumption** has a
collapsible list of owner emails (the `email:` of each client in the registry); pick one to see its platforms, each
meter's consumption, the exact next reset and how often it resets, plus sites up/down (read live from the uptime Worker
through a service binding, so there is no second login) and domain expiry. Times show in the registry's
`org.timeZone` (IST by default), UTC on hover.

It lists every client's usage, so the Worker answers **404 until you set the `DASHBOARD_PASSWORD` secret**, then requires
it (HTTP Basic, any username). No Cloudflare Access / Zero Trust is needed:
```bash
gh secret set DASHBOARD_PASSWORD --repo $R   # a long random value; redeploy to apply
```
To show the daily free-tier terms watch and limits check in the change history, set the same random `INGEST_TOKEN`
secret in both repos and the repository variable `INGEST_URL`
(`https://max-free-tier-usage.<subdomain>.workers.dev/ingest`) in the repo that runs the terms watch.
`/classic` keeps the original 7-day table with spike detection.

### Connect a platform (GitHub, Resend, Supabase, Vercel) — no registry edit, no redeploy
The model: **an email owns one account per platform; its projects run on those accounts.** Usage is per platform account
(one GitHub account has one Actions-minutes pool however many repos use it), so a token belongs to an email and a platform,
never to a project. A project (a registry client) belongs to an email and lists the platforms it uses.

Open the site's **Tokens** page and click **Connect a platform**. Pick the platform, paste its token, and type the email its
account is registered with (emails you already use are suggested; a new one simply appears in the Consumption sidebar). The
site finds the rest from the token itself: GitHub's login, the Vercel team (it asks which if the token sees several), the
Supabase projects. It then verifies the token against the platform, encrypts it (AES-256-GCM, key = the
`TOKEN_ENCRYPTION_KEY` secret) and shows the platform as connected straight away. Nothing is saved if the check fails. For
GitHub billing on an organization, type the organization's name in the optional field.

On the Consumption tab an email shows one card per platform with its meters, and under it "Used by" the projects that run on
it. A connected row has **Replace**, **Test** and **Disconnect**; Disconnect removes the connection, its token and its
readings. There is one connection per email and platform. Connections live in the site's database next to the registry's own.

### Or name the token in the registry
A client's `usage:` block (see `clients.example.yaml`) names a token, e.g. `token: GH_ACME`. Registry accounts are keyed by the
client's `email:`, so several clients under one email that name the same platform share one account (the first wins; the
others' token names are not needed). A client with no `email:` keeps its own account. The **Tokens** page lists the name as
**Missing**; click **Add token** and paste it. The token is never shown again: the page keeps only the last four characters.
**Replace**, **Test** and **Delete** work on it. If the registry covers an email and platform, a site connection for it is refused.

Telegram warns you when a saved token fails two checks in a row (then at most once a day) or expires within 14 days.
GitHub's expiry is read automatically; for the others enter the date you chose when creating the token.
Anyone with the site password can add, replace or delete tokens but cannot read them, so prefer read-only tokens.
Tokens set the old way (the `PROVIDER_TOKENS` deployment secret) keep working; a pasted token of the same name wins.


## 8. Also turn on (no code)
- In each client's Cloudflare account → Notifications: Workers usage notifications. D1 limit emails are automatic.
- Point every platform's usage/billing emails (Vercel, Supabase, Resend, GitHub) at one shared ops inbox.
