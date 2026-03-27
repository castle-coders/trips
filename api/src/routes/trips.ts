import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, gte, isNotNull, asc } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { trips, participants } from "../db/schema";
import { TripSchema, CreateTripSchema, UpdateTripSchema } from "../schemas/trip";
import { getTripRole } from "../middleware/tripRole";

const app = new OpenAPIHono<Env>();

// List trips
app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Trips"],
    responses: {
      200: {
        description: "List of trips",
        content: { "application/json": { schema: z.array(TripSchema) } },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const user = c.get("user");
    if (user.role === "admin") {
      return c.json(await db.select().from(trips), 200);
    }
    const result = await db
      .select({ trips })
      .from(trips)
      .innerJoin(participants, and(eq(participants.tripId, trips.id), eq(participants.userId, user.id)));
    return c.json(result.map((r) => r.trips), 200);
  }
);

// Upcoming trips (next 3 where end date has not passed)
const UpcomingTripSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    participants: z.array(
      z.object({
        name: z.string(),
        email: z.string().nullable(),
        traveling: z.boolean(),
      })
    ),
  })
  .openapi("UpcomingTrip");

app.openapi(
  createRoute({
    method: "get",
    path: "/upcoming",
    tags: ["Trips"],
    responses: {
      200: {
        description: "Next 3 upcoming trips",
        content: {
          "application/json": { schema: z.array(UpcomingTripSchema) },
        },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const user = c.get("user");
    const today = new Date().toISOString().slice(0, 10);

    // Get trips where endDate >= today, with dates present
    let query = db
      .select({ trips })
      .from(trips)
      .where(
        and(
          isNotNull(trips.endDate),
          isNotNull(trips.startDate),
          gte(trips.endDate, today)
        )
      );

    if (user.role !== "admin") {
      query = db
        .select({ trips })
        .from(trips)
        .innerJoin(
          participants,
          and(eq(participants.tripId, trips.id), eq(participants.userId, user.id))
        )
        .where(
          and(
            isNotNull(trips.endDate),
            isNotNull(trips.startDate),
            gte(trips.endDate, today)
          )
        );
    }

    const result = await query.orderBy(asc(trips.startDate)).limit(3);
    const tripRows = result.map((r) => r.trips);

    // Fetch participants for each trip
    const response = await Promise.all(
      tripRows.map(async (trip) => {
        const tripParticipants = await db
          .select({ name: participants.name, email: participants.email, traveling: participants.traveling })
          .from(participants)
          .where(eq(participants.tripId, trip.id));
        return {
          id: trip.id,
          name: trip.name,
          startDate: trip.startDate!,
          endDate: trip.endDate!,
          participants: tripParticipants,
        };
      })
    );

    return c.json(response, 200);
  }
);

// Get trip by ID
app.openapi(
  createRoute({
    method: "get",
    path: "/{tripId}",
    tags: ["Trips"],
    request: {
      params: z.object({ tripId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: "Trip details",
        content: { "application/json": { schema: TripSchema } },
      },
      404: { description: "Trip not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const user = c.get("user");
    if (user.role !== "admin") {
      const membership = await db
        .select({ id: participants.id })
        .from(participants)
        .where(and(eq(participants.tripId, tripId), eq(participants.userId, user.id)))
        .limit(1);
      if (!membership.length) return c.json({ error: "Trip not found" }, 404);
    }
    const result = await db.select().from(trips).where(eq(trips.id, tripId));
    if (!result.length) return c.json({ error: "Trip not found" }, 404);
    return c.json(result[0], 200);
  }
);

// Create trip
app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Trips"],
    request: {
      body: {
        content: { "application/json": { schema: CreateTripSchema } },
      },
    },
    responses: {
      201: {
        description: "Created trip",
        content: { "application/json": { schema: TripSchema } },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const body = c.req.valid("json");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const row = {
      id,
      name: body.name,
      destination: body.destination ?? null,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      description: body.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(trips).values(row);
    return c.json(row, 201);
  }
);

// Update trip
app.openapi(
  createRoute({
    method: "put",
    path: "/{tripId}",
    tags: ["Trips"],
    request: {
      params: z.object({ tripId: z.string().uuid() }),
      body: {
        content: { "application/json": { schema: UpdateTripSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated trip",
        content: { "application/json": { schema: TripSchema } },
      },
      404: { description: "Trip not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await db
      .select()
      .from(trips)
      .where(eq(trips.id, tripId));
    if (!existing.length) return c.json({ error: "Trip not found" }, 404);
    const updated = {
      ...existing[0],
      ...body,
      updatedAt: new Date().toISOString(),
    };
    await db.update(trips).set(updated).where(eq(trips.id, tripId));
    return c.json(updated, 200);
  }
);

// Delete trip
app.openapi(
  createRoute({
    method: "delete",
    path: "/{tripId}",
    tags: ["Trips"],
    request: {
      params: z.object({ tripId: z.string().uuid() }),
    },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Trip not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const user = c.get("user");
    const role = await getTripRole(db, tripId, user.id, user.role);
    if (role !== "Owner") return c.json({ error: "Forbidden: only trip Owners can delete trips" }, 403);
    const existing = await db
      .select()
      .from(trips)
      .where(eq(trips.id, tripId));
    if (!existing.length) return c.json({ error: "Trip not found" }, 404);
    await db.delete(trips).where(eq(trips.id, tripId));
    return c.body(null, 204);
  }
);

export default app;
