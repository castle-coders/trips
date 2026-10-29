import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { users, userEmails, serviceIdentities } from "../db/schema";
import { mergeAccounts } from "../lib/merge";
import { AdminAuditQuerySchema, AuditPageSchema, type AuditPageResponse } from "../schemas/audit";
import { listAdminEvents, recordEvent } from "../services/audit";
import {
  createServiceIdentity,
  createUser,
  deleteServiceIdentity,
  deleteUser,
  getUser,
  updateUser,
  type User,
} from "../services/users";
import {
  OAUTH_NOT_CONFIGURED,
  OAuthNotConfiguredError,
  StaticClientError,
  type CreatedStaticClient,
  createStaticClient,
  deleteClient,
  getClient,
  getGrant,
  isOAuthConfigured,
  listAllGrants,
  listClients,
  revokeAllGrantsForUser,
  revokeGrant,
} from "../oauth/grants";

const app = new OpenAPIHono<Env>();

// --- Users ---

const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("User");

/** The public user shape: never passwordHash, googleId or avatarUrl. */
const toUserView = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

// List users
app.openapi(
  createRoute({
    method: "get",
    path: "/users",
    tags: ["Admin"],
    responses: {
      200: {
        description: "List of users",
        content: { "application/json": { schema: z.array(UserSchema) } },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users);
    return c.json(rows, 200);
  }
);

// Create user
app.openapi(
  createRoute({
    method: "post",
    path: "/users",
    tags: ["Admin"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                email: z.string().email(),
                name: z.string().min(1),
                role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
              })
              .openapi("CreateUser"),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Created user",
        content: { "application/json": { schema: UserSchema } },
      },
      409: { description: "Email already exists" },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const created = await createUser(getDb(c.env.DB), c.get("user"), body);
    return c.json(toUserView(created), 201);
  }
);

// Update user role
app.openapi(
  createRoute({
    method: "put",
    path: "/users/{userId}",
    tags: ["Admin"],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                name: z.string().min(1).optional(),
                role: z.enum(["admin", "editor", "viewer"]).optional(),
              })
              .openapi("UpdateUser"),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated user",
        content: { "application/json": { schema: UserSchema } },
      },
      404: { description: "User not found" },
    },
  }),
  async (c) => {
    const { userId } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await updateUser(getDb(c.env.DB), c.get("user"), userId, body);
    return c.json(toUserView(updated), 200);
  }
);

// Delete user
app.openapi(
  createRoute({
    method: "delete",
    path: "/users/{userId}",
    tags: ["Admin"],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      204: { description: "Deleted" },
      404: { description: "User not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { userId } = c.req.valid("param");

    await getUser(db, userId); // 404 before anything is revoked

    // Revoke OAuth grants first: once the row is gone they are invisible to /admin/grants.
    // A throw here aborts the request (onError -> 500) with the user and grants intact.
    const revokedGrants = await revokeAllGrantsForUser(c.env, userId);
    await deleteUser(db, c.get("user"), userId, { revokedGrants });
    return c.body(null, 204);
  }
);

// --- Merge Accounts ---

app.openapi(
  createRoute({
    method: "post",
    path: "/users/merge",
    tags: ["Admin"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                keepUserId: z.string().uuid(),
                mergeUserId: z.string().uuid(),
              })
              .openapi("MergeUsers"),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Accounts merged",
        content: {
          "application/json": {
            schema: UserSchema.extend({
              emails: z.array(
                z.object({ id: z.string(), email: z.string(), isPrimary: z.boolean() })
              ),
            }),
          },
        },
      },
      400: { description: "Cannot merge user with themselves" },
      404: { description: "User not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { keepUserId, mergeUserId } = c.req.valid("json");

    if (keepUserId === mergeUserId)
      return c.json({ error: "Cannot merge user with themselves" }, 400);

    // The merged-away user's OAuth grants are revoked before mergeAccounts deletes the row
    // (their tokens carry that user id, which will no longer exist). Only when both users exist,
    // so a 404 merge revokes nothing. The keep user's own grants are untouched; anything that
    // was connected as the merged-away user must re-consent as the keep user. A revocation
    // failure throws out of the handler (onError -> 500) before any D1 change.
    const [keepExists, mergeExists] = await Promise.all([
      db.select({ id: users.id }).from(users).where(eq(users.id, keepUserId)).limit(1),
      db.select({ id: users.id }).from(users).where(eq(users.id, mergeUserId)).limit(1),
    ]);
    if (keepExists.length && mergeExists.length) await revokeAllGrantsForUser(c.env, mergeUserId);

    // A missing user is ServiceError("not_found") -> 404 { error } through onError.
    await mergeAccounts(db, c.get("user"), keepUserId, mergeUserId);

    const [userRows, emailRows] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.id, keepUserId))
        .limit(1),
      db
        .select({ id: userEmails.id, email: userEmails.email, isPrimary: userEmails.isPrimary })
        .from(userEmails)
        .where(eq(userEmails.userId, keepUserId)),
    ]);

    return c.json({ ...userRows[0], emails: emailRows }, 200);
  }
);

