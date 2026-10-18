/**
 * What each platform's free tier includes (tab 1). `match` ties an allowance to the meter the collector tracks (matched
 * against the meter key); no `match` = listed for reference only, with `why` saying why it is not tracked.
 * Cloudflare's tracked numbers come from FREE_PLAN_LIMITS (one source of truth, compared with Cloudflare's docs every day
 * by scripts/limits-drift.mjs).
 *
 * Provenance matters: "asOf" and "verified" say how each number was obtained. Anything not read from the platform's own
 * docs by us is attributed to free-tier-maxxer's research (https://github.com/alemalvarez/free-tier-maxxer, MIT).
 */
import { labelFor, type Platform } from "./ledger";
import { FREE_PLAN_LIMITS, LIMITS_AS_OF } from "./limits";
import type { Cycle } from "./time";

export type Category =
  | "Requests"
  | "Database"
  | "Storage"
  | "Email"
  | "Compute"
  | "Bandwidth"
  | "Builds"
  | "Account";
export type Frequency = "Daily" | "Monthly" | "Rolling 24 h" | "Per request" | "Never" | "—";

export interface CatalogItem {
  label: string;
  allowance: string;
  category: Category;
  frequency: Frequency;
  /** When it resets, in words (e.g. "00:00 UTC"). */
  resets: string;
  match?: RegExp;
  why?: string;
}

export interface PlatformCatalog {
  id: Platform;
  name: string;
  /** Set when usage cannot be read on this plan: why, shown instead of "connect a token". */
  unmeasured?: string;
  /** What the platform covers, shown under its name. */
  covers: string;
  plan: string;
  asOf: string;
  verified: string;
  sources: string[];
  items: CatalogItem[];
}

const DASHBOARD_ONLY = "Dashboard only: no API token can read it on the free plan";
const NOT_METERED = "A limit on a size or a rate, not a usage meter";

const num = (n: number): string => n.toLocaleString("en-US");

const CF_CATEGORY: Readonly<Record<string, Category>> = {
  workers: "Requests",
  do: "Requests",
  d1: "Database",
  kv: "Database",
  queues: "Requests",
  r2: "Storage",
  ai: "Compute",
};

const cloudflareTracked = (): CatalogItem[] =>
  Object.entries(FREE_PLAN_LIMITS).map(([metric, l]) => ({
    label: labelFor(metric).replace(/ \(per (day|month)\)$/, ""),
    allowance: `${num(l.limit)} / ${l.period}`,
    category: CF_CATEGORY[metric.split(".")[0] as string] ?? "Requests",
    frequency: l.period === "day" ? "Daily" : "Monthly",
    resets: l.period === "day" ? "00:00 UTC" : "1st of the month, 00:00 UTC",
    match: new RegExp(`^${metric.replace(".", "\\.")}$`),
  }));

