/**
 * usage-guard-collector — read-only usage collector.
 *
 * scheduled(): one collect cycle (run.ts), or the other-platform checks on PROVIDERS_CRON.
 * fetch(): the site. Without the DASHBOARD_PASSWORD secret everything is 404 (it lists every client's usage); with it,
 * HTTP Basic is required:
 *   /              Free-tier limits: every platform's allowances, how they reset, and every detected change
 *   /consumption   pick an email → its platforms, consumption, exact reset times, uptime and domains (?email=)
 *   /tokens        paste, test and delete the platform tokens the monitor uses (tokens.ts)
 *   /classic       the original 7-day table with spike detection
 * POST /ingest is the one exception: the daily GitHub Actions jobs report with their own token (ingest.ts).
 */
import { authorized } from "./auth";
import type { Env } from "./env";
import { loadDomains, readUptime } from "./health";
import { handleIngest } from "./ingest";
import { buildLedger } from "./ledger";
import { PROVIDERS_CRON, renderIndex, runCollect, runProviders } from "./run";
import { loadRuns, recentAlerts } from "./store";
import { safeZone } from "./time";
import { handleTokenApi, tokensOverview } from "./tokens";
import { type PageData, renderConsumptionPage, renderLimitsPage, renderTokensPage } from "./views";

const NO_STORE = { "Cache-Control": "no-store" };
const NOT_FOUND = () => new Response("Not found", { status: 404 });
// This site lists client usage and takes tokens: never framed, never leaks its address, no content sniffing.
const SAFE = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
};
const html = (body: string) =>
  new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...SAFE },
  });

/** Everything both tabs read: the ledger, FlareWatch's uptime, stored domain expiry, check runs and the change log. */
async function pageData(env: Env): Promise<PageData> {
  const [ledger, uptime, domains, runs, alerts] = await Promise.all([
    buildLedger(env),
    readUptime(env),
    loadDomains(env.USAGE),
    loadRuns(env.USAGE),
    recentAlerts(env.USAGE, 200),
  ]);
  return {
    ledger,
    health: { uptime, domains, now: new Date() },
    runs,
    alerts,
    tz: safeZone(env.TIME_ZONE),
  };
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const providers = event?.cron === PROVIDERS_CRON;
    ctx.waitUntil(
      (providers ? runProviders(env) : runCollect(env)).then((s) => {
        // Never log the token. The summary has only counts and an error message.
        console.log(JSON.stringify({ event: providers ? "providers" : "collect", ...s }));
      }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The daily GitHub Actions jobs report here with their own token (not the site password).
    if (url.pathname === "/ingest" && request.method === "POST") return handleIngest(request, env);
    if (!env.DASHBOARD_PASSWORD) return NOT_FOUND();
    const isTokenApi = url.pathname === "/api/tokens" || url.pathname.startsWith("/api/tokens/");
    if (request.method !== "GET" && !isTokenApi) return NOT_FOUND();
    if (!(await authorized(request, env.DASHBOARD_PASSWORD))) {
      return new Response("Sign in", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="max-free-tier", charset="UTF-8"',
          ...NO_STORE,
        },
      });
    }
    if (isTokenApi) return handleTokenApi(request, env);
    switch (url.pathname) {
      case "/":
        return html(renderLimitsPage(await pageData(env)));
      case "/consumption":
        return html(
          renderConsumptionPage(await pageData(env), url.searchParams.get("email") ?? ""),
        );
      case "/tokens":
        return html(renderTokensPage(await pageData(env), await tokensOverview(env)));
      case "/classic":
        return html(await renderIndex(env));
      default:
        return NOT_FOUND();
    }
  },
} satisfies ExportedHandler<Env>;