// --- Service Identities ---

const ServiceIdentitySchema = z
  .object({
    id: z.string(),
    cfAccessSubject: z.string(),
    commonName: z.string(),
    userId: z.string(),
    userName: z.string().optional(),
    userEmail: z.string().optional(),
    createdAt: z.string(),
  })
  .openapi("ServiceIdentity");

// List service identities
app.openapi(
  createRoute({
    method: "get",
    path: "/service-identities",
    tags: ["Admin"],
    responses: {
      200: {
        description: "List of service identities",
        content: {
          "application/json": { schema: z.array(ServiceIdentitySchema) },
        },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const rows = await db
      .select({
        id: serviceIdentities.id,
        cfAccessSubject: serviceIdentities.cfAccessSubject,
        commonName: serviceIdentities.commonName,
        userId: serviceIdentities.userId,
        userName: users.name,
        userEmail: users.email,
        createdAt: serviceIdentities.createdAt,
      })
      .from(serviceIdentities)
      .leftJoin(users, eq(serviceIdentities.userId, users.id));
    return c.json(rows as any, 200);
  }
);

// Create service identity
app.openapi(
  createRoute({
    method: "post",
    path: "/service-identities",
    tags: ["Admin"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                cfAccessSubject: z.string().min(1),
                commonName: z.string().min(1),
                userId: z.string().uuid(),
              })
              .openapi("CreateServiceIdentity"),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Created service identity",
        content: { "application/json": { schema: ServiceIdentitySchema } },
      },
      404: { description: "User not found" },
      409: { description: "Subject already mapped" },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const created = await createServiceIdentity(getDb(c.env.DB), c.get("user"), body);
    return c.json(created, 201);
  }
);

// Delete service identity
app.openapi(
  createRoute({
    method: "delete",
    path: "/service-identities/{identityId}",
    tags: ["Admin"],
    request: {
      params: z.object({ identityId: z.string().uuid() }),
    },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const { identityId } = c.req.valid("param");
    await deleteServiceIdentity(getDb(c.env.DB), c.get("user"), identityId);
    return c.body(null, 204);
  }
);

// --- OAuth grants and static clients (Stage 2, TDD 7.5, PRD 6.3, 6.4) ---
//
// Stage 2 off (MCP_PUBLIC_URL empty): list routes return [], mutating routes return
// 503 { error: "OAuth is not configured" }.
//
// Audit (AUDIT_TDD 7.4): these entities live in KV, so the event cannot share a D1 batch. Each
// mutating handler reads the view first, then calls `recordEvent` only after the KV write
// succeeded. A 404 or 503 records nothing. Snapshots and metadata are built by hand from the
// views, which never carry a secret, its hash or a token hash.

/** Grant, user and client ids from the library and D1 use only these characters (no ":" or "/"). */
const OAuthIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const ErrorSchema = z.object({ error: z.string() });

const AdminOAuthGrantSchema = z
  .object({
    id: z.string().openapi({ description: "Grant id" }),
    clientId: z.string(),
    clientName: z.string().nullable().openapi({ description: "Null for unknown, deleted or metadata-document (URL) clients" }),
    scopes: z.array(z.string()),
    createdAt: z.string().openapi({ description: "ISO 8601" }),
    expiresAt: z.string().nullable().openapi({ description: "ISO 8601; null when no expiry is recorded" }),
    userId: z.string(),
    userEmail: z.string(),
  })
  .openapi("AdminOAuthGrant");

const OAuthClientSchema = z
  .object({
    clientId: z.string(),
    clientName: z.string().nullable(),
    redirectUris: z.array(z.string()),
    tokenEndpointAuthMethod: z.string(),
    confidential: z.boolean(),
    registrationDate: z.string().nullable().openapi({ description: "ISO 8601" }),
  })
  .openapi("OAuthClient");

const CreatedOAuthClientSchema = OAuthClientSchema.extend({
  clientSecret: z.string().openapi({ description: "Shown once. Only its hash is stored; it cannot be retrieved again." }),
}).openapi("CreatedOAuthClient");

const notConfigured = { description: "OAuth (Stage 2) is not configured", content: { "application/json": { schema: ErrorSchema } } };

// List all OAuth grants
app.openapi(
  createRoute({
    method: "get",
    path: "/grants",
    tags: ["Admin"],
    summary: "List every user's OAuth grants (connected apps)",
    responses: {
      200: {
        description: "All grants, newest first; empty when OAuth is not configured",
        content: { "application/json": { schema: z.array(AdminOAuthGrantSchema) } },
      },
    },
  }),
  async (c) => c.json(await listAllGrants(c.env), 200)
);

// Revoke any user's OAuth grant
app.openapi(
  createRoute({
    method: "delete",
    path: "/grants/{userId}/{grantId}",
    tags: ["Admin"],
    summary: "Revoke a grant and all its tokens",
    request: {
      params: z.object({ userId: OAuthIdSchema, grantId: OAuthIdSchema }),
    },
    responses: {
      204: { description: "Revoked; the grant's access and refresh tokens no longer work" },
      404: { description: "No such grant for that user", content: { "application/json": { schema: ErrorSchema } } },
      503: notConfigured,
    },
  }),
  async (c) => {
    if (!isOAuthConfigured(c.env)) return c.json({ error: OAUTH_NOT_CONFIGURED }, 503);
    const { userId, grantId } = c.req.valid("param");
    const grant = await getGrant(c.env, userId, grantId);
    if (!grant) return c.json({ error: "Not found" }, 404);
    const revoked = await revokeGrant(c.env, userId, grantId);
    if (!revoked) return c.json({ error: "Not found" }, 404);
    await recordEvent(getDb(c.env.DB), {
      actor: c.get("user"),
      tripId: null,
      entityType: "oauth_grant",
      entityId: grantId,
      action: "revoke",
      before: {
        grantId: grant.id,
        userId,
        clientId: grant.clientId,
        clientName: grant.clientName,
        scopes: grant.scopes,
        createdAt: grant.createdAt,
      },
      metadata: { scopes: grant.scopes, clientId: grant.clientId, selfService: false },
    });
    return c.body(null, 204);
  }
);

// List stored OAuth clients
app.openapi(
  createRoute({
    method: "get",
    path: "/oauth-clients",
    tags: ["Admin"],
    summary: "List stored OAuth clients (static and dynamically registered), without secrets",
    responses: {
      200: {
        description: "Clients; empty when OAuth is not configured",
        content: { "application/json": { schema: z.array(OAuthClientSchema) } },
      },
    },
  }),
  async (c) => c.json(await listClients(c.env), 200)
);

// Create a static (pre-registered) OAuth client
app.openapi(
  createRoute({
    method: "post",
    path: "/oauth-clients",
    tags: ["Admin"],
    summary: "Create a static confidential OAuth client (for platforms without dynamic registration)",
    description:
      "The server generates the client id and secret. The secret is returned once in this response, " +
      "stored only as a hash, and never logged. Every redirect URI must be on the server's allow-list.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                clientName: z.string().trim().min(1).max(100),
                redirectUris: z.array(z.string().min(1).max(2048)).min(1).max(10),
                tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),
              })
              .openapi("CreateOAuthClient"),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Created client, including the one-time secret",
        content: { "application/json": { schema: CreatedOAuthClientSchema } },
      },
      400: { description: "Redirect URI not allowed or metadata rejected", content: { "application/json": { schema: ErrorSchema } } },
      503: notConfigured,
    },
  }),
  async (c) => {
    if (!isOAuthConfigured(c.env)) return c.json({ error: OAUTH_NOT_CONFIGURED }, 503);
    const body = c.req.valid("json");
    let created: CreatedStaticClient;
    try {
      created = await createStaticClient(c.env, body);
    } catch (err) {
      if (err instanceof StaticClientError) return c.json({ error: err.message }, 400);
      if (err instanceof OAuthNotConfiguredError) return c.json({ error: OAUTH_NOT_CONFIGURED }, 503);
      throw err;
    }
    // Built field by field: `created` carries the one-time secret, which must never reach a row.
    await recordEvent(getDb(c.env.DB), {
      actor: c.get("user"),
      tripId: null,
      entityType: "oauth_client",
      entityId: created.clientId,
      action: "create",
      after: {
        clientId: created.clientId,
        clientName: created.clientName,
        redirectUris: created.redirectUris,
        tokenEndpointAuthMethod: created.tokenEndpointAuthMethod,
      },
    });
    c.header("Cache-Control", "no-store");
    return c.json(created, 201);
  }
);

