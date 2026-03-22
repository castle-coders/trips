import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { users, invites, participants, trips } from "../db/schema";
import { authMiddleware } from "../middleware/auth";

const app = new OpenAPIHono<Env>();

// ── Invite endpoints (public GET, authenticated POST) ─────────

const InviteInfoSchema = z
  .object({
    tripName: z.string(),
    inviterName: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: z.string(),
    expiresAt: z.string(),
  })
  .openapi("InviteInfo");

// Get invite info (public — CF Access cookie is sent automatically for same-org users)
app.openapi(
  createRoute({
    method: "get",
    path: "/invite/:token",
    tags: ["Auth"],
    request: {
      params: z.object({ token: z.string() }),
    },
    responses: {
      200: {
        description: "Invite details",
        content: { "application/json": { schema: InviteInfoSchema } },
      },
      404: { description: "Invite not found or expired" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { token } = c.req.valid("param");

    const rows = await db
      .select()
      .from(invites)
      .where(eq(invites.token, token))
      .limit(1);
    if (!rows.length || rows[0].status !== "pending")
      return c.json({ error: "Invite not found" }, 404);

    const invite = rows[0];
    if (new Date(invite.expiresAt) < new Date())
      return c.json({ error: "Invite has expired" }, 404);

    const tripRows = await db
      .select({ name: trips.name })
      .from(trips)
      .where(eq(trips.id, invite.tripId))
      .limit(1);
    const inviterRows = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, invite.invitedBy))
      .limit(1);

    return c.json(
      {
        tripName: tripRows[0]?.name ?? "Unknown trip",
        inviterName: inviterRows[0]?.name ?? "Someone",
        email: invite.email,
        name: invite.name ?? null,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
      200
    );
  }
);

const AuthResponseSchema = z
  .object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      role: z.string(),
    }),
  })
  .openapi("AuthResponse");

// Accept invite — user is already authenticated via CF Access
app.use("/invite/:token/accept", authMiddleware);
app.openapi(
  createRoute({
    method: "post",
    path: "/invite/:token/accept",
    tags: ["Auth"],
    request: {
      params: z.object({ token: z.string() }),
    },
    responses: {
      200: {
        description: "Invite accepted",
        content: { "application/json": { schema: AuthResponseSchema } },
      },
      404: { description: "Invite not found or expired" },
      409: { description: "Already a participant" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { token } = c.req.valid("param");
    const authUser = c.get("user");

    const inviteRows = await db
      .select()
      .from(invites)
      .where(eq(invites.token, token))
      .limit(1);
    if (!inviteRows.length || inviteRows[0].status !== "pending")
      return c.json({ error: "Invite not found" }, 404);

    const invite = inviteRows[0];
    if (new Date(invite.expiresAt) < new Date())
      return c.json({ error: "Invite has expired" }, 404);

    // Add as participant if not already
    const existingPart = await db
      .select()
      .from(participants)
      .where(eq(participants.tripId, invite.tripId));
    const alreadyIn = existingPart.find(
      (p) => p.userId === authUser.id || p.email === authUser.email
    );

    if (!alreadyIn) {
      const now = new Date().toISOString();
      await db.insert(participants).values({
        id: crypto.randomUUID(),
        tripId: invite.tripId,
        userId: authUser.id,
        email: authUser.email,
        name: authUser.name,
        role: invite.role,
        createdAt: now,
        updatedAt: now,
      });
    }

    await db
      .update(invites)
      .set({ status: "accepted" })
      .where(eq(invites.id, invite.id));

    return c.json(
      { user: { id: authUser.id, email: authUser.email, name: authUser.name, role: authUser.role } },
      200
    );
  }
);

// ── Authenticated routes ──────────────────────────────────────

app.use("/me", authMiddleware);
app.use("/me/*", authMiddleware);
app.use("/users", authMiddleware);

// List users (for invite user picker)
app.openapi(
  createRoute({
    method: "get",
    path: "/users",
    tags: ["Auth"],
    responses: {
      200: {
        description: "List of users",
        content: {
          "application/json": {
            schema: z.array(
              z.object({ id: z.string(), email: z.string(), name: z.string() })
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users);
    return c.json(rows, 200);
  }
);

const MeResponseSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .openapi("MeResponse");

// Get current user
app.openapi(
  createRoute({
    method: "get",
    path: "/me",
    tags: ["Auth"],
    responses: {
      200: {
        description: "Current user",
        content: { "application/json": { schema: MeResponseSchema } },
      },
      404: { description: "User not found" },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, authUser.id))
      .limit(1);
    if (!rows.length) return c.json({ error: "User not found" }, 404);
    const u = rows[0];
    return c.json(
      { id: u.id, email: u.email, name: u.name, role: u.role, avatarUrl: u.avatarUrl ?? null },
      200
    );
  }
);

// Update profile (name only — email is managed by CF Access)
const UpdateProfileSchema = z
  .object({ name: z.string().min(1) })
  .openapi("UpdateProfileRequest");

app.openapi(
  createRoute({
    method: "put",
    path: "/me",
    tags: ["Auth"],
    request: {
      body: { content: { "application/json": { schema: UpdateProfileSchema } } },
    },
    responses: {
      200: {
        description: "Profile updated",
        content: { "application/json": { schema: MeResponseSchema } },
      },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const { name } = c.req.valid("json");

    await db
      .update(users)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(users.id, authUser.id));

    const rows = await db.select().from(users).where(eq(users.id, authUser.id)).limit(1);
    const u = rows[0];
    return c.json(
      { id: u.id, email: u.email, name: u.name, role: u.role, avatarUrl: u.avatarUrl ?? null },
      200
    );
  }
);

export default app;
