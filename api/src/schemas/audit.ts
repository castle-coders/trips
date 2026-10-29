// REST schemas for the audit history endpoints (specs/AUDIT_TDD.md section 8).
// Enums are derived from the service's `ENTITY_TYPES` / `ACTIONS` and the `Channel` type so
// the documented values cannot drift from what the service accepts and stores.
import { z } from "@hono/zod-openapi";
import type { Channel } from "../db";
import { ACTIONS, DEFAULT_LIMIT, ENTITY_TYPES, MAX_LIMIT } from "../services/audit";

/** Every `Channel` the auth paths produce. `Record<Channel, true>` makes a missing value a type error. */
const CHANNEL_SET: Record<Channel, true> = {
  web: true,
  service_token: true,
  mcp_stage1: true,
  mcp_oauth: true,
  dev: true,
};
export const CHANNELS = Object.keys(CHANNEL_SET) as readonly Channel[];

/** Stored channel values: the live ones plus `backfill`, reserved by the PRD for imported history. */
export const STORED_CHANNELS = [...CHANNELS, "backfill"] as const;

export const EntityTypeSchema = z.enum(ENTITY_TYPES).openapi("AuditEntityType");
export const ActionSchema = z.enum(ACTIONS).openapi("AuditAction");

const snapshot = z.record(z.string(), z.unknown());

export const AuditEventSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().openapi({ description: "ISO 8601 UTC" }),
    actorUserId: z.string().uuid().nullable(),
    actorName: z.string(),
    actorEmail: z.string(),
    actorRole: z.string(),
    channel: z.enum(STORED_CHANNELS),
    clientId: z.string().nullable().openapi({ description: "OAuth client id or service identity common name" }),
    clientName: z
      .string()
      .nullable()
      .openapi({ description: "Registered OAuth client name or service identity common name; null for web, dev and unknown clients" }),
    requestId: z.string().nullable().optional().openapi({ description: "Cloudflare cf-ray. Present only on /admin/audit." }),
    tripId: z.string().uuid().nullable().openapi({ description: "Null for administration events" }),
    entityType: EntityTypeSchema,
    entityId: z.string(),
    entityLabel: z.string(),
    action: ActionSchema,
    before: snapshot.nullable().openapi({ description: "Allow-listed snapshot before the change; null for create" }),
    after: snapshot.nullable().openapi({ description: "Allow-listed snapshot after the change; null for delete" }),
    changes: z
      .record(z.string(), z.object({ from: z.unknown().optional(), to: z.unknown().optional() }))
      .nullable()
      .openapi({ description: "Per-path diff for update; a missing side means the path did not exist" }),
    metadata: snapshot.nullable(),
  })
  .openapi("AuditEvent");

export const AuditPageSchema = z
  .object({
    events: z.array(AuditEventSchema).openapi({ description: "Newest first" }),
    nextCursor: z.string().nullable().openapi({ description: "Opaque; pass back as `cursor` for the next page" }),
  })
  .openapi("AuditPage");

/** The wire shape of a page; structurally identical to the service's `AuditPage`. */
export type AuditPageResponse = z.infer<typeof AuditPageSchema>;

// --- Query parameters ---

const pageQuery = {
  cursor: z.string().min(1).optional().openapi({ description: "Opaque cursor from a previous page's `nextCursor`" }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .openapi({ description: `Page size, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` }),
  actorUserId: z.string().uuid().optional(),
  action: ActionSchema.optional(),
  since: z.string().datetime({ offset: true }).optional().openapi({ description: "ISO 8601, inclusive on createdAt" }),
  until: z.string().datetime({ offset: true }).optional().openapi({ description: "ISO 8601, inclusive on createdAt" }),
};

const entityFilters = {
  entityType: EntityTypeSchema.optional(),
  entityId: z.string().min(1).optional(),
};

/** `GET /trips/{tripId}/audit` */
export const AuditListQuerySchema = z.object({ ...pageQuery, ...entityFilters }).openapi("AuditListQuery");

/** `GET /trips/{tripId}/audit/{entityType}/{entityId}`: the path fixes the entity, so no entity filters. */
export const AuditEntityQuerySchema = z.object(pageQuery).openapi("AuditEntityQuery");

/** `GET /admin/audit` */
export const AdminAuditQuerySchema = z
  .object({
    ...pageQuery,
    ...entityFilters,
    tripId: z.string().uuid().optional(),
    channel: z.enum(CHANNELS).optional(),
    clientId: z.string().min(1).optional(),
  })
  .openapi("AdminAuditQuery");
