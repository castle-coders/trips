/**
 * Audit log service (specs/AUDIT_TDD.md section 6).
 *
 * Writing: `auditInsert` builds the INSERT for one event so the caller can place it in the
 * same `db.batch([...])` as the data statement; `recordEvent` runs it standalone for writes
 * that cannot share a batch (KV-backed OAuth entities, TDD 7.4).
 *
 * Reading: `listTripEvents` / `listEntityEvents` (Editor+ on the trip, always constrained to
 * `trip_id = ?`) and `listAdminEvents` (admin only). Cursor pagination on `seq` (6.3).
 *
 * Nothing here ever issues UPDATE or DELETE against audit_events (append-only, TDD 10).
 */
import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import type { Actor, AuthUser, Channel } from "../db";
import { auditEvents } from "../db/schema";
import { diffSnapshots, type Changes, type Snapshot } from "../lib/diff";
import { isAdmin, requireTripRole, type Db } from "./access";
import { ServiceError } from "./errors";

export type { Changes, Snapshot } from "../lib/diff";

// --- Types (TDD 4.2) ---

export type EntityType =
  | "trip"
  | "itinerary"
  | "expense"
  | "participant"
  | "document"
  | "invite"
  | "user"
  | "user_email"
  | "service_identity"
  | "oauth_grant"
  | "oauth_client";

export type Action =
  | "create"
  | "update"
  | "delete"
  | "accept"
  | "merge"
  | "link"
  | "unlink"
  | "set_primary"
  | "revoke";

export const ENTITY_TYPES: readonly EntityType[] = [
  "trip",
  "itinerary",
  "expense",
  "participant",
  "document",
  "invite",
  "user",
  "user_email",
  "service_identity",
  "oauth_grant",
  "oauth_client",
];

export const ACTIONS: readonly Action[] = [
  "create",
  "update",
  "delete",
  "accept",
  "merge",
  "link",
  "unlink",
  "set_primary",
  "revoke",
];

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

// --- Writing (TDD 6.1) ---

export interface EventInput {
  actor: Actor;
  tripId: string | null;
  entityType: EntityType;
  entityId: string;
  action: Action;
  /** Raw row; filtered through the allow-list (6.4) here. */
  before?: Snapshot | null;
  after?: Snapshot | null;
  metadata?: Record<string, unknown>;
}

type AuditInsertRow = typeof auditEvents.$inferInsert;

function buildInsert(db: Db, row: AuditInsertRow) {
  return db.insert(auditEvents).values(row);
}

/**
 * The Drizzle insert query `auditInsert` returns. It is a `BatchItem<"sqlite">`, so a caller
 * composes it directly: `await db.batch([db.update(trips).set(...).where(...), audit])`.
 */
export type AuditStatement = ReturnType<typeof buildInsert>;

/** Max stored length of `entityLabel`. */
export const LABEL_MAX_LENGTH = 200;

// --- Snapshot allow-lists and labels (TDD 6.4) ---

/**
 * Explicit set of columns copied into `before` / `after`. Anything not listed is dropped, so
 * a sensitive column added later is excluded until someone opts it in. Never `token`,
 * `passwordHash`, OAuth token hashes or client secrets.
 */
export const SNAPSHOT_COLUMNS: Record<EntityType, readonly string[]> = {
  trip: ["id", "name", "destination", "startDate", "endDate", "description", "splitwiseGroupId"],
  itinerary: [
    "id",
    "tripId",
    "type",
    "status",
    "schemaVersion",
    "content",
    "confirmationNumber",
    "totalCost",
    "currency",
    "notes",
  ],
  expense: ["id", "tripId", "description", "amount", "currency", "category", "payerId", "payerName", "splitType"],
  participant: ["id", "tripId", "userId", "email", "name", "role", "traveling"],
  document: ["id", "tripId", "reservationId", "fileUrl", "documentType", "name"],
  invite: ["id", "tripId", "participantId", "name", "role", "status", "invitedBy", "expiresAt"],
  user: ["id", "email", "name", "role", "avatarUrl", "googleId"],
  user_email: ["id", "userId", "email", "isPrimary"],
  service_identity: ["id", "cfAccessSubject", "commonName", "userId"],
  oauth_grant: ["grantId", "userId", "clientId", "clientName", "scopes", "createdAt"],
  oauth_client: ["clientId", "clientName", "redirectUris", "tokenEndpointAuthMethod"],
};

