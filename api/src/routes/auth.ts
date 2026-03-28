import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { users, userEmails, accountLinkTokens, invites, participants, trips } from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { mergeAccounts } from "../lib/merge";

const app = new OpenAPIHono<Env>();

// ── Invite endpoints (public GET, authenticated POST) ─────────

const InviteInfoSchema = z
  .object({
    tripName: z.string(),
    inviterName: z.string(),
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

    // Add as participant if not already (check all linked emails)
    const [existingPart, userEmailRows] = await Promise.all([
      db.select().from(participants).where(eq(participants.tripId, invite.tripId)),
      db.select({ email: userEmails.email }).from(userEmails).where(eq(userEmails.userId, authUser.id)),
    ]);
    const userEmailSet = new Set(userEmailRows.map((e) => e.email));
    const alreadyIn = existingPart.find(
      (p) => p.userId === authUser.id || (p.email && userEmailSet.has(p.email))
    );

    // If the invite has a name, prefer it over the auto-derived name from the email.
    const resolvedName = invite.name || authUser.name;
    if (invite.name && invite.name !== authUser.name) {
      await db
        .update(users)
        .set({ name: resolvedName, updatedAt: new Date().toISOString() })
        .where(eq(users.id, authUser.id));
    }

    if (!alreadyIn) {
      const now = new Date().toISOString();
      await db.insert(participants).values({
        id: crypto.randomUUID(),
        tripId: invite.tripId,
        userId: authUser.id,
        email: authUser.email,
        name: resolvedName,
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
      { user: { id: authUser.id, email: authUser.email, name: resolvedName, role: authUser.role } },
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

const EmailSchema = z.object({
  id: z.string(),
  email: z.string(),
  isPrimary: z.boolean(),
});

const MeResponseSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.string(),
    avatarUrl: z.string().nullable(),
    emails: z.array(EmailSchema),
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
    const [userRows, emailRows] = await Promise.all([
      db.select().from(users).where(eq(users.id, authUser.id)).limit(1),
      db
        .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
        .from(userEmails)
        .where(eq(userEmails.userId, authUser.id)),
    ]);
    if (!userRows.length) return c.json({ error: "User not found" }, 404);
    const u = userRows[0];
    return c.json(
      {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        avatarUrl: u.avatarUrl ?? null,
        emails: emailRows,
      },
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

    const [userRows, emailRows] = await Promise.all([
      db.select().from(users).where(eq(users.id, authUser.id)).limit(1),
      db
        .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
        .from(userEmails)
        .where(eq(userEmails.userId, authUser.id)),
    ]);
    const u = userRows[0];
    return c.json(
      {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        avatarUrl: u.avatarUrl ?? null,
        emails: emailRows,
      },
      200
    );
  }
);

// ── Link token + email management ────────────────────────────

// Auth middleware already applied via /me and /me/* above

// Generate a link token for account linking
app.openapi(
  createRoute({
    method: "post",
    path: "/me/link-token",
    tags: ["Auth"],
    responses: {
      200: {
        description: "Link token generated",
        content: {
          "application/json": {
            schema: z.object({ token: z.string(), expiresAt: z.string() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);

    // Delete any existing tokens for this user
    await db.delete(accountLinkTokens).where(eq(accountLinkTokens.userId, authUser.id));

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes
    const token = crypto.randomUUID();

    await db.insert(accountLinkTokens).values({
      id: crypto.randomUUID(),
      userId: authUser.id,
      token,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    });

    return c.json({ token, expiresAt: expiresAt.toISOString() }, 200);
  }
);

// Preview a link token — shows destination account details without consuming
const LinkPreviewSchema = z
  .object({
    destinationAccount: z.object({
      name: z.string(),
      email: z.string(),
    }),
    isSelf: z.boolean(),
  })
  .openapi("LinkPreview");

app.openapi(
  createRoute({
    method: "post",
    path: "/me/link-preview",
    tags: ["Auth"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ token: z.string() }).openapi("LinkPreviewRequest"),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Link preview",
        content: { "application/json": { schema: LinkPreviewSchema } },
      },
      404: { description: "Token not found or expired" },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const { token } = c.req.valid("json");

    const tokenRows = await db
      .select()
      .from(accountLinkTokens)
      .where(eq(accountLinkTokens.token, token))
      .limit(1);

    if (!tokenRows.length) return c.json({ error: "Token not found" }, 404);

    const linkToken = tokenRows[0];
    if (new Date(linkToken.expiresAt) < new Date()) {
      await db.delete(accountLinkTokens).where(eq(accountLinkTokens.id, linkToken.id));
      return c.json({ error: "Token has expired" }, 404);
    }

    const destRows = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, linkToken.userId))
      .limit(1);

    if (!destRows.length) return c.json({ error: "Token not found" }, 404);

    return c.json(
      {
        destinationAccount: destRows[0],
        isSelf: linkToken.userId === authUser.id,
      },
      200
    );
  }
);

// Consume a link token to merge accounts
app.openapi(
  createRoute({
    method: "post",
    path: "/me/link",
    tags: ["Auth"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ token: z.string() }).openapi("LinkRequest"),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Accounts merged",
        content: { "application/json": { schema: MeResponseSchema } },
      },
      400: { description: "Cannot link to yourself" },
      404: { description: "Token not found or expired" },
    },
  }),
  async (c) => {
    const authUser = c.get("user"); // "account B" — the one entering the token
    const db = getDb(c.env.DB);
    const { token } = c.req.valid("json");

    // Atomically select + delete the token to prevent TOCTOU races
    const linkToken = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(accountLinkTokens)
        .where(eq(accountLinkTokens.token, token))
        .limit(1);
      if (!rows.length) return null;
      await tx.delete(accountLinkTokens).where(eq(accountLinkTokens.id, rows[0].id));
      return rows[0];
    });

    if (!linkToken) return c.json({ error: "Token not found or already used" }, 404);
    if (new Date(linkToken.expiresAt) < new Date()) {
      return c.json({ error: "Token has expired" }, 404);
    }

    const keepUserId = linkToken.userId; // "account A" — the one that generated the token

    if (keepUserId === authUser.id) {
      // Same user logged back in with the same email — no merge needed
      const [userRows, emailRows] = await Promise.all([
        db.select().from(users).where(eq(users.id, authUser.id)).limit(1),
        db
          .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
          .from(userEmails)
          .where(eq(userEmails.userId, authUser.id)),
      ]);
      const u = userRows[0];
      return c.json(
        {
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          avatarUrl: u.avatarUrl ?? null,
          emails: emailRows,
        },
        200
      );
    }

    // Merge account B (current user) into account A (token owner)
    // promoteRole: false — self-service linking never escalates privileges
    await mergeAccounts(db, keepUserId, authUser.id, { promoteRole: false });

    // Return the merged account A
    const [userRows, emailRows] = await Promise.all([
      db.select().from(users).where(eq(users.id, keepUserId)).limit(1),
      db
        .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
        .from(userEmails)
        .where(eq(userEmails.userId, keepUserId)),
    ]);
    const u = userRows[0];
    return c.json(
      {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        avatarUrl: u.avatarUrl ?? null,
        emails: emailRows,
      },
      200
    );
  }
);

// Remove a linked email
app.openapi(
  createRoute({
    method: "delete",
    path: "/me/emails/{emailId}",
    tags: ["Auth"],
    request: {
      params: z.object({ emailId: z.string() }),
    },
    responses: {
      200: {
        description: "Email removed",
        content: {
          "application/json": { schema: z.array(EmailSchema) },
        },
      },
      400: { description: "Cannot remove primary or only email" },
      404: { description: "Email not found" },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const { emailId } = c.req.valid("param");

    const emailRows = await db
      .select()
      .from(userEmails)
      .where(and(eq(userEmails.id, emailId), eq(userEmails.userId, authUser.id)));

    if (!emailRows.length) return c.json({ error: "Email not found" }, 404);

    const emailRow = emailRows[0];
    if (emailRow.isPrimary) return c.json({ error: "Cannot remove primary email" }, 400);

    const allEmails = await db
      .select()
      .from(userEmails)
      .where(eq(userEmails.userId, authUser.id));
    if (allEmails.length <= 1) return c.json({ error: "Cannot remove only email" }, 400);

    await db.delete(userEmails).where(eq(userEmails.id, emailId));

    const remaining = await db
      .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
      .from(userEmails)
      .where(eq(userEmails.userId, authUser.id));
    return c.json(remaining, 200);
  }
);

// Set an email as primary
app.openapi(
  createRoute({
    method: "put",
    path: "/me/emails/{emailId}/primary",
    tags: ["Auth"],
    request: {
      params: z.object({ emailId: z.string() }),
    },
    responses: {
      200: {
        description: "Primary email updated",
        content: {
          "application/json": { schema: z.array(EmailSchema) },
        },
      },
      404: { description: "Email not found" },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const { emailId } = c.req.valid("param");

    const emailRows = await db
      .select()
      .from(userEmails)
      .where(and(eq(userEmails.id, emailId), eq(userEmails.userId, authUser.id)));

    if (!emailRows.length) return c.json({ error: "Email not found" }, 404);

    await db.transaction(async (tx) => {
      await tx
        .update(userEmails)
        .set({ isPrimary: false })
        .where(eq(userEmails.userId, authUser.id));
      await tx
        .update(userEmails)
        .set({ isPrimary: true })
        .where(eq(userEmails.id, emailId));
      await tx
        .update(users)
        .set({ email: emailRows[0].email, updatedAt: new Date().toISOString() })
        .where(eq(users.id, authUser.id));
    });

    const updated = await db
      .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
      .from(userEmails)
      .where(eq(userEmails.userId, authUser.id));
    return c.json(updated, 200);
  }
);

export default app;
