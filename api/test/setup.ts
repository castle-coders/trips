// Per-file setup, loaded by vitest.config.mts `setupFiles`.
//
// Isolation model (verified empirically against @cloudflare/vitest-pool-workers 0.23.0):
// - Each test FILE gets its own Miniflare instance, so D1 (and any future KV) storage is
//   never shared between files, even when files run in parallel.
// - Within a file, storage persists from test to test. To keep tests order-independent,
//   this setup wipes every application table (and every KV namespace binding) before EACH
//   test. Seed data in `beforeEach` or inside the test itself; data seeded in `beforeAll`
//   is wiped before the first test runs.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";
import { resetStorage } from "./helpers/db";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetStorage();
});
