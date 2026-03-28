import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { users, userEmails, accountLinkTokens, invites, participants, trips } from "../db/schema";
import { authMiddleware, jwtOnlyMiddleware, findUserByEmail, createUserWithEmail } from "../middleware/auth";
import { mergeAccountsD1 } from "../lib/merge";

const app = new OpenAPIHono<Env>();

// ── HTML helpers ─────────────────────────────────────────────

function htmlPage(title: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Trips</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #1a1a1a; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); padding: 2rem; max-width: 420px; width: 100%; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    p { color: #555; margin-bottom: 0.75rem; line-height: 1.5; }
    .meta { font-size: 0.875rem; color: #888; }
    .btn { display: inline-block; background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 0.75rem 1.5rem; font-size: 1rem; cursor: pointer; text-decoration: none; margin-top: 1rem; }
    .btn:hover { background: #1d4ed8; }
    .error { color: #dc2626; }
  </style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function htmlError(title: string, message: string, status = 404): Response {
  const res = htmlPage(title, `<h1 class="error">${title}</h1><p>${message}</p>`);
  return new Response(res.body, { status, headers: res.headers });
}

// ── Invite lookup helper ─────────────────────────────────────

async function lookupInvite(db: ReturnType<typeof getDb>, token: string) {
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1);
  if (!rows.length || rows[0].status !== "pending") return null;
  const invite = rows[0];
  if (new Date(invite.expiresAt) < new Date()) return null;

  const [tripRows, inviterRows] = await Promise.all([
    db.select({ name: trips.name }).from(trips).where(eq(trips.id, invite.tripId)).limit(1),
    db.select({ name: users.name }).from(users).where(eq(users.id, invite.invitedBy)).limit(1),
  ]);

  return {
    invite,
    tripName: tripRows[0]?.name ?? "Unknown trip",
    inviterName: inviterRows[0]?.name ?? "Someone",
  };
}

// ── Invite endpoints ─────────────────────────────────────────

const InviteInfoSchema = z
  .object({
    tripName: z.string(),
    inviterName: z.string(),
    role: z.string(),
    expiresAt: z.string(),
  })
  .openapi("InviteInfo");

// GET /invite/:token — returns JSON (for SPA) or HTML (for direct browser access)
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
    const result = await lookupInvite(db, token);

    if (!result) {
      const accept = c.req.header("Accept") || "";
      if (accept.includes("text/html")) {
        return htmlError("Invite Not Found", "This invite link is invalid or has expired.");
      }
      return c.json({ error: "Invite not found" }, 404);
    }

    const { invite, tripName, inviterName } = result;
    const accept = c.req.header("Accept") || "";

    if (accept.includes("text/html")) {
      return htmlPage("Accept Invite", `
        <h1>You're invited!</h1>
        <p><strong>${inviterName}</strong> invited you to join <strong>${tripName}</strong> as ${invite.role}.</p>
        <p class="meta">Expires ${new Date(invite.expiresAt).toLocaleDateString()}</p>
        <form method="POST" action="/api/auth/invite/${token}/accept">
          <button type="submit" class="btn">Accept Invite</button>
        </form>
      `);
    }

    return c.json({ tripName, inviterName, role: invite.role, expiresAt: invite.expiresAt }, 200);
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

// Accept invite — uses jwtOnlyMiddleware so unknown users can accept invites
app.use("/invite/:token/accept", jwtOnlyMiddleware);
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
    const identity = c.get("cfIdentity");

    // Validate invite before creating any user
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

    // Resolve or create user
    let authUser = await findUserByEmail(db, identity.email);
    if (!authUser) {
      authUser = await createUserWithEmail(db, identity.email, identity.name, c.env.BOOTSTRAP_ADMIN_EMAIL);
    }

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

    // Return HTML redirect for browser form submissions, JSON for API calls
    const accept = c.req.header("Accept") || "";
    const contentType = c.req.header("Content-Type") || "";
    if (accept.includes("text/html") || contentType.includes("x-www-form-urlencoded")) {
      const tripRows = await db.select({ name: trips.name }).from(trips).where(eq(trips.id, invite.tripId)).limit(1);
      const tripName = tripRows[0]?.name ?? "the trip";
      return htmlPage("Invite Accepted", `
        <h1>Welcome to ${tripName}!</h1>
        <p>You've joined the trip. Redirecting you to the app...</p>
        <a href="https://trips.prenticew.com/" class="btn">Go to Trips</a>
        <script>setTimeout(() => window.location.href = "https://trips.prenticew.com/", 2000);</script>
      `);
    }

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

    try {
      // D1 doesn't support BEGIN/COMMIT transactions — use sequential queries
      // (D1 Workers requests are single-threaded, so no TOCTOU within a request)
      console.log("[link] Looking up token for user", authUser.id);
      const rows = await db
        .select()
        .from(accountLinkTokens)
        .where(eq(accountLinkTokens.token, token))
        .limit(1);
      console.log("[link] Token lookup rows:", rows.length);
      if (!rows.length) return c.json({ error: "Token not found or already used" }, 404);

      const linkToken = rows[0];
      await db.delete(accountLinkTokens).where(eq(accountLinkTokens.id, linkToken.id));

      if (new Date(linkToken.expiresAt) < new Date()) {
        return c.json({ error: "Token has expired" }, 404);
      }

      const keepUserId = linkToken.userId; // "account A" — the one that generated the token
      console.log("[link] keepUserId:", keepUserId, "mergeUserId:", authUser.id);

      if (keepUserId !== authUser.id) {
        // Merge account B (current user) into account A (token owner)
        console.log("[link] Starting merge:", keepUserId, "<-", authUser.id);
        await mergeAccountsD1(db, keepUserId, authUser.id, { promoteRole: false });
        console.log("[link] Merge complete");
      } else {
        console.log("[link] Same user, no merge needed");
      }

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
    } catch (err: any) {
      console.error("[link] Error:", err.message, err.stack);
      return c.json({ error: err.message || "Internal server error" }, 500);
    }
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

    // D1 doesn't support BEGIN/COMMIT — use batch() for atomicity
    await db.batch([
      db.update(userEmails).set({ isPrimary: false }).where(eq(userEmails.userId, authUser.id)),
      db.update(userEmails).set({ isPrimary: true }).where(eq(userEmails.id, emailId)),
      db.update(users).set({ email: emailRows[0].email, updatedAt: new Date().toISOString() }).where(eq(users.id, authUser.id)),
    ]);

    const updated = await db
      .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
      .from(userEmails)
      .where(eq(userEmails.userId, authUser.id));
    return c.json(updated, 200);
  }
);

// ── Account linking routes for unknown users (jwtOnlyMiddleware) ──

// GET /link/:token — HTML page showing link preview + confirm button
app.use("/link/:token", jwtOnlyMiddleware);
app.get("/link/:token", async (c) => {
  const db = getDb(c.env.DB);
  const identity = c.get("cfIdentity");
  const token = c.req.param("token");

  const tokenRows = await db
    .select()
    .from(accountLinkTokens)
    .where(eq(accountLinkTokens.token, token))
    .limit(1);

  if (!tokenRows.length) {
    return htmlError("Link Not Found", "This account link is invalid or has already been used.");
  }

  const linkToken = tokenRows[0];
  if (new Date(linkToken.expiresAt) < new Date()) {
    await db.delete(accountLinkTokens).where(eq(accountLinkTokens.id, linkToken.id));
    return htmlError("Link Expired", "This account link has expired. Please request a new one.");
  }

  const destRows = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, linkToken.userId))
    .limit(1);

  if (!destRows.length) {
    return htmlError("Link Not Found", "The destination account no longer exists.");
  }

  const dest = destRows[0];
  const existingUser = await findUserByEmail(db, identity.email);
  const isSelf = existingUser ? linkToken.userId === existingUser.id : false;

  if (isSelf) {
    return htmlPage("Already Linked", `
      <h1>Already Linked</h1>
      <p>This link token belongs to your own account. No action needed.</p>
      <a href="https://trips.prenticew.com/" class="btn">Go to Trips</a>
    `);
  }

  return htmlPage("Link Accounts", `
    <h1>Link Your Account</h1>
    <p>You're about to link your email <strong>${identity.email}</strong> to the account owned by <strong>${dest.name}</strong> (${dest.email}).</p>
    <p>Your current account will be merged into theirs.</p>
    <form method="POST" action="/api/auth/link/${token}/confirm">
      <button type="submit" class="btn">Confirm Link</button>
    </form>
  `);
});

