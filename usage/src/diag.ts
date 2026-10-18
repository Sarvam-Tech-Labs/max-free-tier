/**
 * TEMPORARY: Cloudflare GraphQL schema lookup, so new analytics datasets can be written against the real field names instead of
 * guesses. Answers only with schema metadata (type and field names), never data. Behind the site password and the same
 * site-header rule as the token API. Remove once the datasets are wired.
 */
import type { Env } from "./env";
import { GRAPHQL_ENDPOINT } from "./graphql";

const QUERY = `query Probe($n: String!) {
  __type(name: $n) {
    name kind
    fields { name args { name type { ...T } } type { ...T } }
    inputFields { name type { ...T } }
  }
}
fragment T on __Type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }`;

export async function handleDiag(
  request: Request,
  env: Env,
  f: typeof fetch = fetch,
): Promise<Response> {
  if (request.headers.get("X-Requested-With") !== "max-free-tier") {
    return new Response("Refused", { status: 403 });
  }
  if (!env.CF_API_TOKEN) return new Response("No CF_API_TOKEN", { status: 409 });
  const type = new URL(request.url).searchParams.get("type") ?? "account";
  if (!/^[A-Za-z0-9_]{1,160}$/.test(type)) return new Response("Bad type", { status: 400 });
  const res = await f(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { n: type } }),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
