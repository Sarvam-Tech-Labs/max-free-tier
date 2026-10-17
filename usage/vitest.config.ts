import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Only the type-only file is excluded. Every fetch is stubbed via vi.stubGlobal("fetch")
      // across three paths (success / empty / non-2xx); spike() has branch coverage.
      exclude: ["src/env.ts"],
      reporter: ["text", "text-summary"],
      thresholds: { lines: 85, branches: 80 },
    },
  },
});
