/**
 * What each platform's free tier includes, for the by-platform page. `match` ties an allowance to the meter the collector
 * tracks (matched against the meter key); no `match` = listed for reference only, with `why` saying why it is not
 * tracked. Cloudflare's tracked numbers come from FREE_PLAN_LIMITS (one source of truth, compared with Cloudflare's docs
 * every day by scripts/limits-drift.mjs).
 *
 * Provenance matters: "asOf" and "verified" say how each number was obtained. Anything not read from the platform's own
 * docs by us is attributed to free-tier-maxxer's research (https://github.com/alemalvarez/free-tier-maxxer, MIT).
 */
import { labelFor, type Platform } from "./ledger";
import { FREE_PLAN_LIMITS, LIMITS_AS_OF } from "./limits";

export interface CatalogItem {
  label: string;
  allowance: string;
  resets: string;
  match?: RegExp;
  why?: string;
}

export interface PlatformCatalog {
  id: Platform;
  name: string;
  plan: string;
  asOf: string;
  verified: string;
  sources: string[];
  items: CatalogItem[];
}

const DASHBOARD_ONLY = "Dashboard only: no API token can read it on the free plan";
const NOT_METERED = "A limit on a size or a rate, not a usage meter";

const num = (n: number): string => n.toLocaleString("en-US");

const cloudflareTracked = (): CatalogItem[] =>
  Object.entries(FREE_PLAN_LIMITS).map(([metric, l]) => ({
    label: labelFor(metric),
    allowance: `${num(l.limit)} per ${l.period}`,
    resets: l.period === "day" ? "daily, 00:00 UTC" : "monthly",
    match: new RegExp(`^${metric.replace(".", "\\.")}$`),
  }));

