import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb, type Env } from "../db";
import { TripSchema, CreateTripSchema, UpdateTripSchema } from "../schemas/trip";
import { createTrip, deleteTrip, getTrip, listTrips, listUpcomingTrips, updateTrip } from "../services/trips";

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
    const rows = await listTrips(getDb(c.env.DB), c.get("user"));
    return c.json(rows.map(({ role: _role, ...trip }) => trip), 200);
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
    return c.json(await listUpcomingTrips(getDb(c.env.DB), c.get("user")), 200);
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
    const { tripId } = c.req.valid("param");
    const { trip } = await getTrip(getDb(c.env.DB), c.get("user"), tripId);
    return c.json(trip, 200);
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
    const row = await createTrip(getDb(c.env.DB), c.get("user"), c.req.valid("json"));
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
    const { tripId } = c.req.valid("param");
    const updated = await updateTrip(getDb(c.env.DB), c.get("user"), tripId, c.req.valid("json"));
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
    const { tripId } = c.req.valid("param");
    await deleteTrip(getDb(c.env.DB), c.get("user"), tripId);
    return c.body(null, 204);
  }
);

export default app;
