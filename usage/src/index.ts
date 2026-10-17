/**
 * usage-guard-collector — read-only Cloudflare usage collector.
 *
 * scheduled(): one collect cycle (see run.ts). fetch(): GET / renders the last 7 days; everything else is 404.
 */
import type { Env } from "./env";
import { renderIndex, runCollect } from "./run";

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCollect(env).then((s) => {
        // Never log the token. The summary has only counts and an error message.
        console.log(JSON.stringify({ event: "collect", ...s }));
      }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    const html = await renderIndex(env);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
} satisfies ExportedHandler<Env>;
