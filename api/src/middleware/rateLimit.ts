import type { MiddlewareHandler } from "hono";
import type { Env } from "../db";

interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

type EvalEnv = Env & {
  Bindings: Env["Bindings"] & { EVAL_RATE_LIMITER?: RateLimiter };
};

export const evalRateLimit: MiddlewareHandler<EvalEnv> = async (c, next) => {
  const limiter = c.env.EVAL_RATE_LIMITER;
  if (!limiter) return next();

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: ip });
  if (!success) {
    return c.json({ error: "Too many requests" }, 429);
  }
  return next();
};
