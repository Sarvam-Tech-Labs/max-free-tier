/**
 * Cloudflare GraphQL Analytics transport + pure mapping to usage rows.
 *
 * Dataset / field names were checked against the live schema by introspection on 2026-09-15
 * (https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/).
 * Where the product docs and the schema disagree the schema wins (Workers `cpuTimeUs`, Queues `queueId`).
 */

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** One day, one account, six datasets. `limit` is per node; dimensions are per-resource per-day groups. */
export const USAGE_QUERY = `query Usage($account: String!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 1000, filter: { date: $date }) {
        sum { requests errors cpuTimeUs }
        dimensions { scriptName }
      }
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { rowsRead rowsWritten readQueries writeQueries }
        dimensions { databaseId }
      }
      durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { requests }
        dimensions { scriptName }
      }
      kvOperationsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { requests }
        dimensions { namespaceId actionType }
      }
      r2OperationsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { requests }
        dimensions { bucketName actionType }
      }
      queueMessageOperationsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { billableOperations }
        dimensions { queueId actionType }
      }
    }
  }
}`;

export interface UsageAccount {
  workersInvocationsAdaptive?: Array<{
    sum: { requests: number; errors: number; cpuTimeUs: number };
    dimensions: { scriptName: string };
  }>;
  d1AnalyticsAdaptiveGroups?: Array<{
    sum: { rowsRead: number; rowsWritten: number; readQueries: number; writeQueries: number };
    dimensions: { databaseId: string };
  }>;
  durableObjectsInvocationsAdaptiveGroups?: Array<{
    sum: { requests: number };
    dimensions: { scriptName: string };
  }>;
  kvOperationsAdaptiveGroups?: Array<{
    sum: { requests: number };
    dimensions: { namespaceId: string; actionType: string };
  }>;
  r2OperationsAdaptiveGroups?: Array<{
    sum: { requests: number };
    dimensions: { bucketName: string; actionType: string };
  }>;
  queueMessageOperationsAdaptiveGroups?: Array<{
    sum: { billableOperations: number };
    dimensions: { queueId: string; actionType: string };
  }>;
}

interface GraphqlResponse {
  data?: { viewer?: { accounts?: UsageAccount[] } } | null;
  errors?: Array<{ message: string }> | null;
}

export interface UsageRow {
  date: string;
  product: "workers" | "d1" | "do" | "kv" | "r2" | "queues";
  metric: string;
  dim: string;
  value: number;
}

/**
 * POST the usage query for one UTC day. Throws on non-2xx or GraphQL errors so the caller can log
 * a failed run instead of silently writing nothing. Returns `null` when the account is not in the response.
 */
export async function fetchUsage(
  token: string,
  account: string,
  date: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageAccount | null> {
  const res = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: USAGE_QUERY, variables: { account, date } }),
  });
  if (!res.ok) throw new Error(`graphql: ${res.status}`);
  const body = (await res.json()) as GraphqlResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`graphql: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data?.viewer?.accounts?.[0] ?? null;
}

/** R2 operation classes, copied from https://developers.cloudflare.com/r2/pricing/ (2026-09-15). */
export const R2_CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
export const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

export function r2Class(actionType: string): "class_a" | "class_b" | "other" {
  if (R2_CLASS_A.has(actionType)) return "class_a";
  if (R2_CLASS_B.has(actionType)) return "class_b";
  return "other";
}

const KV_ACTIONS = new Set(["read", "write", "delete", "list"]);

export function kvMetric(actionType: string): string {
  const a = actionType.toLowerCase();
  return KV_ACTIONS.has(a) ? a : "other";
}

/** Add `value` to the (product, metric, dim) bucket. Groups that share a bucket (R2 class, KV action) are summed. */
function add(acc: Map<string, UsageRow>, row: UsageRow): void {
  const key = `${row.product}\u0000${row.metric}\u0000${row.dim}`;
  const cur = acc.get(key);
  if (cur) cur.value += row.value;
  else acc.set(key, { ...row });
}

/** Pure: flatten one account's GraphQL response into usage rows for `date`. Empty response → []. */
export function toRows(date: string, account: UsageAccount | null): UsageRow[] {
  const acc = new Map<string, UsageRow>();
  if (!account) return [];

  for (const g of account.workersInvocationsAdaptive ?? []) {
    const dim = g.dimensions.scriptName;
    add(acc, { date, product: "workers", metric: "requests", dim, value: g.sum.requests });
    add(acc, { date, product: "workers", metric: "errors", dim, value: g.sum.errors });
    add(acc, { date, product: "workers", metric: "cpu_ms", dim, value: g.sum.cpuTimeUs / 1000 });
  }
  for (const g of account.d1AnalyticsAdaptiveGroups ?? []) {
    const dim = g.dimensions.databaseId;
    add(acc, { date, product: "d1", metric: "rows_read", dim, value: g.sum.rowsRead });
    add(acc, { date, product: "d1", metric: "rows_written", dim, value: g.sum.rowsWritten });
    add(acc, { date, product: "d1", metric: "read_queries", dim, value: g.sum.readQueries });
    add(acc, { date, product: "d1", metric: "write_queries", dim, value: g.sum.writeQueries });
  }
  for (const g of account.durableObjectsInvocationsAdaptiveGroups ?? []) {
    add(acc, {
      date,
      product: "do",
      metric: "requests",
      dim: g.dimensions.scriptName,
      value: g.sum.requests,
    });
  }
  for (const g of account.kvOperationsAdaptiveGroups ?? []) {
    add(acc, {
      date,
      product: "kv",
      metric: kvMetric(g.dimensions.actionType),
      dim: g.dimensions.namespaceId,
      value: g.sum.requests,
    });
  }
  for (const g of account.r2OperationsAdaptiveGroups ?? []) {
    add(acc, {
      date,
      product: "r2",
      metric: r2Class(g.dimensions.actionType),
      dim: g.dimensions.bucketName,
      value: g.sum.requests,
    });
  }
  for (const g of account.queueMessageOperationsAdaptiveGroups ?? []) {
    add(acc, {
      date,
      product: "queues",
      metric: "operations",
      dim: g.dimensions.queueId,
      value: g.sum.billableOperations,
    });
  }
  return [...acc.values()];
}
