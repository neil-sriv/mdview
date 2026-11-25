import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./worker/wrangler.jsonc" },
      // Test fixtures, not the production secrets. Those stay out of the repo.
      miniflare: {
        bindings: {
          AGENT_TOKEN_IDS: "agent-token",
          BACKUP_TOKEN_ID: "backup-token",
          ADMIN_TOKEN_ID: "admin-token",
          ROUTE_SPEC_COMMENTS_WEBHOOK_URL: "https://routine.example/comments",
          ROUTE_SPEC_COMMENTS_WEBHOOK_KEY: "test-webhook-key",
        },
      },
    }),
  ],
  test: {
    include: ["worker/**/*.test.js"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