// Delete a stored OAuth client
app.openapi(
  createRoute({
    method: "delete",
    path: "/oauth-clients/{clientId}",
    tags: ["Admin"],
    summary: "Delete a stored OAuth client and revoke all of its grants",
    request: {
      params: z.object({ clientId: OAuthIdSchema }),
    },
    responses: {
      204: { description: "Deleted; its grants and refresh tokens are revoked" },
      404: { description: "Client not found", content: { "application/json": { schema: ErrorSchema } } },
      503: notConfigured,
    },
  }),
  async (c) => {
    if (!isOAuthConfigured(c.env)) return c.json({ error: OAUTH_NOT_CONFIGURED }, 503);
    const { clientId } = c.req.valid("param");
    const client = await getClient(c.env, clientId);
    if (!client) return c.json({ error: "Not found" }, 404);
    const deleted = await deleteClient(c.env, clientId);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    // One event for the client; the grants the library revokes underneath get none (cascade).
    await recordEvent(getDb(c.env.DB), {
      actor: c.get("user"),
      tripId: null,
      entityType: "oauth_client",
      entityId: clientId,
      action: "delete",
      before: {
        clientId: client.clientId,
        clientName: client.clientName,
        redirectUris: client.redirectUris,
        tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
      },
    });
    return c.body(null, 204);
  }
);

// --- Audit history (AUDIT_TDD 8, AUDIT_PRD 6.5) ---
//
// Every event across all trips plus administration events (trip_id IS NULL), including trips
// that no longer exist. Admin-only in the service (`listAdminEvents`), which is also what adds
// `requestId` to the view. A bad cursor is ServiceError("validation") -> 400 through onError.

app.openapi(
  createRoute({
    method: "get",
    path: "/audit",
    tags: ["Admin"],
    summary: "List audit events across all trips and administration",
    description:
      "Newest first. Includes events for deleted trips and administration events with no trip. " +
      "Each event carries `requestId`.",
    request: { query: AdminAuditQuerySchema },
    responses: {
      200: {
        description: "A page of audit events, each with requestId",
        content: { "application/json": { schema: AuditPageSchema } },
      },
      400: { description: "Invalid cursor or filter", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "Not an admin", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const page = await listAdminEvents(getDb(c.env.DB), c.get("user"), c.req.valid("query"));
    return c.json(page as AuditPageResponse, 200);
  }
);

export default app;