/**
 * Copy only the allow-listed columns of `row`. Keys absent from the row (or `undefined`)
 * are omitted rather than set to `undefined`, so JSON round-trips keep "absent" distinct
 * from `null`.
 */
export function pickSnapshot(entityType: EntityType, row: Snapshot | null | undefined): Snapshot | null {
  if (row === null || row === undefined) return null;
  const out: Snapshot = {};
  for (const key of SNAPSHOT_COLUMNS[entityType]) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string value, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const s = str(obj[key]);
    if (s !== null) return s;
  }
  return null;
}

function itineraryLabel(snapshot: Snapshot): string | null {
  const type = str(snapshot.type);
  const content = isRecord(snapshot.content) ? snapshot.content : null;
  if (content) {
    if (type === "Flight") {
      const legs = Array.isArray(content.legs) ? content.legs : [];
      const leg = isRecord(legs[0]) ? legs[0] : null;
      if (leg) {
        const parts = [leg.airline, leg.flightNumber].map(str).filter((s): s is string => s !== null);
        const route = [leg.departureAirport, leg.arrivalAirport].map(str);
        if (route[0] !== null && route[1] !== null) parts.push(`${route[0]} to ${route[1]}`);
        if (parts.length) return parts.join(" ");
      }
    } else if (type === "Lodging") {
      const name = str(content.propertyName);
      if (name !== null) return name;
    } else {
      const name = firstString(content, ["name", "title", "vendor"]);
      if (name !== null) return name;
    }
  }
  return type;
}

/**
 * Human label stored on the event (TDD 6.4 table), clipped to `LABEL_MAX_LENGTH`. Falls back
 * to the entity type when the snapshot carries nothing usable, so the column is never empty.
 */
export function labelFor(entityType: EntityType, snapshot: Snapshot | null | undefined): string {
  const s = snapshot ?? {};
  let label: string | null;
  switch (entityType) {
    case "trip":
      label = str(s.name);
      break;
    case "itinerary":
      label = itineraryLabel(s);
      break;
    case "expense":
      label = str(s.description);
      break;
    case "participant":
    case "document":
      label = str(s.name);
      break;
    case "invite":
      label = str(s.name) ?? "Invite";
      break;
    case "user":
    case "user_email":
      label = str(s.email);
      break;
    case "service_identity":
      label = str(s.commonName);
      break;
    case "oauth_grant":
      label = str(s.clientName) ?? str(s.clientId);
      break;
    case "oauth_client":
      label = str(s.clientName);
      break;
  }
  return (label ?? entityType).slice(0, LABEL_MAX_LENGTH);
}

/**
 * Build the INSERT for one event without executing it. Returns `null` when
 * `action === "update"` and the allow-listed diff is empty; the caller then skips its whole
 * batch (TDD 7.1).
 *
 * - create: `before` and `changes` are null.
 * - delete: `after` and `changes` are null.
 * - update: both snapshots stored, `changes = diffSnapshots(before, after)`.
 * - other actions: whatever snapshots the caller passed; `changes` only when both sides are
 *   present and the diff is non-empty.
 */
