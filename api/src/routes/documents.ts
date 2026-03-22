import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { documents, trips } from "../db/schema";
import {
  DocumentSchema,
  CreateDocumentSchema,
  UpdateDocumentSchema,
} from "../schemas/document";

const app = new OpenAPIHono<Env>();

const tripParam = z.object({ tripId: z.string().uuid() });
const itemParams = z.object({
  tripId: z.string().uuid(),
  documentId: z.string().uuid(),
});

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Documents"],
    request: { params: tripParam },
    responses: {
      200: {
        description: "List of documents",
        content: { "application/json": { schema: z.array(DocumentSchema) } },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const result = await db
      .select()
      .from(documents)
      .where(eq(documents.tripId, tripId));
    return c.json(result as any, 200);
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Documents"],
    request: {
      params: tripParam,
      body: {
        content: { "application/json": { schema: CreateDocumentSchema } },
      },
    },
    responses: {
      201: {
        description: "Created document",
        content: { "application/json": { schema: DocumentSchema } },
      },
      404: { description: "Trip not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const trip = await db.select().from(trips).where(eq(trips.id, tripId));
    if (!trip.length) return c.json({ error: "Trip not found" }, 404);
    const body = c.req.valid("json");
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      tripId,
      reservationId: body.reservationId ?? null,
      fileUrl: body.fileUrl,
      documentType: body.documentType,
      name: body.name,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(documents).values(row);
    return c.json(row, 201);
  }
);

app.openapi(
  createRoute({
    method: "put",
    path: "/{documentId}",
    tags: ["Documents"],
    request: {
      params: itemParams,
      body: {
        content: { "application/json": { schema: UpdateDocumentSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated document",
        content: { "application/json": { schema: DocumentSchema } },
      },
      404: { description: "Document not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId, documentId } = c.req.valid("param");
    const existing = await db
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, documentId), eq(documents.tripId, tripId))
      );
    if (!existing.length) return c.json({ error: "Document not found" }, 404);
    const updated = {
      ...existing[0],
      ...c.req.valid("json"),
      updatedAt: new Date().toISOString(),
    };
    await db
      .update(documents)
      .set(updated)
      .where(eq(documents.id, documentId));
    return c.json(updated, 200);
  }
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/{documentId}",
    tags: ["Documents"],
    request: { params: itemParams },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Document not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId, documentId } = c.req.valid("param");
    const existing = await db
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, documentId), eq(documents.tripId, tripId))
      );
    if (!existing.length) return c.json({ error: "Document not found" }, 404);
    await db.delete(documents).where(eq(documents.id, documentId));
    return c.body(null, 204);
  }
);

export default app;
