import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("workerd smoke", () => {
  it("applies drizzle migrations to the local D1 binding", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").first();
    expect(row).toEqual({ name: "users" });
  });

  it("exposes the unsafe ratelimit binding", async () => {
    const res = await env.EVAL_RATE_LIMITER.limit({ key: "smoke" });
    expect(res.success).toBe(true);
  });

  it("serves the real Worker: GET /api/trips without auth is 401", async () => {
    const res = await exports.default.fetch("https://example.test/api/trips");
    expect(res.status).toBe(401);
  });
});