export function auditInsert(db: Db, input: EventInput): AuditStatement | null {
  const { actor, action, entityType } = input;
  const before = action === "create" ? null : pickSnapshot(entityType, input.before);
  const after = action === "delete" ? null : pickSnapshot(entityType, input.after);

  let changes: Changes | null = null;
  if (action === "update") {
    changes = diffSnapshots(before, after);
    if (Object.keys(changes).length === 0) return null;
  } else if (action !== "create" && action !== "delete" && before !== null && after !== null) {
    const diff = diffSnapshots(before, after);
    changes = Object.keys(diff).length ? diff : null;
  }

  return buildInsert(db, {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    actorUserId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    actorRole: actor.role,
    channel: actor.channel,
    clientId: actor.clientId,
    clientName: actor.clientName === null ? null : actor.clientName.slice(0, LABEL_MAX_LENGTH),
    requestId: actor.requestId,
    tripId: input.tripId,
    entityType,
    entityId: input.entityId,
    entityLabel: labelFor(entityType, after ?? before),
    action,
    before,
    after,
    changes,
    metadata: input.metadata ?? null,
  });
}

/** Run the event insert on its own (TDD 7.4). No-op when `auditInsert` returns null. */
export async function recordEvent(db: Db, input: EventInput): Promise<void> {
  const stmt = auditInsert(db, input);
  if (stmt === null) return;
  await stmt;
}

