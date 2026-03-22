import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import { getDb, type Env } from "../db";
import { users, invites, participants, trips } from "../db/schema";
import { hashPassword, verifyPassword } from "../lib/password";
import { authMiddleware } from "../middleware/auth";

const app = new OpenAPIHono<Env>();

const LoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .openapi("LoginRequest");

const AuthResponseSchema = z
  .object({
    token: z.string(),
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      role: z.string(),
    }),
  })
  .openapi("AuthResponse");

const RegisterSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
  })
  .openapi("RegisterRequest");

async function issueToken(
  userId: string,
  secret: string
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

// Login
app.openapi(
  createRoute({
    method: "post",
    path: "/login",
    tags: ["Auth"],
    request: {
      body: { content: { "application/json": { schema: LoginSchema } } },
    },
    responses: {
      200: {
        description: "Login successful",
        content: { "application/json": { schema: AuthResponseSchema } },
      },
      401: { description: "Invalid credentials" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { email, password } = c.req.valid("json");

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!rows.length) return c.json({ error: "Invalid credentials" }, 401);

    const user = rows[0];
    if (!user.passwordHash)
      return c.json({ error: "This account uses Google sign-in" }, 401);
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return c.json({ error: "Invalid credentials" }, 401);

    const token = await issueToken(user.id, c.env.JWT_SECRET);
    return c.json(
      {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      },
      200
    );
  }
);

// Register (first user becomes admin, subsequent users are viewers)
app.openapi(
  createRoute({
    method: "post",
    path: "/register",
    tags: ["Auth"],
    request: {
      body: { content: { "application/json": { schema: RegisterSchema } } },
    },
    responses: {
      201: {
        description: "Registration successful",
        content: { "application/json": { schema: AuthResponseSchema } },
      },
      409: { description: "Email already exists" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { email, password, name } = c.req.valid("json");

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length) return c.json({ error: "Email already exists" }, 409);

    // First user is admin
    const allUsers = await db.select({ id: users.id }).from(users).limit(1);
    const role = allUsers.length === 0 ? "admin" : "viewer";

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    await db.insert(users).values({
      id,
      email,
      name,
      passwordHash,
      role,
      createdAt: now,
      updatedAt: now,
    });

    const token = await issueToken(id, c.env.JWT_SECRET);
    return c.json({ token, user: { id, email, name, role } }, 201);
  }
);

// Google Sign-In
const googleJWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

const GoogleAuthSchema = z
  .object({
    credential: z.string().min(1),
  })
  .openapi("GoogleAuthRequest");

app.openapi(
  createRoute({
    method: "post",
    path: "/google",
    tags: ["Auth"],
    request: {
      body: {
        content: { "application/json": { schema: GoogleAuthSchema } },
      },
    },
    responses: {
      200: {
        description: "Google login successful",
        content: { "application/json": { schema: AuthResponseSchema } },
      },
      401: { description: "Invalid Google token" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { credential } = c.req.valid("json");

    // Verify Google ID token
    let payload;
    try {
      const result = await jwtVerify(credential, googleJWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: c.env.GOOGLE_CLIENT_ID,
      });
      payload = result.payload;
    } catch {
      return c.json({ error: "Invalid Google token" }, 401);
    }

    const googleId = payload.sub;
    const email = payload.email as string;
    const name = (payload.name as string) || email;
    const avatarUrl = (payload.picture as string) || null;

    if (!googleId || !email) {
      return c.json({ error: "Invalid Google token claims" }, 401);
    }

    // Check if user exists by googleId
    let userRows = await db
      .select()
      .from(users)
      .where(eq(users.googleId, googleId))
      .limit(1);

    if (!userRows.length) {
      // Check if user exists by email (link accounts)
      userRows = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (userRows.length) {
        // Link Google ID to existing account
        await db
          .update(users)
          .set({ googleId, avatarUrl, updatedAt: new Date().toISOString() })
          .where(eq(users.id, userRows[0].id));
      } else {
        // Create new user — first user is admin
        const allUsers = await db
          .select({ id: users.id })
          .from(users)
          .limit(1);
        const role = allUsers.length === 0 ? "admin" : "viewer";
        const now = new Date().toISOString();
        const id = crypto.randomUUID();

        await db.insert(users).values({
          id,
          email,
          name,
          googleId,
          avatarUrl,
          role,
          createdAt: now,
          updatedAt: now,
        });

        userRows = [
          { id, email, name, googleId, avatarUrl, passwordHash: null, role, createdAt: now, updatedAt: now },
        ];
      }
    }

    const user = userRows[0];
    const token = await issueToken(user.id, c.env.JWT_SECRET);
    return c.json(
      {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      },
      200
    );
  }
);

// ── Invite acceptance (public) ────────────────────────────────

const AcceptInviteSchema = z
  .object({
    token: z.string().min(1),
  })
  .openapi("AcceptInviteRequest");

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

// Get invite info (public, no auth required)
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

// Accept invite — authenticates with Google OR email/password, creates user if needed, adds as participant
app.openapi(
  createRoute({
    method: "post",
    path: "/invite/:token/accept",
    tags: ["Auth"],
    request: {
      params: z.object({ token: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                // Google auth
                googleCredential: z.string().optional(),
                // Or email/password auth
                password: z.string().min(8).optional(),
                name: z.string().min(1).optional(),
              })
              .openapi("AcceptInviteBody"),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Invite accepted, user authenticated",
        content: { "application/json": { schema: AuthResponseSchema } },
      },
      401: { description: "Invalid credentials" },
      404: { description: "Invite not found or expired" },
      409: { description: "Already a participant" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { token } = c.req.valid("param");
    const body = c.req.valid("json");

    // Validate invite
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

    let userId: string;
    let userName: string;
    let userEmail: string;
    let userRole: string;

    if (body.googleCredential) {
      // Google auth flow
      let payload;
      try {
        const result = await jwtVerify(body.googleCredential, googleJWKS, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: c.env.GOOGLE_CLIENT_ID,
        });
        payload = result.payload;
      } catch {
        return c.json({ error: "Invalid Google token" }, 401);
      }

      const googleId = payload.sub as string;
      const gEmail = payload.email as string;
      const gName = (payload.name as string) || gEmail;
      const avatarUrl = (payload.picture as string) || null;

      // Find or create user
      let userRows = await db
        .select()
        .from(users)
        .where(eq(users.googleId, googleId))
        .limit(1);

      if (!userRows.length) {
        userRows = await db
          .select()
          .from(users)
          .where(eq(users.email, gEmail))
          .limit(1);

        if (userRows.length) {
          // Link Google to existing account
          await db
            .update(users)
            .set({ googleId, avatarUrl, updatedAt: new Date().toISOString() })
            .where(eq(users.id, userRows[0].id));
        } else {
          // Create new user
          const now = new Date().toISOString();
          const id = crypto.randomUUID();
          await db.insert(users).values({
            id,
            email: gEmail,
            name: gName,
            googleId,
            avatarUrl,
            role: "viewer",
            createdAt: now,
            updatedAt: now,
          });
          userRows = [
            { id, email: gEmail, name: gName, googleId, avatarUrl, passwordHash: null, role: "viewer", createdAt: now, updatedAt: now },
          ];
        }
      }

      userId = userRows[0].id;
      userName = userRows[0].name;
      userEmail = userRows[0].email;
      userRole = userRows[0].role;
    } else if (body.password) {
      // Email/password flow — use the invite email
      const email = invite.email;
      let userRows = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (userRows.length) {
        // Existing user — verify password
        if (!userRows[0].passwordHash)
          return c.json({ error: "This account uses Google sign-in" }, 401);
        const valid = await verifyPassword(body.password, userRows[0].passwordHash);
        if (!valid)
          return c.json({ error: "Invalid password" }, 401);
      } else {
        // Create new user with password
        if (!body.name)
          return c.json({ error: "Name is required for new accounts" }, 401);
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const passwordHash = await hashPassword(body.password);
        await db.insert(users).values({
          id,
          email,
          name: body.name,
          passwordHash,
          role: "viewer",
          createdAt: now,
          updatedAt: now,
        });
        userRows = [
          { id, email, name: body.name, passwordHash, googleId: null, avatarUrl: null, role: "viewer", createdAt: now, updatedAt: now },
        ];
      }

      userId = userRows[0].id;
      userName = userRows[0].name;
      userEmail = userRows[0].email;
      userRole = userRows[0].role;
    } else {
      return c.json({ error: "Provide googleCredential or password" }, 401);
    }

    // Add as participant (check not already added)
    const existingPart = await db
      .select()
      .from(participants)
      .where(
        eq(participants.tripId, invite.tripId)
      );
    const alreadyIn = existingPart.find(
      (p) => p.userId === userId || p.email === userEmail
    );
    if (!alreadyIn) {
      const now = new Date().toISOString();
      await db.insert(participants).values({
        id: crypto.randomUUID(),
        tripId: invite.tripId,
        userId,
        email: userEmail,
        name: userName,
        role: invite.role,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Mark invite as accepted
    await db
      .update(invites)
      .set({ status: "accepted" })
      .where(eq(invites.id, invite.id));

    const appToken = await issueToken(userId, c.env.JWT_SECRET);
    return c.json(
      {
        token: appToken,
        user: { id: userId, email: userEmail, name: userName, role: userRole },
      },
      200
    );
  }
);

// ── Authenticated routes ──────────────────────────────────────

app.use("/me", authMiddleware);
app.use("/me/*", authMiddleware);
app.use("/users", authMiddleware);

// List users (for invite user picker, any authenticated user)
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
              z.object({
                id: z.string(),
                email: z.string(),
                name: z.string(),
              })
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
    hasPassword: z.boolean(),
    hasGoogle: z.boolean(),
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
      {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        hasPassword: !!u.passwordHash,
        hasGoogle: !!u.googleId,
        avatarUrl: u.avatarUrl ?? null,
      },
      200
    );
  }
);

// Update profile (name / email)
const UpdateProfileSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
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
      409: { description: "Email already taken" },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const body = c.req.valid("json");

    if (body.email) {
      const dup = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, body.email))
        .limit(1);
      if (dup.length && dup[0].id !== authUser.id)
        return c.json({ error: "Email already taken" }, 409);
    }

    await db
      .update(users)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(eq(users.id, authUser.id));

    const rows = await db.select().from(users).where(eq(users.id, authUser.id)).limit(1);
    const u = rows[0];
    return c.json(
      {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        hasPassword: !!u.passwordHash,
        hasGoogle: !!u.googleId,
        avatarUrl: u.avatarUrl ?? null,
      },
      200
    );
  }
);

// Change / set password
const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8),
  })
  .openapi("ChangePasswordRequest");

app.openapi(
  createRoute({
    method: "put",
    path: "/me/password",
    tags: ["Auth"],
    request: {
      body: {
        content: { "application/json": { schema: ChangePasswordSchema } },
      },
    },
    responses: {
      200: { description: "Password updated" },
      401: { description: "Current password incorrect" },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const { currentPassword, newPassword } = c.req.valid("json");

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, authUser.id))
      .limit(1);
    const u = rows[0];

    // If user already has a password, require current password
    if (u.passwordHash) {
      if (!currentPassword)
        return c.json({ error: "Current password is required" }, 401);
      const valid = await verifyPassword(currentPassword, u.passwordHash);
      if (!valid)
        return c.json({ error: "Current password is incorrect" }, 401);
    }

    const hash = await hashPassword(newPassword);
    await db
      .update(users)
      .set({ passwordHash: hash, updatedAt: new Date().toISOString() })
      .where(eq(users.id, authUser.id));

    return c.json({ ok: true }, 200);
  }
);

// Link Google account
const LinkGoogleSchema = z
  .object({ credential: z.string().min(1) })
  .openapi("LinkGoogleRequest");

app.openapi(
  createRoute({
    method: "post",
    path: "/me/link-google",
    tags: ["Auth"],
    request: {
      body: {
        content: { "application/json": { schema: LinkGoogleSchema } },
      },
    },
    responses: {
      200: {
        description: "Google account linked",
        content: { "application/json": { schema: MeResponseSchema } },
      },
      401: { description: "Invalid Google token" },
      409: { description: "Google account already linked to another user" },
    },
  }),
  async (c) => {
    const authUser = c.get("user");
    const db = getDb(c.env.DB);
    const { credential } = c.req.valid("json");

    let payload;
    try {
      const result = await jwtVerify(credential, googleJWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: c.env.GOOGLE_CLIENT_ID,
      });
      payload = result.payload;
    } catch {
      return c.json({ error: "Invalid Google token" }, 401);
    }

    const googleId = payload.sub as string;
    const avatarUrl = (payload.picture as string) || null;

    // Check if this Google ID is already linked to another user
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.googleId, googleId))
      .limit(1);
    if (existing.length && existing[0].id !== authUser.id)
      return c.json({ error: "This Google account is linked to another user" }, 409);

    await db
      .update(users)
      .set({ googleId, avatarUrl, updatedAt: new Date().toISOString() })
      .where(eq(users.id, authUser.id));

    const rows = await db.select().from(users).where(eq(users.id, authUser.id)).limit(1);
    const u = rows[0];
    return c.json(
      {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        hasPassword: !!u.passwordHash,
        hasGoogle: !!u.googleId,
        avatarUrl: u.avatarUrl ?? null,
      },
      200
    );
  }
);

// Unlink Google account
app.openapi(
  createRoute({
    method: "delete",
    path: "/me/link-google",
    tags: ["Auth"],
    responses: {
      200: {
        description: "Google account unlinked",
        content: { "application/json": { schema: MeResponseSchema } },
      },
      400: { description: "Cannot unlink — no password set" },
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
    const u = rows[0];

    // Must have a password to unlink Google (otherwise locked out)
    if (!u.passwordHash)
      return c.json(
        { error: "Set a password before unlinking Google" },
        400
      );

    await db
      .update(users)
      .set({ googleId: null, updatedAt: new Date().toISOString() })
      .where(eq(users.id, authUser.id));

    return c.json(
      {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        hasPassword: !!u.passwordHash,
        hasGoogle: false,
        avatarUrl: u.avatarUrl ?? null,
      },
      200
    );
  }
);

export default app;
