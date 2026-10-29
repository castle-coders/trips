import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    // Types `exports` from "cloudflare:workers" (exports.default is the real Worker's loopback).
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
    interface Env {
      DB: D1Database;
      EVAL_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
      TEST_MIGRATIONS: D1Migration[];
      // Stage 2 (wrangler.toml): OAuth provider storage and the two extra ratelimit bindings.
      OAUTH_KV: KVNamespace;
      MCP_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
      OAUTH_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
      // Stage 2 vars are "" in wrangler.toml; tests override them per request.
      MCP_HOST: string;
      MCP_PUBLIC_URL: string;
    }
  }
}
export {};
