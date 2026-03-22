import { createMiddleware } from "hono/factory";
import { eq, and } from "drizzle-orm";
import type { Env } from "../db";
import { getDb } from "../db";
import { participants } from "../db/schema";

/** Look up the authenticated user's participant role for a trip. */
export async function getTripRole(
  db: ReturnType<typeof getDb>,
  tripId: string,
  userId: string,
  globalRole: string
): Promise<string> {
  if (globalRole === "admin") return "Owner";
  const rows = await db
    .select({ role: participants.role })
    .from(participants)
    .where(and(eq(participants.tripId, tripId), eq(participants.userId, userId)))
    .limit(1);
  return rows.length ? rows[0].role : "Viewer";
}

/**
 * Middleware that blocks Viewer-role users from non-GET requests on trip-scoped routes.
 * Expects the URL to contain /trips/:tripId/...
 */
export const requireTripEditor = createMiddleware<Env>(async (c, next) => {
  // Allow all GET/HEAD/OPTIONS requests through — read access is handled per-route
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return next();
  }

  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // Extract tripId from the URL path: /trips/:tripId/...
  const match = c.req.path.match(/\/trips\/([0-9a-fA-F-]{36})/);
  if (!match) {
    // No tripId in path (e.g., POST /trips/ to create a new trip)
    if (user.role === "viewer") {
      return c.json({ error: "Forbidden: Viewers cannot create trips" }, 403);
    }
    return next();
  }

  const tripId = match[1];
  const db = getDb(c.env.DB);
  const role = await getTripRole(db, tripId, user.id, user.role);

  if (role === "Viewer") {
    return c.json({ error: "Forbidden" }, 403);
  }

  return next();
});