// --- Cursor (TDD 6.3) ---

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Opaque cursor: base64url of the decimal `seq`. */
export function encodeCursor(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError(`Invalid seq: ${seq}`);
  return btoa(String(seq)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of `encodeCursor`. Throws `ServiceError("validation", "Invalid cursor")` on any malformed input. */
export function decodeCursor(cursor: string): number {
  const invalid = () => new ServiceError("validation", "Invalid cursor");
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 32 || !BASE64URL.test(cursor)) {
    throw invalid();
  }
  const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
  let decoded: string;
  try {
    decoded = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw invalid();
  }
  if (!DECIMAL.test(decoded)) throw invalid();
  const seq = Number(decoded);
  if (!Number.isSafeInteger(seq)) throw invalid();
  return seq;
}

// --- Reading (TDD 6.2) ---

export interface ListOptions {
  cursor?: string;
  /** Default 50, clamped to 1..200. */
  limit?: number;
  entityType?: EntityType;
  entityId?: string;
  actorUserId?: string;
  action?: Action;
  /** ISO timestamps, inclusive on `createdAt`. */
  since?: string;
  until?: string;
}

export interface AdminListOptions extends ListOptions {
  tripId?: string;
  channel?: Channel;
  clientId?: string;
}

type AuditRow = typeof auditEvents.$inferSelect;

/**
 * The stored row minus `seq`, with the JSON columns typed. `requestId` is present only on
 * admin reads (TDD 6.2).
 */
export type AuditEventView = Omit<
  AuditRow,
  "seq" | "requestId" | "before" | "after" | "changes" | "metadata" | "channel" | "entityType" | "action"
> & {
  /** Stored values are only ever what this service wrote, so the view narrows the text columns. */
  channel: Channel | "backfill";
  entityType: EntityType;
  action: Action;
  before: Snapshot | null;
  after: Snapshot | null;
  changes: Changes | null;
  metadata: Record<string, unknown> | null;
  requestId?: string | null;
};

export interface AuditPage {
  events: AuditEventView[];
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function toView(row: AuditRow, includeRequestId: boolean): AuditEventView {
  const { seq: _seq, requestId, ...rest } = row;
  const view: AuditEventView = {
    ...rest,
    channel: rest.channel as Channel | "backfill",
    entityType: rest.entityType as EntityType,
    action: rest.action as Action,
    before: (row.before as Snapshot | null) ?? null,
    after: (row.after as Snapshot | null) ?? null,
    changes: (row.changes as Changes | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
  if (includeRequestId) view.requestId = requestId;
  return view;
}

/** An ISO timestamp bound in the exact textual form createdAt is stored in. Invalid input is a validation error. */
function toStoredIso(value: string): string {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) throw new ServiceError("validation", "Invalid timestamp");
  return new Date(t).toISOString();
}

/** Shared filter clauses for `ListOptions`. The cursor clause is added here too. */
function commonFilters(opts: ListOptions): SQL[] {
  const clauses: SQL[] = [];
  if (opts.cursor !== undefined) clauses.push(lt(auditEvents.seq, decodeCursor(opts.cursor)));
  if (opts.entityType !== undefined) clauses.push(eq(auditEvents.entityType, opts.entityType));
  if (opts.entityId !== undefined) clauses.push(eq(auditEvents.entityId, opts.entityId));
  if (opts.actorUserId !== undefined) clauses.push(eq(auditEvents.actorUserId, opts.actorUserId));
  if (opts.action !== undefined) clauses.push(eq(auditEvents.action, opts.action));
  // createdAt is stored as toISOString() (UTC, milliseconds). Normalize the bounds to the same
  // form so offsets and missing milliseconds compare correctly as strings (reviewer phase-2 #1).
  if (opts.since !== undefined) clauses.push(gte(auditEvents.createdAt, toStoredIso(opts.since)));
  if (opts.until !== undefined) clauses.push(lte(auditEvents.createdAt, toStoredIso(opts.until)));
  return clauses;
}

/** `WHERE ... ORDER BY seq DESC LIMIT limit + 1`, then page bookkeeping (TDD 6.3). */
async function page(db: Db, clauses: SQL[], limit: number, includeRequestId: boolean): Promise<AuditPage> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...clauses))
    .orderBy(desc(auditEvents.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const returned = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(returned[returned.length - 1].seq) : null;
  return { events: returned.map((r) => toView(r, includeRequestId)), nextCursor };
}

/**
 * All events for a trip, newest first. Editor+ on the trip (admins everywhere); non-members
 * get `not_found`, Viewers `forbidden`. Always constrained to `trip_id = tripId`, so
 * administration events (`trip_id IS NULL`) are unreachable whatever filters are passed.
 */
export async function listTripEvents(db: Db, user: AuthUser, tripId: string, opts: ListOptions = {}): Promise<AuditPage> {
  await requireTripRole(db, user, tripId, "Editor");
  const limit = clampLimit(opts.limit);
  const clauses = [eq(auditEvents.tripId, tripId), ...commonFilters(opts)];
  return page(db, clauses, limit, isAdmin(user));
}

/**
 * History of one item on a trip. Same authorization and `trip_id` constraint as
 * `listTripEvents`. The path's `entityType` / `entityId` win over any entity filters in `opts`.
 */
export async function listEntityEvents(
  db: Db,
  user: AuthUser,
  tripId: string,
  entityType: EntityType,
  entityId: string,
  opts: ListOptions = {}
): Promise<AuditPage> {
  await requireTripRole(db, user, tripId, "Editor");
  const limit = clampLimit(opts.limit);
  const clauses = [
    eq(auditEvents.tripId, tripId),
    eq(auditEvents.entityType, entityType),
    eq(auditEvents.entityId, entityId),
    ...commonFilters({ ...opts, entityType: undefined, entityId: undefined }),
  ];
  return page(db, clauses, limit, isAdmin(user));
}

/**
 * Every event across all trips plus administration events. Admin only (`forbidden`
 * otherwise). No `trip_id` constraint unless `opts.tripId` is given. Includes `requestId`.
 */
export async function listAdminEvents(db: Db, user: AuthUser, opts: AdminListOptions = {}): Promise<AuditPage> {
  if (!isAdmin(user)) throw new ServiceError("forbidden", "Forbidden");
  const limit = clampLimit(opts.limit);
  const clauses = commonFilters(opts);
  if (opts.tripId !== undefined) clauses.push(eq(auditEvents.tripId, opts.tripId));
  if (opts.channel !== undefined) clauses.push(eq(auditEvents.channel, opts.channel));
  if (opts.clientId !== undefined) clauses.push(eq(auditEvents.clientId, opts.clientId));
  return page(db, clauses, limit, true);
}
