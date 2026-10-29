import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { getDb, requestIdFrom, type Actor, type Env } from "../db";
import { users, userEmails, accountLinkTokens, invites, trips } from "../db/schema";
import { authMiddleware, jwtOnlyMiddleware, findUserByEmail, createUserWithEmail } from "../middleware/auth";
import { acceptInvite } from "../services/invites";
import { mergeAccountsD1 } from "../lib/merge";
import { recordEvent } from "../services/audit";
import { listUserEmails, setPrimaryEmail, unlinkEmail, updateProfile } from "../services/users";
import { OAUTH_NOT_CONFIGURED, getGrant, isOAuthConfigured, listGrantsForUser, revokeAllGrantsForUser, revokeGrant } from "../oauth/grants";

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

    // Channel mirrors the session when jwtOnlyMiddleware resolved one (dev vs web); new users default to web.
    const session = c.get("user") as Actor | undefined;
    const audit = { channel: session?.channel ?? "web", requestId: requestIdFrom(c.req.header("cf-ray")) } as const;

    // Resolve or create user (user.create rides the same channel and request id as the accept events)
    let authUser = await findUserByEmail(db, identity.email);
    if (!authUser) {
      authUser = await createUserWithEmail(db, identity.email, identity.name, c.env.BOOTSTRAP_ADMIN_EMAIL, audit);
    }

    // Every write the acceptance causes (name update, participant, invite status) and its audit
    // events run in one batch in the service, with the accepting user as actor.
    const actor: Actor = { ...authUser, clientId: null, ...audit };
    const { resolvedName } = await acceptInvite(db, actor, invite);

    // Return HTML redirect for browser form submissions, JSON for API calls
    const accept = c.req.header("Accept") || "";
    const contentType = c.req.header("Content-Type") || "";
    if (accept.includes("text/html") || contentType.includes("x-www-form-urlencoded")) {
      const tripRows = await db.select({ name: trips.name }).from(trips).where(eq(trips.id, invite.tripId)).limit(1);
      const tripName = tripRows[0]?.name ?? "the trip";
      return htmlPage("Invite Accepted", `
        <h1>Welcome to ${tripName}!</h1>
        <p>You've joined the trip. Redirecting you to the app...</p>
        <a href="/" class="btn">Go to Trips</a>
        <script>setTimeout(() => window.location.href = "/", 2000);</script>
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
    const body = c.req.valid("json");

    // user.update in the service; an unchanged name writes nothing (TDD 12).
    const u = await updateProfile(db, authUser, body);
    const emailRows = (await listUserEmails(db, authUser.id)).map((e) => ({ id: e.id, email: e.email, isPrimary: e.isPrimary }));
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

      // The token owner may have been deleted since the token was issued. Check before revoking,
      // so a dead link never disconnects the caller's apps; same response as an unknown token.
      const keepExists = await db.select({ id: users.id }).from(users).where(eq(users.id, keepUserId)).limit(1);
      if (!keepExists.length) return c.json({ error: "Token not found or already used" }, 404);

      if (keepUserId !== authUser.id) {
        // Merge account B (current user) into account A (token owner)
        console.log("[link] Starting merge:", keepUserId, "<-", authUser.id);
        // Revoke the merged-away account's OAuth grants before its row is deleted; a throw lands
        // in the catch below (500) before any D1 change. The keep user must re-consent.
        await revokeAllGrantsForUser(c.env, authUser.id);
        await mergeAccountsD1(db, authUser, keepUserId, authUser.id, { promoteRole: false });
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
      // Detail stays server-side: KV/revocation failures must not reach the response body.
      console.error("[link] Error:", err?.message, err?.stack);
      return c.json({ error: "Internal server error" }, 500);
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

    // 404 / 400 come from ServiceError through onError, same messages as before.
    await unlinkEmail(db, authUser, emailId);

    const remaining = (await listUserEmails(db, authUser.id)).map((e) => ({ id: e.id, email: e.email, isPrimary: e.isPrimary }));
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

    // The three data statements and user_email.set_primary run in one batch in the service.
    await setPrimaryEmail(db, authUser, emailId);

    const updated = (await listUserEmails(db, authUser.id)).map((e) => ({ id: e.id, email: e.email, isPrimary: e.isPrimary }));
    return c.json(updated, 200);
  }
);

// ── OAuth grants (connected apps) for the signed-in user (Stage 2, TDD 7.5) ──
// Covered by the authMiddleware on "/me/*" above. Stage 2 off: list returns [], revoke 503.

const OAuthGrantSchema = z
  .object({
    id: z.string().openapi({ description: "Grant id" }),
    clientId: z.string(),
    clientName: z.string().nullable().openapi({ description: "Null for unknown, deleted or metadata-document (URL) clients" }),
    scopes: z.array(z.string()),
    createdAt: z.string().openapi({ description: "ISO 8601" }),
    expiresAt: z.string().nullable().openapi({ description: "ISO 8601; null when no expiry is recorded" }),
  })
  .openapi("OAuthGrant");

// List the caller's grants
app.openapi(
  createRoute({
    method: "get",
    path: "/me/grants",
    tags: ["Auth"],
    summary: "List the apps connected to your account through OAuth",
    responses: {
      200: {
        description: "Your grants, newest first; empty when OAuth is not configured",
        content: { "application/json": { schema: z.array(OAuthGrantSchema) } },
      },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    return c.json(await listGrantsForUser(c.env, authUser.id), 200);
  }
);

// Revoke one of the caller's grants
app.openapi(
  createRoute({
    method: "delete",
    path: "/me/grants/{grantId}",
    tags: ["Auth"],
    summary: "Disconnect an app: revoke one of your grants and all its tokens",
    request: {
      params: z.object({ grantId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
    },
    responses: {
      204: { description: "Revoked; the grant's access and refresh tokens no longer work" },
      404: { description: "Not one of your grants", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
      503: { description: "OAuth (Stage 2) is not configured", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    if (!isOAuthConfigured(c.env)) return c.json({ error: OAUTH_NOT_CONFIGURED }, 503);
    const authUser = c.get("user");
    const { grantId } = c.req.valid("param");
    // Membership is checked against listUserGrants(caller) in getGrant and again inside
    // revokeGrant; another user's grant id is indistinguishable from a missing one.
    const grant = await getGrant(c.env, authUser.id, grantId);
    if (!grant) return c.json({ error: "Grant not found" }, 404);
    const revoked = await revokeGrant(c.env, authUser.id, grantId);
    if (!revoked) return c.json({ error: "Grant not found" }, 404);
    // AUDIT_TDD 7.4: KV cannot share a D1 batch, so the event is recorded after the KV write.
    // The view never carries a token hash; the snapshot and metadata are built from it by hand.
    await recordEvent(getDb(c.env.DB), {
      actor: authUser,
      tripId: null,
      entityType: "oauth_grant",
      entityId: grantId,
      action: "revoke",
      before: {
        grantId: grant.id,
        userId: authUser.id,
        clientId: grant.clientId,
        clientName: grant.clientName,
        scopes: grant.scopes,
        createdAt: grant.createdAt,
      },
      metadata: { scopes: grant.scopes, clientId: grant.clientId, selfService: true },
    });
    return c.body(null, 204);
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
      <a href="/" class="btn">Go to Trips</a>
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

    // The token owner may have been deleted since the token was issued. Check before revoking,
    // so a dead link never disconnects the caller's apps; same response as an unknown token.
    const keepExists = await db.select({ id: users.id }).from(users).where(eq(users.id, keepUserId)).limit(1);
    if (!keepExists.length) {
      return htmlError("Link Not Found", "This account link is invalid or has already been used.");
    }

    // Actor for the merge (and for user.create when the caller is new): the linking user,
    // with the session's channel when jwtOnlyMiddleware resolved one (dev vs web).
    const session = c.get("user") as Actor | undefined;
    const audit = { channel: session?.channel ?? "web", requestId: requestIdFrom(c.req.header("cf-ray")) } as const;
    let authUser = await findUserByEmail(db, identity.email);
    if (!authUser) {
      authUser = await createUserWithEmail(db, identity.email, identity.name, c.env.BOOTSTRAP_ADMIN_EMAIL, audit);
    }
    const actor: Actor = { ...authUser, channel: audit.channel, clientId: null, requestId: audit.requestId };

    if (keepUserId !== authUser.id) {
      // Revoke the merged-away account's OAuth grants before its row is deleted; a throw lands
      // in the catch below (500) before any D1 change. The keep user must re-consent.
      await revokeAllGrantsForUser(c.env, authUser.id);
      await mergeAccountsD1(db, actor, keepUserId, authUser.id, { promoteRole: false });
    }

    return htmlPage("Accounts Linked", `
      <h1>Accounts Linked</h1>
      <p>Your accounts have been merged successfully. Redirecting you to the app...</p>
      <a href="/" class="btn">Go to Trips</a>
      <script>setTimeout(() => window.location.href = "/", 2000);</script>
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

      // The token owner may have been deleted since the token was issued. Check before revoking,
      // so a dead link never disconnects the caller's apps; same response as an unknown token.
      const keepExists = await db.select({ id: users.id }).from(users).where(eq(users.id, keepUserId)).limit(1);
      if (!keepExists.length) return c.json({ error: "Token not found or already used" }, 404);

      // Actor for the merge (and for user.create when the caller is new): the linking user,
      // with the session's channel when jwtOnlyMiddleware resolved one (dev vs web).
      const session = c.get("user") as Actor | undefined;
      const audit = { channel: session?.channel ?? "web", requestId: requestIdFrom(c.req.header("cf-ray")) } as const;
      let authUser = await findUserByEmail(db, identity.email);
      if (!authUser) {
        authUser = await createUserWithEmail(db, identity.email, identity.name, c.env.BOOTSTRAP_ADMIN_EMAIL, audit);
      }
      const actor: Actor = { ...authUser, channel: audit.channel, clientId: null, requestId: audit.requestId };

      if (keepUserId !== authUser.id) {
        // Revoke the merged-away account's OAuth grants before its row is deleted; a throw lands
        // in the catch below (500) before any D1 change. The keep user must re-consent.
        await revokeAllGrantsForUser(c.env, authUser.id);
        await mergeAccountsD1(db, actor, keepUserId, authUser.id, { promoteRole: false });
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
      // Detail stays server-side: KV/revocation failures must not reach the response body.
      console.error("[link] Error:", err?.message, err?.stack);
      return c.json({ error: "Internal server error" }, 500);
    }
  }
);

export default app;
