import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { itineraries, trips } from "../db/schema";
import {
  ItinerarySchema,
  ItineraryViewSchema,
  CreateItinerarySchema,
  UpdateItinerarySchema,
  contentSchemaByType,
  viewContentSchemaByType,
  type ItineraryType,
} from "../schemas/itinerary";
import { getTripRole } from "../middleware/tripRole";

const CURRENT_SCHEMA_VERSION = 1;

const app = new OpenAPIHono<Env>();

const tripParam = z.object({ tripId: z.string().uuid() });
const itemParams = z.object({
  tripId: z.string().uuid(),
  itineraryId: z.string().uuid(),
});

function validateContent(type: ItineraryType, content: unknown) {
  const schema = contentSchemaByType[type];
  const result = schema.safeParse(content);
  if (!result.success) {
    return { ok: false as const, error: result.error.flatten() };
  }
  return { ok: true as const, data: result.data };
}

/** Project an itinerary row through the viewer schemas, stripping sensitive fields. */
function toViewerResponse(row: Record<string, unknown>) {
  const type = row.type as ItineraryType;
  const viewContentSchema = viewContentSchemaByType[type];
  // Parse content through the view schema to strip sensitive fields
  const content = viewContentSchema
    ? viewContentSchema.parse(row.content)
    : row.content;
  // Parse the itinerary envelope through the view schema (drops confirmationNumber)
  const envelope = ItineraryViewSchema.parse({ ...row, content });
  return envelope;
}

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
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const user = c.get("user");
    const role = await getTripRole(db, tripId, user.id, user.role);
    const result = await db
      .select()
      .from(itineraries)
      .where(eq(itineraries.tripId, tripId));
    const rows = role === "Viewer" ? result.map((r) => toViewerResponse(r as any)) : result;
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
    const db = getDb(c.env.DB);
    const { tripId, itineraryId } = c.req.valid("param");
    const user = c.get("user");
    const role = await getTripRole(db, tripId, user.id, user.role);
    const result = await db
      .select()
      .from(itineraries)
      .where(
        and(
          eq(itineraries.id, itineraryId),
          eq(itineraries.tripId, tripId)
        )
      );
    if (!result.length) return c.json({ error: "Not found" }, 404);
    const row = role === "Viewer" ? toViewerResponse(result[0] as any) : result[0];
    return c.json(row, 200);
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
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");

    const trip = await db.select().from(trips).where(eq(trips.id, tripId));
    if (!trip.length) return c.json({ error: "Trip not found" }, 404);

    const body = c.req.valid("json");

    // Validate content against type-specific schema
    const validation = validateContent(body.type as ItineraryType, body.content);
    if (!validation.ok) {
      return c.json({ error: "Invalid content for type", details: validation.error }, 400);
    }

    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      tripId,
      type: body.type,
      status: body.status ?? "Pending",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      content: validation.data,
      confirmationNumber: body.confirmationNumber ?? null,
      totalCost: body.totalCost ?? null,
      currency: body.currency ?? null,
      notes: body.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(itineraries).values(row);
    return c.json(row, 201);
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
    const db = getDb(c.env.DB);
    const { tripId, itineraryId } = c.req.valid("param");
    const existing = await db
      .select()
      .from(itineraries)
      .where(
        and(
          eq(itineraries.id, itineraryId),
          eq(itineraries.tripId, tripId)
        )
      );
    if (!existing.length) return c.json({ error: "Not found" }, 404);

    const body = c.req.valid("json");
    const effectiveType = (body.type ?? existing[0].type) as ItineraryType;

    // If content is being updated, validate against the (possibly new) type
    if (body.content) {
      const validation = validateContent(effectiveType, body.content);
      if (!validation.ok) {
        return c.json(
          { error: "Invalid content for type", details: validation.error },
          400
        );
      }
      body.content = validation.data as Record<string, unknown>;
    }

    const updated = {
      ...existing[0],
      ...body,
      updatedAt: new Date().toISOString(),
    };
    await db
      .update(itineraries)
      .set(updated)
      .where(eq(itineraries.id, itineraryId));
    return c.json(updated, 200);
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
    const db = getDb(c.env.DB);
    const { tripId, itineraryId } = c.req.valid("param");
    const existing = await db
      .select()
      .from(itineraries)
      .where(
        and(
          eq(itineraries.id, itineraryId),
          eq(itineraries.tripId, tripId)
        )
      );
    if (!existing.length) return c.json({ error: "Not found" }, 404);
    await db.delete(itineraries).where(eq(itineraries.id, itineraryId));
    return c.body(null, 204);
  }
);

export default app;
