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
    }
  }
}
export {};
