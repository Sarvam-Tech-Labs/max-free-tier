/**
 * Cloudflare analytics beyond the daily request counters: Workers AI Neurons (a daily total, so it joins the usage rows) and
 * the storage LEVELS of D1 and R2 (a size now, not a sum, so they are kept as readings). Dataset and field names were read from
 * the live schema on 2026-10-18 by introspection:
 *   aiInferenceAdaptiveGroups  filter { date }                sum { totalNeurons }                dimensions { modelId }
 *   d1StorageAdaptiveGroups    filter { date_geq, date_leq }  max { databaseSizeBytes }           dimensions { databaseId date }
 *   r2StorageAdaptiveGroups    filter { date_geq, date_leq }  max { payloadSize metadataSize }    dimensions { bucketName storageClass date }
 * Separate requests from the main usage query, so a problem here can never take the request counters down with it.
 */
import { postGraphql, type UsageRow } from "./graphql";
import { FREE_PLAN_STORAGE, type LimitStatus, toStatus } from "./limits";

export const AI_QUERY = `query Ai($account: String!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      aiInferenceAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { totalNeurons }
        dimensions { modelId }
      }
    }
  }
}`;

export const STORAGE_QUERY = `query Storage($account: String!, $from: Date!, $to: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      d1StorageAdaptiveGroups(limit: 1000, filter: { date_geq: $from, date_leq: $to }) {
        max { databaseSizeBytes }
        dimensions { databaseId date }
      }
      r2StorageAdaptiveGroups(limit: 1000, filter: { date_geq: $from, date_leq: $to }) {
        max { payloadSize metadataSize }
        dimensions { bucketName storageClass date }
      }
    }
  }
}`;

interface AiAccount {
  aiInferenceAdaptiveGroups?: Array<{
    sum: { totalNeurons: number };
    dimensions: { modelId: string };
  }>;
}

interface StorageAccount {
  d1StorageAdaptiveGroups?: Array<{
    max: { databaseSizeBytes: number };
    dimensions: { databaseId: string; date: string };
  }>;
  r2StorageAdaptiveGroups?: Array<{
    max: { payloadSize: number; metadataSize: number };
    dimensions: { bucketName: string; storageClass?: string; date: string };
  }>;
}

/** Pure: one day's Neurons per model → usage rows (product "ai", metric "neurons"). Empty / null → []. */
export function toAiRows(date: string, account: AiAccount | null): UsageRow[] {
  const byModel = new Map<string, number>();
  for (const g of account?.aiInferenceAdaptiveGroups ?? []) {
    const model = g.dimensions.modelId || "unknown";
    byModel.set(model, (byModel.get(model) ?? 0) + (g.sum.totalNeurons ?? 0));
  }
  return [...byModel].map(([dim, value]) => ({
    date,
    product: "ai" as const,
    metric: "neurons",
    dim,
    value,
  }));
}

export async function fetchAiRows(
  token: string,
  account: string,
  date: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageRow[]> {
  return toAiRows(
    date,
    await postGraphql<AiAccount>(token, AI_QUERY, { account, date }, fetchImpl),
  );
}

export interface StorageTotals {
  /** Sum of every D1 database's latest size, against the account-wide 5 GB. */
  d1TotalBytes: number;
  /** The biggest single database, against the 500 MB per-database cap (the one that bites first). */
  d1LargestBytes: number;
  d1Databases: number;
  /** R2 Standard storage (payload + metadata): Infrequent Access has no free allowance, so it is left out. */
  r2Bytes: number;
  r2Buckets: number;
}

/** Keep, per key, the entry with the latest date: a size is a level, so the newest reading is the one that counts. */
function latest<T extends { date: string }>(rows: readonly T[], key: (r: T) => string): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const cur = best.get(k);
    if (!cur || r.date > cur.date) best.set(k, r);
  }
  return [...best.values()];
}

/** Pure: a two-day window of storage groups → current totals. */
export function toStorage(account: StorageAccount | null): StorageTotals {
  const d1 = latest(
    (account?.d1StorageAdaptiveGroups ?? []).map((g) => ({
      id: g.dimensions.databaseId,
      date: g.dimensions.date,
      bytes: g.max.databaseSizeBytes ?? 0,
    })),
    (r) => r.id,
  );
  const r2 = latest(
    (account?.r2StorageAdaptiveGroups ?? [])
      .filter((g) => !/infrequent/i.test(g.dimensions.storageClass ?? ""))
      .map((g) => ({
        id: g.dimensions.bucketName,
        date: g.dimensions.date,
        bytes: (g.max.payloadSize ?? 0) + (g.max.metadataSize ?? 0),
      })),
    (r) => r.id,
  );
  return {
    d1TotalBytes: d1.reduce((a, r) => a + r.bytes, 0),
    d1LargestBytes: d1.reduce((a, r) => Math.max(a, r.bytes), 0),
    d1Databases: d1.length,
    r2Bytes: r2.reduce((a, r) => a + r.bytes, 0),
    r2Buckets: r2.length,
  };
}

export async function fetchStorage(
  token: string,
  account: string,
  today: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StorageTotals> {
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1); // yesterday too: the sizes are sampled, today may not have a sample yet
  return toStorage(
    await postGraphql<StorageAccount>(
      token,
      STORAGE_QUERY,
      { account, from: from.toISOString().slice(0, 10), to: today },
      fetchImpl,
    ),
  );
}

/**
 * The readings the site shows for the storage levels. Sizes never reset, but "month" makes each level re-alert once a month
 * while it lasts (the same convention as Supabase's sizes). Nothing is reported for a product the account does not use.
 */
export function storageStatuses(
  t: StorageTotals,
  today: string,
  levels: readonly number[],
): LimitStatus[] {
  const out: LimitStatus[] = [];
  const add = (metric: string, used: number) => {
    const limit = FREE_PLAN_STORAGE[metric] as number;
    out.push(toStatus(metric, used, limit, "month", today, levels));
  };
  if (t.d1Databases > 0) {
    add("d1.storage_bytes", t.d1TotalBytes);
    add("d1.db_max_bytes", t.d1LargestBytes);
  }
  if (t.r2Buckets > 0) add("r2.storage_bytes", t.r2Bytes);
  return out;
}