// POST /link/:token — performs the merge and redirects
app.use("/link/:token/confirm", jwtOnlyMiddleware);
app.post("/link/:token/confirm", async (c) => {
  const db = getDb(c.env.DB);
  const identity = c.get("cfIdentity");
  const token = c.req.param("token");

  try {
    const rows = await db
      .select()
      .from(accountLinkTokens)
      .where(eq(accountLinkTokens.token, token))
      .limit(1);
    if (!rows.length) {
      return htmlError("Link Not Found", "This account link is invalid or has already been used.");
    }

    const linkToken = rows[0];
    await db.delete(accountLinkTokens).where(eq(accountLinkTokens.id, linkToken.id));

    if (new Date(linkToken.expiresAt) < new Date()) {
      return htmlError("Link Expired", "This account link has expired. Please request a new one.");
    }

    const keepUserId = linkToken.userId;

    let authUser = await findUserByEmail(db, identity.email);
    if (!authUser) {
      authUser = await createUserWithEmail(db, identity.email, identity.name, c.env.BOOTSTRAP_ADMIN_EMAIL);
    }

    if (keepUserId !== authUser.id) {
      await mergeAccountsD1(db, keepUserId, authUser.id, { promoteRole: false });
    }

    return htmlPage("Accounts Linked", `
      <h1>Accounts Linked</h1>
      <p>Your accounts have been merged successfully. Redirecting you to the app...</p>
      <a href="https://trips.prenticew.com/" class="btn">Go to Trips</a>
      <script>setTimeout(() => window.location.href = "https://trips.prenticew.com/", 2000);</script>
    `);
  } catch (err: any) {
    console.error("[link] Error:", err.message, err.stack);
    return htmlError("Error", "Something went wrong while linking accounts. Please try again.", 500);
  }
});

