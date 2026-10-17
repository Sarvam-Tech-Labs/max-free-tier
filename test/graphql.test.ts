import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchUsage,
  GRAPHQL_ENDPOINT,
  kvMetric,
  R2_CLASS_A,
  R2_CLASS_B,
  r2Class,
  toRows,
  USAGE_QUERY,
} from "../src/graphql";
import { SAMPLE_ACCOUNT } from "./helpers/fixtures";

describe("USAGE_QUERY", () => {
  it("names only the datasets and fields verified by introspection on 2026-09-15", () => {
    for (const s of [
      "workersInvocationsAdaptive",
      "sum { requests errors cpuTimeUs }",
      "d1AnalyticsAdaptiveGroups",
      "rowsRead rowsWritten readQueries writeQueries",
      "durableObjectsInvocationsAdaptiveGroups",
      "kvOperationsAdaptiveGroups",
      "r2OperationsAdaptiveGroups",
      "queueMessageOperationsAdaptiveGroups",
      "sum { billableOperations }",
      "dimensions { queueId actionType }",
    ]) {
      expect(USAGE_QUERY).toContain(s);
    }
    expect(USAGE_QUERY).not.toContain("cpuTime }");
    expect(USAGE_QUERY).not.toContain("queueID");
  });
});

describe("fetchUsage (three paths)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("success: posts the query with bearer auth and returns the first account", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(GRAPHQL_ENDPOINT);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok");
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe(USAGE_QUERY);
      expect(body.variables).toEqual({ account: "acc", date: "2026-09-14" });
      return Response.json({ data: { viewer: { accounts: [SAMPLE_ACCOUNT] } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const acc = await fetchUsage("tok", "acc", "2026-09-14");
    expect(acc).toEqual(SAMPLE_ACCOUNT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("empty: no account in the response → null, no throw", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ data: { viewer: { accounts: [] } } }));
    expect(await fetchUsage("tok", "acc", "2026-09-14")).toBeNull();
    vi.stubGlobal("fetch", async () => Response.json({}));
    expect(await fetchUsage("tok", "acc", "2026-09-14")).toBeNull();
  });

  it("non-2xx: throws with the status code", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    await expect(fetchUsage("tok", "acc", "2026-09-14")).rejects.toThrow("graphql: 403");
  });

  it("GraphQL-level errors: throws with the messages", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: null, errors: [{ message: "unknown field" }, { message: "x" }] }),
    );
    await expect(fetchUsage("tok", "acc", "2026-09-14")).rejects.toThrow(
      "graphql: unknown field; x",
    );
  });

  it("accepts an injected fetch", async () => {
    const f = vi.fn(async () => Response.json({ data: { viewer: { accounts: [{}] } } }));
    expect(await fetchUsage("t", "a", "2026-01-01", f as unknown as typeof fetch)).toEqual({});
  });
});

describe("r2Class / kvMetric", () => {
  it("classes are disjoint and match the pricing page lists", () => {
    for (const a of R2_CLASS_A) expect(R2_CLASS_B.has(a)).toBe(false);
    expect(r2Class("PutObject")).toBe("class_a");
    expect(r2Class("GetObject")).toBe("class_b");
    expect(r2Class("Nope")).toBe("other");
  });
  it("kv action types are lower-cased; unknown → other", () => {
    expect(kvMetric("Read")).toBe("read");
    expect(kvMetric("list")).toBe("list");
    expect(kvMetric("Frobnicate")).toBe("other");
  });
});

describe("toRows", () => {
  const d = "2026-09-14";

  it("null account → []", () => expect(toRows(d, null)).toEqual([]));
  it("account without datasets → []", () => expect(toRows(d, {})).toEqual([]));

  it("flattens every dataset, converts CPU µs → ms and sums shared buckets", () => {
    const rows = toRows(d, SAMPLE_ACCOUNT);
    const get = (product: string, metric: string, dim: string) =>
      rows.find((r) => r.product === product && r.metric === metric && r.dim === dim)?.value;

    expect(get("workers", "requests", "api")).toBe(1200);
    expect(get("workers", "errors", "api")).toBe(3);
    expect(get("workers", "cpu_ms", "api")).toBe(2500);
    expect(get("workers", "requests", "cron")).toBe(40);
    expect(get("d1", "rows_read", "db-1")).toBe(50_000);
    expect(get("d1", "write_queries", "db-1")).toBe(20);
    expect(get("do", "requests", "api")).toBe(77);
    expect(get("kv", "read", "ns")).toBe(500);
    expect(get("kv", "other", "ns")).toBe(1);
    expect(get("r2", "class_a", "b")).toBe(15); // PutObject + UploadPart
    expect(get("r2", "class_b", "b")).toBe(300);
    expect(get("r2", "other", "b")).toBe(2);
    expect(get("queues", "operations", "q")).toBe(89); // summed across actionType
    expect(rows.every((r) => r.date === d)).toBe(true);
    expect(rows).toHaveLength(3 * 2 + 4 + 1 + 3 + 3 + 1);
  });
});