export const CATALOG: readonly PlatformCatalog[] = [
  {
    id: "cloudflare",
    name: "Cloudflare (Workers, D1, KV, R2, Durable Objects, Queues, Pages, Workers AI)",
    plan: "Workers Free",
    asOf: LIMITS_AS_OF,
    verified:
      "The tracked numbers are compared with Cloudflare's docs source every day. The others were read from the same docs on 2026-10-18; changes to those pages reach Telegram through the daily terms watch.",
    sources: [
      "https://developers.cloudflare.com/workers/platform/pricing/",
      "https://developers.cloudflare.com/workers/platform/limits/",
      "https://developers.cloudflare.com/d1/platform/pricing/",
      "https://developers.cloudflare.com/kv/platform/pricing/",
      "https://developers.cloudflare.com/r2/pricing/",
      "https://developers.cloudflare.com/durable-objects/platform/pricing/",
      "https://developers.cloudflare.com/queues/platform/pricing/",
      "https://developers.cloudflare.com/workers-ai/platform/pricing/",
      "https://developers.cloudflare.com/pages/platform/limits/",
    ],
    items: [
      ...cloudflareTracked(),
      {
        label: "Workers CPU time",
        allowance: "10 ms per invocation (HTTP request and cron)",
        resets: "per invocation",
        why: NOT_METERED,
      },
      {
        label: "Workers subrequests",
        allowance: "50 per invocation (1,000 to internal services)",
        resets: "per invocation",
        why: NOT_METERED,
      },
      {
        label: "D1 storage",
        allowance: "5 GB in total",
        resets: "never (a size)",
        why: "Storage is not in the daily analytics query we read",
      },
      {
        label: "R2 storage",
        allowance: "10 GB-month per month",
        resets: "monthly",
        why: "Storage is not in the daily analytics query we read",
      },
      {
        label: "KV stored data",
        allowance: "1 GB",
        resets: "never (a size)",
        why: "Storage is not in the daily analytics query we read",
      },
      {
        label: "Workers AI",
        allowance: "10,000 Neurons per day",
        resets: "daily, 00:00 UTC",
        why: "Not in the analytics query we read yet",
      },
      {
        label: "Pages builds",
        allowance: "500 builds per month, 1 at a time; 20,000 files per site",
        resets: "monthly",
        why: "Not in the analytics query we read yet",
      },
    ],
  },
  {
    id: "github",
    name: "GitHub (Free personal account)",
    plan: "Free",
    asOf: "2026-10-11",
    verified:
      "Numbers from free-tier-maxxer's research of GitHub's docs (2026-10-11); not re-read by us. The daily terms watch flags any change to the Actions billing page.",
    sources: [
      "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
      "https://github.com/pricing",
    ],
    items: [
      {
        label: "Actions minutes (private repos)",
        allowance: "2,000 per month",
        resets: "monthly, UTC",
        match: /^github\.actions_minutes$/,
      },
      {
        label: "Actions artifacts + Packages storage",
        allowance: "500 MB (shared)",
        resets: "never (a size)",
        why: "Not reported separately by the billing API on Free",
      },
      {
        label: "Actions cache",
        allowance: "10 GB per repository",
        resets: "never (a size)",
        why: NOT_METERED,
      },
      {
        label: "Packages data transfer",
        allowance: "1 GB per month",
        resets: "monthly",
        why: "Absent from the billing report until used",
      },
      {
        label: "Codespaces",
        allowance: "120 core-hours and 15 GB-month storage per month",
        resets: "monthly",
        why: "Absent from the billing report until used",
      },
    ],
  },
  {
    id: "resend",
    name: "Resend (email)",
    plan: "Free",
    asOf: "2026-10-16",
    verified:
      "Allowances from resend.com/pricing as read by free-tier-maxxer (2026-10-16). The tracked meters use the live limit from your account's own API, so those cannot go stale.",
    sources: [
      "https://resend.com/pricing",
      "https://resend.com/docs/api-reference/usage/retrieve-usage",
    ],
    items: [
      {
        label: "Emails per day",
        allowance: "100",
        resets: "rolling 24 h",
        match: /^resend\.emails_daily$/,
      },
      {
        label: "Emails per month",
        allowance: "3,000",
        resets: "monthly",
        match: /^resend\.emails_monthly$/,
      },
      { label: "Domains", allowance: "3", resets: "never (a count)", match: /^resend\.domains$/ },
      {
        label: "Marketing contacts",
        allowance: "1,000",
        resets: "never (a count)",
        match: /^resend\.contacts$/,
      },
      { label: "Segments", allowance: "3", resets: "never (a count)", match: /^resend\.segments$/ },
      {
        label: "AI credits",
        allowance: "5 per month",
        resets: "monthly",
        match: /^resend\.ai_credits$/,
      },
      {
        label: "Automation runs",
        allowance: "10,000 per month",
        resets: "monthly",
        match: /^resend\.automation_runs$/,
      },
      {
        label: "Webhook endpoints, data retention",
        allowance: "1 endpoint; 30 days of history",
        resets: "n/a",
        why: NOT_METERED,
      },
    ],
  },
  {
    id: "supabase",
    name: "Supabase (Free plan)",
    plan: "Free",
    asOf: "2026-10-11",
    verified:
      "Numbers from supabase.com/pricing as read by free-tier-maxxer (2026-10-11); not re-read by us. The daily terms watch flags any change to the pricing page.",
    sources: [
      "https://supabase.com/pricing",
      "https://supabase.com/docs/guides/platform/free-project-pausing",
    ],
    items: [
      {
        label: "Database size",
        allowance: "500 MB (read-only mode above it)",
        resets: "never (a size)",
        match: /^supabase\..+\.db_bytes$/,
      },
      {
        label: "File storage",
        allowance: "1 GB",
        resets: "never (a size)",
        match: /^supabase\..+\.storage_bytes$/,
      },
      {
        label: "Project paused after inactivity",
        allowance: "1 week without activity",
        resets: "n/a",
        why: "Alerts daily while a watched project is paused (shown as a status, not a meter)",
      },
      {
        label: "Egress",
        allowance: "5 GB (+ 5 GB cached)",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Monthly active users",
        allowance: "50,000",
        resets: "monthly",
        why: "Only approximable by SQL; not implemented",
      },
      {
        label: "Realtime",
        allowance: "2 million messages per month; 200 peak connections",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Edge Function invocations",
        allowance: "500,000 per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      { label: "Active projects", allowance: "2", resets: "n/a", why: NOT_METERED },
    ],
  },
  {
    id: "vercel",
    name: "Vercel (Hobby)",
    plan: "Hobby",
    asOf: "2026-10-11",
    verified:
      "Numbers from vercel.com/pricing as read by free-tier-maxxer (2026-10-11); not re-read by us. The daily terms watch flags any change to the limits page.",
    sources: [
      "https://vercel.com/pricing",
      "https://vercel.com/docs/limits",
      "https://vercel.com/docs/limits/fair-use-guidelines",
    ],
    items: [
      {
        label: "Account blocked for exceeding limits",
        allowance: "n/a",
        resets: "n/a",
        why: "Alerts daily while the team is blocked (shown as a status, not a meter)",
      },
      {
        label: "Fast Data Transfer",
        allowance: "100 GB per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Fast Origin Transfer",
        allowance: "10 GB per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "CDN requests",
        allowance: "1 million per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Function invocations",
        allowance: "1 million per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Fluid Active CPU",
        allowance: "4 hours per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Fluid Provisioned Memory",
        allowance: "360 GB-hours per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Image transformations",
        allowance: "5,000 per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Web Analytics events",
        allowance: "50,000 per month",
        resets: "monthly",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Deployments",
        allowance: "100 per day; builds up to 45 min, 1 at a time",
        resets: "daily",
        why: NOT_METERED,
      },
      {
        label: "Commercial use",
        allowance: "Not allowed on Hobby",
        resets: "n/a",
        why: "A terms rule, not a meter: a paying client's site belongs on a paid plan",
      },
    ],
  },
];

export const PLATFORM_NAME: Readonly<Record<Platform, string>> = Object.fromEntries(
  CATALOG.map((p) => [p.id, p.name.split(" (")[0] as string]),
) as Record<Platform, string>;
