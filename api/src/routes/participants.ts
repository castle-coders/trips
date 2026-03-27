import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { participants, trips } from "../db/schema";
import { getTripRole } from "../middleware/tripRole";
import {
  ParticipantSchema,
  CreateParticipantSchema,
  UpdateParticipantSchema,
} from "../schemas/participant";

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
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const result = await db
      .select()
      .from(participants)
      .where(eq(participants.tripId, tripId));
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
    const db = getDb(c.env.DB);
    const user = c.get("user");
    const { tripId } = c.req.valid("param");

    const role = await getTripRole(db, tripId, user.id, user.role);
    if (role !== "Owner") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const trip = await db.select().from(trips).where(eq(trips.id, tripId));
    if (!trip.length) return c.json({ error: "Trip not found" }, 404);
    const body = c.req.valid("json");
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      tripId,
      userId: body.userId ?? null,
      email: body.email ?? null,
      name: body.name,
      role: body.role,
      traveling: body.traveling ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(participants).values(row);
    return c.json(row, 201);
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
    const db = getDb(c.env.DB);
    const user = c.get("user");
    const { tripId, participantId } = c.req.valid("param");

    const role = await getTripRole(db, tripId, user.id, user.role);
    if (role !== "Owner") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const existing = await db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.id, participantId),
          eq(participants.tripId, tripId)
        )
      );
    if (!existing.length)
      return c.json({ error: "Participant not found" }, 404);
    const updated = {
      ...existing[0],
      ...c.req.valid("json"),
      updatedAt: new Date().toISOString(),
    };
    await db
      .update(participants)
      .set(updated)
      .where(eq(participants.id, participantId));
    return c.json(updated, 200);
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
    const db = getDb(c.env.DB);
    const user = c.get("user");
    const { tripId, participantId } = c.req.valid("param");

    const role = await getTripRole(db, tripId, user.id, user.role);
    if (role !== "Owner") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const existing = await db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.id, participantId),
          eq(participants.tripId, tripId)
        )
      );
    if (!existing.length)
      return c.json({ error: "Participant not found" }, 404);
    await db.delete(participants).where(eq(participants.id, participantId));
    return c.body(null, 204);
  }
);

export default app;
