import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb, type Env } from "../db";
import {
  ItinerarySchema,
  CreateItinerarySchema,
  UpdateItinerarySchema,
} from "../schemas/itinerary";
import {
  listItineraries,
  getItinerary,
  createItinerary,
  updateItinerary,
  deleteItinerary,
} from "../services/itineraries";

// Handlers are thin: validate with the route schemas, call the service, return its result.
// ServiceErrors map to HTTP status in the shared onError hook (src/index.ts).

const app = new OpenAPIHono<Env>();

const tripParam = z.object({ tripId: z.string().uuid() });
const itemParams = z.object({
  tripId: z.string().uuid(),
  itineraryId: z.string().uuid(),
});

// List itineraries for a trip
app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Itineraries"],
    request: { params: tripParam },
    responses: {
      200: {
        description: "List of itineraries",
        content: {
          "application/json": { schema: z.array(ItinerarySchema) },
        },
      },
    },
  }),
  async (c) => {
    const { tripId } = c.req.valid("param");
    const rows = await listItineraries(getDb(c.env.DB), c.get("user"), tripId);
    return c.json(rows as any, 200);
  }
);

// Get single itinerary
app.openapi(
  createRoute({
    method: "get",
    path: "/{itineraryId}",
    tags: ["Itineraries"],
    request: { params: itemParams },
    responses: {
      200: {
        description: "Itinerary details",
        content: { "application/json": { schema: ItinerarySchema } },
      },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const { tripId, itineraryId } = c.req.valid("param");
    const row = await getItinerary(getDb(c.env.DB), c.get("user"), tripId, itineraryId);
    return c.json(row as any, 200);
  }
);

// Create itinerary
app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Itineraries"],
    request: {
      params: tripParam,
      body: {
        content: { "application/json": { schema: CreateItinerarySchema } },
      },
    },
    responses: {
      201: {
        description: "Created itinerary",
        content: { "application/json": { schema: ItinerarySchema } },
      },
      400: { description: "Validation error" },
      404: { description: "Trip not found" },
    },
  }),
  async (c) => {
    const { tripId } = c.req.valid("param");
    const row = await createItinerary(getDb(c.env.DB), c.get("user"), tripId, c.req.valid("json"));
    return c.json(row as any, 201);
  }
);

// Update itinerary
app.openapi(
  createRoute({
    method: "put",
    path: "/{itineraryId}",
    tags: ["Itineraries"],
    request: {
      params: itemParams,
      body: {
        content: { "application/json": { schema: UpdateItinerarySchema } },
      },
    },
    responses: {
      200: {
        description: "Updated itinerary",
        content: { "application/json": { schema: ItinerarySchema } },
      },
      400: { description: "Validation error" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const { tripId, itineraryId } = c.req.valid("param");
    const updated = await updateItinerary(getDb(c.env.DB), c.get("user"), tripId, itineraryId, c.req.valid("json"));
    return c.json(updated as any, 200);
  }
);

// Delete itinerary
app.openapi(
  createRoute({
    method: "delete",
    path: "/{itineraryId}",
    tags: ["Itineraries"],
    request: { params: itemParams },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const { tripId, itineraryId } = c.req.valid("param");
    await deleteItinerary(getDb(c.env.DB), c.get("user"), tripId, itineraryId);
    return c.body(null, 204);
  }
);

export default app;
