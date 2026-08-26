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
          testTimeout: 30_000,
          hookTimeout: 60_000,
          include: ["evals/**/*.test.ts"],
        },
      },
    ],
  },
});
