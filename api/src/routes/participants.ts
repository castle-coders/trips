import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb, type Env } from "../db";
import {
  ParticipantSchema,
  CreateParticipantSchema,
  UpdateParticipantSchema,
} from "../schemas/participant";
import {
  createParticipant,
  deleteParticipant,
  listParticipants,
  updateParticipant,
} from "../services/participants";

const app = new OpenAPIHono<Env>();

const tripParam = z.object({ tripId: z.string().uuid() });
const itemParams = z.object({
  tripId: z.string().uuid(),
  participantId: z.string().uuid(),
});

// List participants for a trip
app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Participants"],
    request: { params: tripParam },
    responses: {
      200: {
        description: "List of participants",
        content: {
          "application/json": { schema: z.array(ParticipantSchema) },
        },
      },
    },
  }),
  async (c) => {
    const { tripId } = c.req.valid("param");
    const result = await listParticipants(getDb(c.env.DB), c.get("user"), tripId);
    return c.json(result as any, 200);
  }
);

// Create participant (owners only)
app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Participants"],
    request: {
      params: tripParam,
      body: {
        content: { "application/json": { schema: CreateParticipantSchema } },
      },
    },
    responses: {
      201: {
        description: "Created participant",
        content: { "application/json": { schema: ParticipantSchema } },
      },
      403: { description: "Forbidden" },
      404: { description: "Trip not found" },
    },
  }),
  async (c) => {
    const { tripId } = c.req.valid("param");
    const row = await createParticipant(getDb(c.env.DB), c.get("user"), tripId, c.req.valid("json"));
    return c.json(row as any, 201);
  }
);

// Update participant (owners only)
app.openapi(
  createRoute({
    method: "put",
    path: "/{participantId}",
    tags: ["Participants"],
    request: {
      params: itemParams,
      body: {
        content: { "application/json": { schema: UpdateParticipantSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated participant",
        content: { "application/json": { schema: ParticipantSchema } },
      },
      403: { description: "Forbidden" },
      404: { description: "Participant not found" },
    },
  }),
  async (c) => {
    const { tripId, participantId } = c.req.valid("param");
    const updated = await updateParticipant(
      getDb(c.env.DB),
      c.get("user"),
      tripId,
      participantId,
      c.req.valid("json")
    );
    return c.json(updated as any, 200);
  }
);

// Delete participant (owners only)
app.openapi(
  createRoute({
    method: "delete",
    path: "/{participantId}",
    tags: ["Participants"],
    request: { params: itemParams },
    responses: {
      204: { description: "Deleted" },
      403: { description: "Forbidden" },
      404: { description: "Participant not found" },
    },
  }),
  async (c) => {
    const { tripId, participantId } = c.req.valid("param");
    await deleteParticipant(getDb(c.env.DB), c.get("user"), tripId, participantId);
    return c.body(null, 204);
  }
);

export default app;
