import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Test harness (QA-owned). See test/setup.ts for the storage isolation model.
// Bindings come from wrangler.toml (D1 "DB", unsafe ratelimit "EVAL_RATE_LIMITER"), all local in workerd.
// Migrations in ./drizzle are read in Node and handed to the test isolate as TEST_MIGRATIONS;
// test/setup.ts applies them once per test file and wipes all tables before each test.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./drizzle", import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
