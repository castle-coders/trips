import { createMiddleware } from "hono/factory";
import type { Env } from "../db";

export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});
