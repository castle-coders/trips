import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { users, serviceIdentities } from "../db/schema";

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
    const db = getDb(c.env.DB);
    const body = c.req.valid("json");

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing.length)
      return c.json({ error: "Email already exists" }, 409);

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await db.insert(users).values({
      id,
      email: body.email,
      name: body.name,
      role: body.role,
      createdAt: now,
      updatedAt: now,
    });

    return c.json(
      {
        id,
        email: body.email,
        name: body.name,
        role: body.role,
        createdAt: now,
        updatedAt: now,
      },
      201
    );
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
    const db = getDb(c.env.DB);
    const { userId } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing.length) return c.json({ error: "User not found" }, 404);

    const now = new Date().toISOString();
    await db
      .update(users)
      .set({ ...body, updatedAt: now })
      .where(eq(users.id, userId));

    const updated = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return c.json(updated[0], 200);
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

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing.length) return c.json({ error: "User not found" }, 404);

    await db.delete(users).where(eq(users.id, userId));
    return c.body(null, 204);
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
    const db = getDb(c.env.DB);
    const body = c.req.valid("json");

    // Verify user exists
    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!user.length) return c.json({ error: "User not found" }, 404);

    // Check for duplicate subject
    const existing = await db
      .select()
      .from(serviceIdentities)
      .where(eq(serviceIdentities.cfAccessSubject, body.cfAccessSubject))
      .limit(1);
    if (existing.length)
      return c.json({ error: "Subject already mapped" }, 409);

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.insert(serviceIdentities).values({
      id,
      cfAccessSubject: body.cfAccessSubject,
      commonName: body.commonName,
      userId: body.userId,
      createdAt: now,
    });

    return c.json(
      {
        id,
        cfAccessSubject: body.cfAccessSubject,
        commonName: body.commonName,
        userId: body.userId,
        userName: user[0].name,
        userEmail: user[0].email,
        createdAt: now,
      },
      201
    );
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
    const db = getDb(c.env.DB);
    const { identityId } = c.req.valid("param");

    const existing = await db
      .select()
      .from(serviceIdentities)
      .where(eq(serviceIdentities.id, identityId))
      .limit(1);
    if (!existing.length) return c.json({ error: "Not found" }, 404);

    await db
      .delete(serviceIdentities)
      .where(eq(serviceIdentities.id, identityId));
    return c.body(null, 204);
  }
);

export default app;