export const CATALOG: readonly PlatformCatalog[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    covers: "Workers, D1, KV, R2, Durable Objects, Queues, Pages, Workers AI",
    plan: "Workers Free",
    asOf: LIMITS_AS_OF,
    verified:
      "Tracked numbers are compared with Cloudflare's docs every day. The rest were read from the same docs on 2026-10-18; any change to those pages is caught by the daily terms watch.",
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
        allowance: "10 ms per invocation",
        category: "Compute",
        frequency: "Per request",
        resets: "each request and cron run",
        why: NOT_METERED,
      },
      {
        label: "Workers subrequests",
        allowance: "50 per invocation (1,000 to Cloudflare services)",
        category: "Requests",
        frequency: "Per request",
        resets: "each request and cron run",
        why: NOT_METERED,
      },
      {
        label: "D1 storage (all databases)",
        allowance: "5 GB total",
        category: "Database",
        frequency: "Never",
        resets: "a size",
        match: /^d1\.storage_bytes$/,
      },
      {
        label: "D1 largest database",
        allowance: "500 MB per database",
        category: "Database",
        frequency: "Never",
        resets: "a size",
        match: /^d1\.db_max_bytes$/,
      },
      {
        label: "KV stored data",
        allowance: "1 GB",
        category: "Database",
        frequency: "Never",
        resets: "a size",
        why: "Storage is not in the daily analytics query we read",
      },
      {
        label: "R2 storage (Standard)",
        allowance: "10 GB-month / month",
        category: "Storage",
        frequency: "Never",
        resets: "a size",
        match: /^r2\.storage_bytes$/,
      },
      {
        label: "Workers Logs",
        allowance: "200,000 log events / day, kept 3 days",
        category: "Requests",
        frequency: "Daily",
        resets: "daily (time not published)",
        why: "Not in the analytics API we read",
      },
      {
        label: "Pages builds",
        allowance: "500 / month, 1 at a time",
        category: "Builds",
        frequency: "Monthly",
        resets: "1st of the month",
        why: "Not read yet; deploys that upload a prebuilt site (Direct Upload) do not use this quota",
      },
      {
        label: "Pages files",
        allowance: "20,000 per site",
        category: "Storage",
        frequency: "Never",
        resets: "a count",
        why: NOT_METERED,
      },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    covers: "Actions, Packages, Codespaces (Free personal account)",
    plan: "Free",
    asOf: "2026-10-11",
    verified:
      "From free-tier-maxxer's research of GitHub's docs (2026-10-11); not re-read by us. The daily terms watch flags any change to the Actions billing page.",
    sources: [
      "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
      "https://github.com/pricing",
    ],
    items: [
      {
        label: "Actions minutes (private repos)",
        allowance: "2,000 / month",
        category: "Builds",
        frequency: "Monthly",
        resets: "1st of the month, 00:00 UTC",
        match: /^github\.actions_minutes$/,
      },
      {
        label: "Actions artifacts + Packages storage",
        allowance: "500 MB shared",
        category: "Storage",
        frequency: "Never",
        resets: "a size",
        why: "Not reported separately by the billing API on Free",
      },
      {
        label: "Actions cache",
        allowance: "10 GB per repository",
        category: "Storage",
        frequency: "Never",
        resets: "a size",
        why: NOT_METERED,
      },
      {
        label: "Packages data transfer",
        allowance: "1 GB / month",
        category: "Bandwidth",
        frequency: "Monthly",
        resets: "1st of the month",
        match: /^github\.packages_transfer_bytes$/,
      },
      {
        label: "Codespaces compute",
        allowance: "120 core-hours / month",
        category: "Compute",
        frequency: "Monthly",
        resets: "1st of the month",
        match: /^github\.codespaces_core_hours$/,
      },
      {
        label: "Codespaces storage",
        allowance: "15 GB-month / month",
        category: "Storage",
        frequency: "Monthly",
        resets: "1st of the month",
        why: "Not read yet: GitHub bills it in GB-hours and the Free-plan report has not been checked for it",
      },
    ],
  },
  {
    id: "resend",
    name: "Resend",
    covers: "Transactional and marketing email",
    plan: "Free",
    asOf: "2026-10-16",
    verified:
      "Allowances from resend.com/pricing as read by free-tier-maxxer (2026-10-16). Consumption uses the live limit and reset time from each account's own API, so it cannot go stale.",
    sources: [
      "https://resend.com/pricing",
      "https://resend.com/docs/api-reference/usage/retrieve-usage",
    ],
    items: [
      {
        label: "Emails per day",
        allowance: "100",
        category: "Email",
        frequency: "Rolling 24 h",
        resets: "24 h after each send window (time from the API)",
        match: /^resend\.emails_daily$/,
      },
      {
        label: "Emails per month",
        allowance: "3,000",
        category: "Email",
        frequency: "Monthly",
        resets: "start of the month (time from the API)",
        match: /^resend\.emails_monthly$/,
      },
      {
        label: "Domains",
        allowance: "3",
        category: "Account",
        frequency: "Never",
        resets: "a count",
        match: /^resend\.domains$/,
      },
      {
        label: "Marketing contacts",
        allowance: "1,000",
        category: "Email",
        frequency: "Never",
        resets: "a count",
        match: /^resend\.contacts$/,
      },
      {
        label: "Segments",
        allowance: "3",
        category: "Email",
        frequency: "Never",
        resets: "a count",
        match: /^resend\.segments$/,
      },
      {
        label: "AI credits",
        allowance: "5 / month",
        category: "Compute",
        frequency: "Monthly",
        resets: "time from the API",
        match: /^resend\.ai_credits$/,
      },
      {
        label: "Automation runs",
        allowance: "10,000 / month",
        category: "Email",
        frequency: "Monthly",
        resets: "time from the API",
        match: /^resend\.automation_runs$/,
      },
      {
        label: "Webhook endpoints",
        allowance: "1",
        category: "Account",
        frequency: "Never",
        resets: "a count",
        why: NOT_METERED,
      },
      {
        label: "Data retention",
        allowance: "30 days",
        category: "Account",
        frequency: "—",
        resets: "—",
        why: NOT_METERED,
      },
    ],
  },
  {
    id: "supabase",
    name: "Supabase",
    covers: "Postgres database, storage, auth, realtime, edge functions",
    plan: "Free",
    asOf: "2026-10-11",
    verified:
      "From supabase.com/pricing as read by free-tier-maxxer (2026-10-11); not re-read by us. The daily terms watch flags any change to the pricing page.",
    sources: [
      "https://supabase.com/pricing",
      "https://supabase.com/docs/guides/platform/free-project-pausing",
    ],
    items: [
      {
        label: "Database size",
        allowance: "500 MB (read-only above it)",
        category: "Database",
        frequency: "Never",
        resets: "a size",
        match: /^supabase\..+\.db_bytes$/,
      },
      {
        label: "File storage",
        allowance: "1 GB",
        category: "Storage",
        frequency: "Never",
        resets: "a size",
        match: /^supabase\..+\.storage_bytes$/,
      },
      {
        label: "Pause after inactivity",
        allowance: "1 week without activity",
        category: "Account",
        frequency: "—",
        resets: "—",
        why: "Alerts while a watched project is paused (shown as a status)",
      },
      {
        label: "Egress",
        allowance: "5 GB + 5 GB cached / month",
        category: "Bandwidth",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Monthly active users",
        allowance: "50,000",
        category: "Account",
        frequency: "Monthly",
        resets: "billing cycle",
        why: "Only approximable by SQL; not implemented",
      },
      {
        label: "Realtime",
        allowance: "2M messages / month, 200 peak connections",
        category: "Requests",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Edge Function invocations",
        allowance: "500,000 / month",
        category: "Compute",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Active projects",
        allowance: "2",
        category: "Account",
        frequency: "Never",
        resets: "a count",
        why: NOT_METERED,
      },
    ],
  },
  {
    id: "vercel",
    name: "Vercel",
    covers: "Hosting, functions, CDN, image optimisation (Hobby)",
    plan: "Hobby",
    asOf: "2026-10-11",
    verified:
      "From vercel.com/pricing as read by free-tier-maxxer (2026-10-11); not re-read by us. The daily terms watch flags any change to the limits page.",
    sources: [
      "https://vercel.com/pricing",
      "https://vercel.com/docs/limits",
      "https://vercel.com/docs/limits/fair-use-guidelines",
    ],
    items: [
      {
        label: "Fast Data Transfer",
        allowance: "100 GB / month",
        category: "Bandwidth",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Fast Origin Transfer",
        allowance: "10 GB / month",
        category: "Bandwidth",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "CDN requests",
        allowance: "1M / month",
        category: "Requests",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Function invocations",
        allowance: "1M / month",
        category: "Requests",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Fluid Active CPU",
        allowance: "4 hours / month",
        category: "Compute",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Fluid Provisioned Memory",
        allowance: "360 GB-hours / month",
        category: "Compute",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Image transformations",
        allowance: "5,000 / month",
        category: "Compute",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Web Analytics events",
        allowance: "50,000 / month",
        category: "Requests",
        frequency: "Monthly",
        resets: "billing cycle",
        why: DASHBOARD_ONLY,
      },
      {
        label: "Deployments",
        allowance: "100 / day; builds ≤ 45 min, 1 at a time",
        category: "Builds",
        frequency: "Daily",
        resets: "rolling",
        why: NOT_METERED,
      },
      {
        label: "Account blocked",
        allowance: "—",
        category: "Account",
        frequency: "—",
        resets: "—",
        why: "Alerts while Vercel blocks the team (shown as a status)",
      },
      {
        label: "Commercial use",
        allowance: "Not allowed on Hobby",
        category: "Account",
        frequency: "—",
        resets: "—",
        why: "A terms rule: a paying client's site belongs on a paid plan",
      },
    ],
  },
  {
    id: "umami",
    name: "Umami Cloud",
    covers: "Cookieless web analytics",
    plan: "Hobby",
    asOf: "2026-10-18",
    unmeasured:
      "Umami's free Hobby plan has no API (API access starts at Pro), so usage cannot be read here. Check it in Umami: Settings → Usage. The allowances below are what the plan includes.",
    verified:
      "Read from umami.is/pricing and Umami's docs source (cloud/index.mdx: API access is Pro and above) on 2026-10-18. Both pages are in the daily terms watch.",
    sources: ["https://umami.is/pricing", "https://docs.umami.is/docs/cloud/usage"],
    items: [
      {
        label: "Events",
        allowance: "100,000 / month",
        category: "Requests",
        frequency: "Monthly",
        resets: "your billing period",
        why: "Only on Umami's Usage page (Settings → Usage); the API needs a paid plan",
      },
      {
        label: "Websites",
        allowance: "1",
        category: "Account",
        frequency: "Never",
        resets: "a count",
        why: NOT_METERED,
      },
      {
        label: "Data retention",
        allowance: "6 months",
        category: "Storage",
        frequency: "Never",
        resets: "rolling",
        why: NOT_METERED,
      },
      {
        label: "API access",
        allowance: "Not on Hobby (Pro and above)",
        category: "Account",
        frequency: "—",
        resets: "—",
        why: "A plan rule: it is why usage cannot be read automatically",
      },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini API",
    covers: "AI text generation (free tier)",
    plan: "Free tier",
    asOf: "2026-10-18",
    unmeasured:
      "Google publishes the free-tier numbers only in AI Studio and offers no API to read remaining quota. Limits are per model and per project; daily requests reset at midnight Pacific time.",
    verified:
      "Google's rate-limit page lists no free-tier numbers (they are shown in AI Studio). The per-model figures below are what the API itself reported when a daily cap was hit on this account (2026-06): treat them as indicative and check AI Studio. The page is in the daily terms watch.",
    sources: [
      "https://ai.google.dev/gemini-api/docs/rate-limits",
      "https://aistudio.google.com/rate-limit",
    ],
    items: [
      {
        label: "Requests per day, per model",
        allowance: "about 20 on each full Flash model; more on Lite and Gemma models",
        category: "Requests",
        frequency: "Daily",
        resets: "midnight Pacific time",
        why: "No usage API; only AI Studio shows it",
      },
      {
        label: "Requests per minute",
        allowance: "about 5 on full Flash models",
        category: "Requests",
        frequency: "Per request",
        resets: "each minute",
        why: NOT_METERED,
      },
      {
        label: "Billing must stay off",
        allowance: "Free tier needs a project with no billing",
        category: "Account",
        frequency: "—",
        resets: "—",
        why: "A terms rule: turning billing on ends the free tier",
      },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    covers: "AI text generation (free plan)",
    plan: "Free plan",
    asOf: "2026-10-18",
    unmeasured:
      "Groq has no usage API. Remaining quota only comes back in the response headers of a real request (x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens). Limits are per model.",
    verified:
      "From Groq's rate-limits page on 2026-10-18; the page does not label which plan the table belongs to, so these are the published per-model limits and may be higher on other plans. Page is in the daily terms watch.",
    sources: ["https://console.groq.com/docs/rate-limits"],
    items: [
      {
        label: "Requests per day, per model",
        allowance: "1,000 (e.g. openai/gpt-oss-120b, qwen/qwen3.8-27b)",
        category: "Requests",
        frequency: "Daily",
        resets: "daily (time not published)",
        why: "Only visible in response headers of a real request",
      },
      {
        label: "Tokens per day, per model",
        allowance: "200,000 on those models",
        category: "Requests",
        frequency: "Daily",
        resets: "daily (time not published)",
        why: "Only visible in response headers of a real request",
      },
      {
        label: "Requests per minute",
        allowance: "30 on those models",
        category: "Requests",
        frequency: "Per request",
        resets: "each minute",
        why: NOT_METERED,
      },
      {
        label: "Tokens per minute",
        allowance: "8,000 on those models",
        category: "Requests",
        frequency: "Per request",
        resets: "each minute",
        why: NOT_METERED,
      },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras Inference",
    covers: "AI text generation (free trial)",
    plan: "Free trial",
    asOf: "2026-10-18",
    unmeasured:
      "Cerebras names no usage API or rate-limit headers. Limits refill continuously (token bucket) rather than at a fixed time; the Limits page in the Cerebras console shows your exact numbers.",
    verified:
      "From Cerebras's rate-limits page on 2026-10-18 (Free Trial table, per model, per organization). Page is in the daily terms watch.",
    sources: ["https://inference-docs.cerebras.ai/support/rate-limits"],
    items: [
      {
        label: "Tokens per day, per model",
        allowance: "1,000,000 (gpt-oss-120b, qwen-3.8-27b)",
        category: "Requests",
        frequency: "Rolling 24 h",
        resets: "continuous refill",
        why: "No usage API",
      },
      {
        label: "Tokens per hour, per model",
        allowance: "1,000,000",
        category: "Requests",
        frequency: "Per request",
        resets: "continuous refill",
        why: NOT_METERED,
      },
      {
        label: "Tokens per minute, per model",
        allowance: "30,000 uncached, 90,000 total",
        category: "Requests",
        frequency: "Per request",
        resets: "continuous refill",
        why: NOT_METERED,
      },
      {
        label: "Requests per minute, per model",
        allowance: "5",
        category: "Requests",
        frequency: "Per request",
        resets: "each minute",
        why: NOT_METERED,
      },
    ],
  },
];

export const PLATFORM_NAME: Readonly<Record<Platform, string>> = Object.fromEntries(
  CATALOG.map((p) => [p.id, p.name]),
) as Record<Platform, string>;

/** Registry `platforms:` entries → the platform they belong to (undefined = a platform we do not monitor). */
export function platformOf(entry: string): Platform | undefined {
  if (/^(cloudflare|d1$|r2$|kv$|queues$|workers|durable-objects|pages$)/.test(entry))
    return "cloudflare";
  if (entry === "github-actions" || entry === "github") return "github";
  if (entry === "vercel" || entry === "resend" || entry === "supabase") return entry;
  if (entry === "umami" || entry === "gemini" || entry === "groq" || entry === "cerebras")
    return entry;
  return undefined;
}

/** How an allowance resets, from its frequency and reset text. Calendar rules give an exact date; the rest do not. */
export function cycleOf(item: Pick<CatalogItem, "frequency" | "resets">): Cycle {
  if (item.frequency === "Rolling 24 h") return "rolling";
  if (item.frequency === "Daily" && item.resets === "00:00 UTC") return "utc-day";
  if (item.frequency === "Monthly" && item.resets.startsWith("1st of the month"))
    return "utc-month";
  // Daily or monthly, but not on a UTC calendar edge (a billing period, another time zone, or a time nobody publishes):
  // there is no exact next date to compute, and the page says so instead of guessing.
  if (item.frequency === "Monthly" || item.frequency === "Daily") return "billing";
  return "none";
}

/** The catalog entry a meter belongs to (by its key), or undefined for a meter we do not list. */
export function itemFor(platform: Platform, key: string): CatalogItem | undefined {
  return CATALOG.find((c) => c.id === platform)?.items.find((i) => i.match?.test(key));
}
