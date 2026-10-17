# Upstream contributions

We build on two small open-source projects. Changes we need go back to them, so `uptime/` and `usage/` stay close to
upstream and other people benefit.

## usage-guard-collector (HowardZlh) — `usage/`

| Change | Commit here | Status |
|---|---|---|
| Telegram channel (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) | `usage: Telegram alert channel` | Ready; open a Discussion first |
| Watch several accounts (`CF_ACCOUNT_ID` list, `ACCOUNT_LABELS_JSON`; single-account deploys unchanged) | `usage: watch several accounts + …` | Ready; split into its own PR |
| Opt-in free-plan limit alerts (`LIMIT_LEVELS`, `LIMITS_JSON`, cited limits in `src/limits.ts`) | same commit | Ready; split into its own PR |

All 66 original tests pass unchanged; coverage stays above the repo's gate (99.7% lines). Suggested order: Telegram
(smallest), then multi-account, then limits (depends on the account column).

How to send one: fork upstream on GitHub, `git subtree split --prefix usage` (or cherry-pick the files onto a branch
of the fork), open the PR from the fork. Ask in the project's GitHub Discussions before the larger two.

## FlareWatch (saminnet) — `uptime/`

| Finding | Status |
|---|---|
| `apps/status-page/tests/routes/badge*.test.ts` hard-code the demo monitor id `demo_example`, so they fail for every fork with its own config (6 failures with ours). They could import the demo config like `services/worker/tests/config.test.ts` does. | To report as an issue |
