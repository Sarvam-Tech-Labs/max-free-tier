# Setup

About 20 minutes. You need: a Cloudflare account for the tools to run in (yours), membership in each client's
Cloudflare account (for read-only usage analytics), a GitHub account, and Telegram.

## 1. Telegram
1. **@BotFather** → `/newbot` → copy the **bot token**.
2. Create a group, add your team and the bot, send any message.
3. Get the group's chat id (negative for groups):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat | {id, title}'
   ```

## 2. Your private registry repo
Create a **private** repo (e.g. `your-org/max-free-tier-clients`) containing `clients.yaml` — start from
[`clients.example.yaml`](../clients.example.yaml). Then create a **fine-grained token** with *Contents: Read* on that one
repo only.

Optional, to redeploy automatically when the registry changes: in the registry repo add a workflow that sends
`repository_dispatch` (`event_type: registry-updated`) to your max-free-tier repo, using a token with *Contents: Read and
write* on the max-free-tier repo:
```yaml
on: { push: { branches: [main] } }
jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - run: gh api repos/<owner>/max-free-tier/dispatches -f event_type=registry-updated
        env: { GH_TOKEN: "${{ secrets.MAX_FREE_TIER_DISPATCH_TOKEN }}" }
```

## 3. Cloudflare tokens
- **Deploy token** — My Profile → API Tokens → Custom, scoped to **your** account: Workers Scripts: Edit · Workers KV
  Storage: Edit · D1: Edit · Account Settings: Read · User Details: Read · Memberships: Read.
- **Analytics token** — Custom, **Account Analytics: Read** only, with *Account Resources* including **every client
  account** in your registry. Read-only.
- Your **account id**: Workers & Pages → Account details.

## 4. GitHub variable + secrets (in your max-free-tier repo)
```bash
R=<owner>/max-free-tier
gh variable set REGISTRY_REPO --repo $R --body "<owner>/max-free-tier-clients"
gh secret set REGISTRY_TOKEN        --repo $R   # step 2
gh secret set CLOUDFLARE_API_TOKEN  --repo $R   # deploy token
gh secret set CLOUDFLARE_ACCOUNT_ID --repo $R
gh secret set USAGE_CF_API_TOKEN    --repo $R   # analytics token
gh secret set TELEGRAM_BOT_TOKEN    --repo $R
gh secret set TELEGRAM_CHAT_ID      --repo $R
gh secret set FLAREWATCH_ADMIN_BASIC_AUTH --repo $R   # status page password:
#   cd uptime && npx -y pnpm@12.11.2 install --ignore-scripts && npx -y pnpm@12.11.2 run auth:secret -- <user> '<password>'
```

## 5. Deploy
```bash
gh workflow run "Deploy uptime monitor" --repo $R
gh workflow run "Deploy usage collector" --repo $R
gh workflow run "Free-tier terms watch" --repo $R    # records the baseline; then runs daily
```
The uptime run summary shows the status page URL.

## 6. Protect the usage page
The usage collector's `/` page shows every client account's usage and has **no login of its own**. Put
**Cloudflare Access** in front of it (Zero Trust → Access → Applications → self-hosted, the Worker's hostname; free for
up to 50 users). The FlareWatch status page is private behind its own password.

## 7. Also turn on (no code)
- In each client's Cloudflare account → Notifications: Workers usage notifications. D1 limit emails are automatic.
- Point every platform's usage/billing emails (Vercel, Supabase, Resend, GitHub) at one shared ops inbox.
