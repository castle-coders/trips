import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb, type Env } from "../db";
import {
  AuditEntityQuerySchema,
  AuditListQuerySchema,
  AuditPageSchema,
  EntityTypeSchema,
  type AuditPageResponse,
} from "../schemas/audit";
import { listEntityEvents, listTripEvents } from "../services/audit";

// Mounted at /trips/:tripId/audit (specs/AUDIT_TDD.md section 8). Handlers are thin: validate,
// call the service, return the page. Authorization (Editor+ on the trip, admins everywhere)
// and the trip_id constraint live in the service; ServiceErrors map to HTTP in the shared
// onError hook (src/index.ts): Viewers 403, non-members 404, bad cursor 400.

const app = new OpenAPIHono<Env>();

const ErrorSchema = z.object({ error: z.string() });
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const tripParam = z.object({ tripId: z.string().uuid() });
const entityParams = z.object({
  tripId: z.string().uuid(),
  entityType: EntityTypeSchema,
  entityId: z.string().min(1),
});

// Trip history
app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Audit"],
    summary: "List a trip's audit history",
    description: "Every trip-data event for the trip, newest first. Editor or Owner on the trip, or admin.",
    request: { params: tripParam, query: AuditListQuerySchema },
    responses: {
      200: {
        description: "A page of audit events",
        content: { "application/json": { schema: AuditPageSchema } },
      },
      400: errorResponse("Invalid cursor or filter"),
      403: errorResponse("Viewer on the trip"),
      404: errorResponse("Trip not found or not a member"),
    },
  }),
  async (c) => {
    const { tripId } = c.req.valid("param");
    const page = await listTripEvents(getDb(c.env.DB), c.get("user"), tripId, c.req.valid("query"));
    return c.json(page as AuditPageResponse, 200);
  }
);

// One item's history
app.openapi(
  createRoute({
    method: "get",
    path: "/{entityType}/{entityId}",
    tags: ["Audit"],
    summary: "List the audit history of one item on a trip",
    description: "Events for a single entity on the trip, newest first. Editor or Owner on the trip, or admin.",
    request: { params: entityParams, query: AuditEntityQuerySchema },
    responses: {
      200: {
        description: "A page of audit events for the entity",
        content: { "application/json": { schema: AuditPageSchema } },
      },
      400: errorResponse("Invalid cursor or filter"),
      403: errorResponse("Viewer on the trip"),
      404: errorResponse("Trip not found or not a member"),
    },
  }),
  async (c) => {
    const { tripId, entityType, entityId } = c.req.valid("param");
    const page = await listEntityEvents(
      getDb(c.env.DB),
      c.get("user"),
      tripId,
      entityType,
      entityId,
      c.req.valid("query")
    );
    return c.json(page as AuditPageResponse, 200);
  }
);

export default app;
