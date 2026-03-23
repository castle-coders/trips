import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { invites, trips } from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { getTripRole } from "../middleware/tripRole";
import { SignJWT } from "jose";

const app = new OpenAPIHono<Env>();

const InviteSchema = z
  .object({
    id: z.string(),
    tripId: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: z.string(),
    token: z.string(),
    status: z.string(),
    invitedBy: z.string(),
    expiresAt: z.string(),
    createdAt: z.string(),
    tripName: z.string().optional(),
    inviterName: z.string().optional(),
  })
  .openapi("Invite");

const CreateInviteSchema = z
  .object({
    role: z.enum(["Owner", "Editor", "Viewer"]).default("Viewer"),
  })
  .openapi("CreateInvite");

// List invites for a trip (authenticated, editors/owners only)
app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Invites"],
    request: {
      params: z.object({ tripId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: "List of invites",
        content: { "application/json": { schema: z.array(InviteSchema) } },
      },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const user = c.get("user");
    const role = await getTripRole(db, tripId, user.id, user.role);
    if (role === "Viewer") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const rows = await db
      .select()
      .from(invites)
      .where(eq(invites.tripId, tripId));
    return c.json(rows as any, 200);
  }
);

// Create invite (authenticated, owners only)
app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Invites"],
    request: {
      params: z.object({ tripId: z.string().uuid() }),
      body: {
        content: { "application/json": { schema: CreateInviteSchema } },
      },
    },
    responses: {
      201: {
        description: "Invite created",
        content: { "application/json": { schema: InviteSchema } },
      },
      403: { description: "Forbidden" },
      404: { description: "Trip not found" },
      409: { description: "Already invited or already a participant" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const user = c.get("user");
    const { tripId } = c.req.valid("param");

    // Only owners can create invites
    const tripRole = await getTripRole(db, tripId, user.id, user.role);
    if (tripRole !== "Owner") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { role } = c.req.valid("json");

    // Verify trip exists
    const tripRows = await db
      .select()
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    if (!tripRows.length) return c.json({ error: "Trip not found" }, 404);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const token = crypto.randomUUID();

    const row = {
      id: crypto.randomUUID(),
      tripId,
      email: null,
      name: null,
      role,
      token,
      status: "pending",
      invitedBy: user.id,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    };
    await db.insert(invites).values(row);

    return c.json(row as any, 201);
  }
);

// Delete / revoke invite (authenticated, owners only)
app.openapi(
  createRoute({
    method: "delete",
    path: "/{inviteId}",
    tags: ["Invites"],
    request: {
      params: z.object({
        tripId: z.string().uuid(),
        inviteId: z.string().uuid(),
      }),
    },
    responses: {
      204: { description: "Invite revoked" },
      403: { description: "Forbidden" },
      404: { description: "Invite not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const user = c.get("user");
    const { tripId, inviteId } = c.req.valid("param");

    const tripRole = await getTripRole(db, tripId, user.id, user.role);
    if (tripRole !== "Owner") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const rows = await db
      .select()
      .from(invites)
      .where(and(eq(invites.id, inviteId), eq(invites.tripId, tripId)))
      .limit(1);
    if (!rows.length) return c.json({ error: "Invite not found" }, 404);
    await db.delete(invites).where(eq(invites.id, inviteId));
    return c.body(null, 204);
  }
);

export default app;
