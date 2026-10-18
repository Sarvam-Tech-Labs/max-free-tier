/**
 * usage-guard-collector — read-only usage collector.
 *
 * scheduled(): one collect cycle (run.ts), or the other-platform checks on PROVIDERS_CRON.
 * fetch(): the overview page. Without the DASHBOARD_PASSWORD secret everything is 404 (the page lists every client's
 * usage); with it, HTTP Basic is required:
 *   /            the overview (public/index.html, adapted from free-tier-maxxer) → /data.js, /series.js (ledger.ts)
 *   /clients     consumption per client, found by email (views.ts)
 *   /platforms   every free allowance per platform + each client's consumption (views.ts, catalog.ts)
 *   /classic     the original 7-day table with spikes
 */
import { authorized } from "./auth";
import type { Env } from "./env";
import { buildLedger, dataJs, seriesJs } from "./ledger";
import { PROVIDERS_CRON, renderIndex, runCollect, runProviders } from "./run";
import { renderClientsPage, renderPlatformsPage } from "./views";

const NO_STORE = { "Cache-Control": "no-store" };
const NOT_FOUND = () => new Response("Not found", { status: 404 });
const JS = { "Content-Type": "application/javascript; charset=utf-8", ...NO_STORE };
const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });

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
    if (request.method !== "GET" || !env.DASHBOARD_PASSWORD) return NOT_FOUND();
    if (!(await authorized(request, env.DASHBOARD_PASSWORD))) {
      return new Response("Sign in", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="max-free-tier", charset="UTF-8"',
          ...NO_STORE,
        },
      });
    }
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/":
      case "/index.html": {
        if (!env.ASSETS) return NOT_FOUND();
        const page = await env.ASSETS.fetch(new Request(new URL("/index.html", url)));
        return new Response(page.body, {
          status: page.status,
          headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
        });
      }
      case "/data.js":
        return new Response(dataJs(await buildLedger(env)), { headers: JS });
      case "/series.js":
        return new Response(seriesJs(await buildLedger(env)), { headers: JS });
      case "/clients":
        return html(renderClientsPage(await buildLedger(env), url.searchParams.get("q") ?? ""));
      case "/platforms":
        return html(renderPlatformsPage(await buildLedger(env)));
      case "/classic":
        return html(await renderIndex(env));
      default:
        return NOT_FOUND();
    }
  },
} satisfies ExportedHandler<Env>;
