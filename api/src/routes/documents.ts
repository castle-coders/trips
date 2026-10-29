import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb, type Env } from "../db";
import { DocumentSchema, CreateDocumentSchema, UpdateDocumentSchema } from "../schemas/document";
import { createDocument, deleteDocument, listDocuments, updateDocument } from "../services/documents";

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
    const { tripId } = c.req.valid("param");
    const result = await listDocuments(getDb(c.env.DB), c.get("user"), tripId);
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
    const { tripId } = c.req.valid("param");
    const row = await createDocument(getDb(c.env.DB), c.get("user"), tripId, c.req.valid("json"));
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
    const { tripId, documentId } = c.req.valid("param");
    const updated = await updateDocument(getDb(c.env.DB), c.get("user"), tripId, documentId, c.req.valid("json"));
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
    const { tripId, documentId } = c.req.valid("param");
    await deleteDocument(getDb(c.env.DB), c.get("user"), tripId, documentId);
    return c.body(null, 204);
  }
);

export default app;
