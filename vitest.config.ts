import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    sequence: { concurrent: false },
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "cloudflare",
          testTimeout: 30000,
          hookTimeout: 60000,
          include: [
            "evals/smoke.eval.test.ts",
            "evals/budget-extractor.eval.test.ts",
            "evals/catalog.eval.test.ts",
            "evals/search-fallback.eval.test.ts",
            "evals/planner.eval.test.ts",
            "evals/executor.eval.test.ts",
            "evals/narrator.eval.test.ts",
            "evals/claim-check-integration.eval.test.ts",
          ],
        },
      },
      {
        // ponytail: pure claim-check functions — no bindings needed
        test: {
          name: "node",
          pool: "forks",
          include: ["evals/state.eval.test.ts", "evals/probe-gate.eval.test.ts", "evals/claim-check.eval.test.ts"],
        },
      },
    ],
  },
});
