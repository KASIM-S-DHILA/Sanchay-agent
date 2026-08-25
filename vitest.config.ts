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
            "evals/razorpay.eval.test.ts",
            "evals/audit.eval.test.ts",
          ],
        },
      },
      {
        // ponytail: pure claim-check functions — no bindings needed
        test: {
          name: "node",
          pool: "forks",
          // full turn flows (planner+narrator+razorpay) exceed the 5s default
          testTimeout: 60_000,
          hookTimeout: 90_000,
          // two concurrent unstable_dev instances race for ports/auth
          fileParallelism: false,
          include: [
            "evals/state.eval.test.ts",
            "evals/probe-gate.eval.test.ts",
            "evals/claim-check.eval.test.ts",
            "evals/audit-flow.eval.test.ts",
          ],
        },
      },
    ],
  },
});
