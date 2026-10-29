import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb, type Env } from "../db";
import { createInvite, deleteInvite, listInvites } from "../services/invites";

const app = new OpenAPIHono<Env>();

const InviteSchema = z
  .object({
    id: z.string(),
    tripId: z.string(),
    participantId: z.string().nullable(),
    email: z.string().nullable(),
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
    name: z.string().default(""),
    participantId: z.string().optional(),
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
    const { tripId } = c.req.valid("param");
    const rows = await listInvites(getDb(c.env.DB), c.get("user"), tripId);
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
    const { tripId } = c.req.valid("param");
    const row = await createInvite(getDb(c.env.DB), c.get("user"), tripId, c.req.valid("json"));
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
    const { tripId, inviteId } = c.req.valid("param");
    await deleteInvite(getDb(c.env.DB), c.get("user"), tripId, inviteId);
    return c.body(null, 204);
  }
);

export default app;
