// mcpRateLimit on Stage 1: per-user (keyed on the resolved userId, not IP), 120 per 60 s
// from wrangler.toml MCP_RATE_LIMITER. Miniflare simulates the unsafe ratelimit binding locally.
import { describe, expect, it } from "vitest";
import { seedUser } from "./helpers";
import { mcpStage1 } from "./helpers/mcp";

describe("Stage 1 MCP rate limit", () => {
  it("answers 429 after the per-user limit and does not throttle a different user", async () => {
    const a = await seedUser(`rl-a-${crypto.randomUUID()}@example.test`, "editor");
    const b = await seedUser(`rl-b-${crypto.randomUUID()}@example.test`, "editor");
    const ca = mcpStage1(a.email, { "cf-connecting-ip": "203.0.113.7" });
    const cb = mcpStage1(b.email, { "cf-connecting-ip": "203.0.113.7" });
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) statuses.push((await ca.rpc("tools/list", {})).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(120)).toContain(429);
    const limited = await ca.rpc("tools/list", {});
    expect(limited.status).toBe(429);
    expect(limited.message).toEqual({ error: "Too many requests" });
    // Same IP, different user: not limited.
    expect((await cb.rpc("tools/list", {})).status).toBe(200);
  });
});
