import type { UsageAccount } from "../../src/graphql";

/** One account, every dataset populated; 18 usage rows after toRows(). */
export const SAMPLE_ACCOUNT: UsageAccount = {
  workersInvocationsAdaptive: [
    { sum: { requests: 1200, errors: 3, cpuTimeUs: 2_500_000 }, dimensions: { scriptName: "api" } },
    { sum: { requests: 40, errors: 0, cpuTimeUs: 10_000 }, dimensions: { scriptName: "cron" } },
  ],
  d1AnalyticsAdaptiveGroups: [
    {
      sum: { rowsRead: 50_000, rowsWritten: 200, readQueries: 900, writeQueries: 20 },
      dimensions: { databaseId: "db-1" },
    },
  ],
  durableObjectsInvocationsAdaptiveGroups: [
    { sum: { requests: 77 }, dimensions: { scriptName: "api" } },
  ],
  kvOperationsAdaptiveGroups: [
    { sum: { requests: 500 }, dimensions: { namespaceId: "ns", actionType: "read" } },
    { sum: { requests: 5 }, dimensions: { namespaceId: "ns", actionType: "write" } },
    { sum: { requests: 1 }, dimensions: { namespaceId: "ns", actionType: "Frobnicate" } },
  ],
  r2OperationsAdaptiveGroups: [
    { sum: { requests: 10 }, dimensions: { bucketName: "b", actionType: "PutObject" } },
    { sum: { requests: 5 }, dimensions: { bucketName: "b", actionType: "UploadPart" } },
    { sum: { requests: 300 }, dimensions: { bucketName: "b", actionType: "GetObject" } },
    { sum: { requests: 2 }, dimensions: { bucketName: "b", actionType: "SomethingNew" } },
  ],
  queueMessageOperationsAdaptiveGroups: [
    { sum: { billableOperations: 30 }, dimensions: { queueId: "q", actionType: "WriteMessage" } },
    { sum: { billableOperations: 30 }, dimensions: { queueId: "q", actionType: "ReadMessage" } },
    { sum: { billableOperations: 29 }, dimensions: { queueId: "q", actionType: "DeleteMessage" } },
  ],
};