// ── JSON account linking routes (for SPA) ──

app.use("/link-preview", jwtOnlyMiddleware);
app.openapi(
  createRoute({
    method: "post",
    path: "/link-preview",
    tags: ["Auth"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ token: z.string() }).openapi("LinkPreviewRequest2"),
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
    const identity = c.get("cfIdentity");
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

    const existingUser = await findUserByEmail(db, identity.email);
    const isSelf = existingUser ? linkToken.userId === existingUser.id : false;

    return c.json(
      {
        destinationAccount: destRows[0],
        isSelf,
      },
      200
    );
  }
);

app.use("/link", jwtOnlyMiddleware);
app.openapi(
  createRoute({
    method: "post",
    path: "/link",
    tags: ["Auth"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ token: z.string() }).openapi("LinkRequest2"),
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
    const identity = c.get("cfIdentity");
    const db = getDb(c.env.DB);
    const { token } = c.req.valid("json");

    try {
      const rows = await db
        .select()
        .from(accountLinkTokens)
        .where(eq(accountLinkTokens.token, token))
        .limit(1);
      if (!rows.length) return c.json({ error: "Token not found or already used" }, 404);

      const linkToken = rows[0];
      await db.delete(accountLinkTokens).where(eq(accountLinkTokens.id, linkToken.id));

      if (new Date(linkToken.expiresAt) < new Date()) {
        return c.json({ error: "Token has expired" }, 404);
      }

      const keepUserId = linkToken.userId;

      let authUser = await findUserByEmail(db, identity.email);
      if (!authUser) {
        authUser = await createUserWithEmail(db, identity.email, identity.name, c.env.BOOTSTRAP_ADMIN_EMAIL);
      }

      if (keepUserId !== authUser.id) {
        await mergeAccountsD1(db, keepUserId, authUser.id, { promoteRole: false });
      }

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
    } catch (err: any) {
      console.error("[link] Error:", err.message, err.stack);
      return c.json({ error: err.message || "Internal server error" }, 500);
    }
  }
);

export default app;
