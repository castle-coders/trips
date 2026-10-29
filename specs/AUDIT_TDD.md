# Technical Design Document: Audit History

Companion to `specs/AUDIT_PRD.md`. The PRD states what is required. This document states how it will be built.

Code facts below were checked against the repository on 2026-10-28 (branch `claude/advertise-write-scope`).

## 1. Summary

An append-only `audit_events` table is added to D1. Every write to trip data goes through a service function that computes a before snapshot, an after snapshot and a field-level diff, then executes the data statement and the audit insert in a single `db.batch`, so a change and its record either both land or neither does. The per-request identity is widened from `AuthUser` to `Actor`, which adds the channel (web, service token, MCP) and the client id, so events made by Claude over MCP are attributed to the human user with the client recorded.

Participants, documents and invites currently write to D1 from their route handlers. They are moved into the service layer first, following the pattern used for trips, itineraries and expenses in `specs/MCP_TDD.md` section 4, so there is exactly one audit hook per entity below both REST and MCP.

Reads are three REST endpoints with cursor pagination. Authorization is Editor or above on the trip, or admin for the global log. Viewers get `403`. No MCP tool.

Two things in the PRD are amended here for SQLite reasons, see 4.1: `seq` is the primary key (SQLite `AUTOINCREMENT` needs `INTEGER PRIMARY KEY`) and `id` becomes a unique column.

## 2. Dependencies

No new packages. Everything uses what is installed: Drizzle ORM on D1, `@hono/zod-openapi`, `zod`, and `@cloudflare/vitest-pool-workers` for tests.

D1 `batch()` is already used in `createTrip` (`api/src/services/trips.ts`) and in the primary-email switch in `api/src/routes/auth.ts`, so its atomicity semantics are relied on today.

## 3. Module Layout

```
api/src/
  db/
    schema.ts              + auditEvents table
    index.ts               + Actor, Channel types; Env.Variables.user becomes Actor
  lib/
    diff.ts                diffSnapshots(before, after): Changes          (new)
  services/
    audit.ts               recordEvent, event builders, labelFor, snapshot allow-lists,
                           listTripEvents, listEntityEvents, listAdminEvents (new)
    trips.ts               createTrip, updateTrip, deleteTrip: batch + audit
    itineraries.ts         createItinerary, updateItinerary, deleteItinerary: batch + audit
    expenses.ts            createExpense, updateExpense, deleteExpense: batch + audit
    participants.ts        extracted from routes/participants.ts, with audit   (new)
    documents.ts           extracted from routes/documents.ts, with audit      (new)
    invites.ts             extracted from routes/invites.ts and the accept
                           handler in routes/auth.ts, with audit               (new)
    users.ts               admin user create/update/delete, profile update,
                           email link/unlink/primary, service identities,
                           with audit (extracted from routes/admin.ts, auth.ts) (new)
  lib/merge.ts             read-then-batch rewrite, records user.merge
  oauth/grants.ts          revokeGrant, createStaticClient, deleteClient record events
  middleware/auth.ts       sets Actor (channel, clientId, requestId)
  mcp/stage1.ts            passes channel/clientId/requestId in authInfo.extra
  mcp/context.ts           McpRequestContext.user becomes Actor
  oauth/provider.ts        apiHandler passes clientId/requestId in authInfo.extra
  routes/
    audit.ts               GET /trips/:tripId/audit, GET /trips/:tripId/audit/:entityType/:entityId (new)
    admin.ts               + GET /admin/audit
  schemas/
    audit.ts               AuditEventSchema, AuditPageSchema, query schemas   (new)
api/drizzle/
  0011_audit_events.sql
api/test/
  lib.diff.test.ts, services.audit.test.ts, audit.routes.test.ts,
  audit.atomicity.test.ts, audit.secrets.test.ts, + cases in existing service tests
web/src/
  lib/types.ts             + AuditEvent, AuditPage
  lib/api.ts               + audit.trip, audit.entity, admin.audit
  lib/auditText.ts         describeEvent(event): sentence + field labels      (new)
  components/ActivityFeed.tsx                                                 (new)
  components/HistoryModal.tsx                                                 (new)
  pages/TripDetail.tsx     Activity tab, History affordances (Editor+ only)
  pages/Admin.tsx          Audit log section
```

## 4. Data Model

### 4.1 Table

Drizzle definition added to `api/src/db/schema.ts`:

```ts
export const auditEvents = sqliteTable(
  "audit_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    createdAt: text("created_at").notNull(),
    actorUserId: text("actor_user_id"),            // no FK: survives user deletion; null for backfill
    actorName: text("actor_name").notNull(),
    actorEmail: text("actor_email").notNull(),
    actorRole: text("actor_role").notNull(),
    channel: text("channel").notNull(),            // web | service_token | mcp_stage1 | mcp_oauth | dev | backfill
    clientId: text("client_id"),
    requestId: text("request_id"),
    tripId: text("trip_id"),                        // no FK: survives trip deletion; null for admin events
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityLabel: text("entity_label").notNull(),
    action: text("action").notNull(),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    changes: text("changes", { mode: "json" }),
    metadata: text("metadata", { mode: "json" }),
  },
  (t) => [
    index("audit_events_trip_seq").on(t.tripId, t.seq),
    index("audit_events_entity_seq").on(t.entityType, t.entityId, t.seq),
    index("audit_events_actor_seq").on(t.actorUserId, t.seq),
  ]
);
```

`seq` is the primary key because SQLite only auto-increments an `INTEGER PRIMARY KEY`. It is never exposed raw; the cursor encodes it (6.3). `id` is the public identifier.

Migration `api/drizzle/0011_audit_events.sql` is generated with `npm run db:generate` and checked in. It is a pure `CREATE TABLE` plus indexes, so it is safe to apply before the code that writes to it is deployed.

The test harness wipes every table found in `sqlite_master` except internal ones (`api/test/helpers/db.ts`), so `audit_events` is cleared before each test with no change. `sqlite_sequence` is already excluded by the `sqlite_` prefix rule.

### 4.2 Types

```ts
// api/src/services/audit.ts
export type EntityType =
  | "trip" | "itinerary" | "expense" | "participant" | "document" | "invite"
  | "user" | "user_email" | "service_identity" | "oauth_grant" | "oauth_client";

export type Action =
  | "create" | "update" | "delete"
  | "accept" | "merge" | "link" | "unlink" | "set_primary" | "revoke";

/** `{ "<path>": { from?, to? } }`. A missing `from` means the path did not exist before; a missing `to` means it was removed. */
export type Changes = Record<string, { from?: unknown; to?: unknown }>;

export type Snapshot = Record<string, unknown>;
```

The `from`/`to` keys are omitted rather than set to `null` so that "field became null" and "field was removed" are distinguishable. The web's `describeEvent` renders a missing side as "(none)".

### 4.3 Actor and channel

```ts
// api/src/db/index.ts
export type Channel = "web" | "service_token" | "mcp_stage1" | "mcp_oauth" | "dev";

export interface Actor extends AuthUser {
  channel: Channel;
  /** OAuth client id (mcp_oauth) or service identity common name (service_token, mcp_stage1). */
  clientId: string | null;
  /** Cloudflare cf-ray when present. */
  requestId: string | null;
}

export type Env = {
  Bindings: { ... unchanged ... };
  Variables: {
    user: Actor;            // was AuthUser; Actor is a structural superset so readers are unaffected
    cfIdentity: CfIdentity;
  };
};
```

Where it is set:

| Path | Code | channel | clientId |
|---|---|---|---|
| Cloudflare Access, human | `authenticateCFAccess` branch 2 | `web` | null |
| Cloudflare Access, service token | `authenticateCFAccess` branch 1 (matched `service_identities`) | `service_token` | `serviceIdentities.commonName` |
| `DEV_MODE` header | `authenticateDevUser` | `dev` | null |
| MCP Stage 1 (`api/src/mcp/stage1.ts`) | after `authMiddleware`, the Actor already on `c.var.user` is copied into `authInfo.extra` as `{ userId, channel: "mcp_stage1", clientId, requestId }` | `mcp_stage1` | the service identity common name, or null for a human session hitting `/mcp` |
| MCP Stage 2 (`api/src/oauth/provider.ts` `apiHandler`) | `authInfo.extra = { userId, channel: "mcp_oauth", clientId: c.auth.clientId, requestId }` | `mcp_oauth` | OAuth client id |

`authenticateCFAccess` currently returns `AuthUser | null`; it returns `Actor | null` after this change. The function already knows which branch matched, so no extra query is needed.

`loadRequestContext` (`api/src/mcp/context.ts`) reads `channel`, `clientId` and `requestId` from `authInfo.extra` alongside `userId`, validates each as string-or-null, and builds `McpRequestContext.user: Actor` from the reloaded D1 row plus those fields. `authInfo.token` stays untouched.

`requestId` is `request.headers.get("cf-ray")`. In `authMiddleware` it comes from `c.req.header("cf-ray")`; in the MCP paths from the raw request before it is handed to the SDK.

Service write functions change their second parameter type from `AuthUser` to `Actor`. Read functions keep `AuthUser`. Every existing caller already passes `c.var.user` or `rc.user`, which become `Actor`, so no call site changes.

## 5. Diff

`api/src/lib/diff.ts`:

```ts
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): Changes;
```

Rules, applied recursively from the root with an empty path:

1. Both sides are plain objects: recurse over the union of keys. Path segment is `.key` (root keys have no leading dot).
2. Both sides are arrays: recurse by index over `max(a.length, b.length)`. Path segment is `[i]`. An index present on one side only yields `{ from }` or `{ to }` with the whole element.
3. Otherwise (primitives, null, or a type mismatch such as object vs string): compare with a structural `deepEqual`; if different, emit `{ from, to }` at the current path, omitting whichever side is `undefined`.
4. Paths listed in `IGNORED_PATHS` (`createdAt`, `updatedAt`) are skipped at the root only.

Examples, for an itinerary row whose `content` is a `FlightContent`:

| Change | Emitted key | Value |
|---|---|---|
| Status Pending to Confirmed | `status` | `{ "from": "Pending", "to": "Confirmed" }` |
| Leg 1 departure time | `content.legs[0].departureTime` | `{ "from": "2026-11-02T08:10", "to": "2026-11-02T09:45" }` |
| Second leg added | `content.legs[1]` | `{ "to": { ...leg } }` |
| Notes cleared to null | `notes` | `{ "from": "Call ahead", "to": null }` |
| Optional `fareClass` removed from leg 0 | `content.legs[0].fareClass` | `{ "from": "Y" }` |

Array elements are compared by index, as the PRD states. Inserting at the front of `legs` therefore reports every leg as changed. That is accepted for v1; the full `after` snapshot is still stored, so a smarter renderer can be added later without a data change.

`diffSnapshots(null, after)` and `diffSnapshots(before, null)` are not called; create and delete store snapshots only and `changes` is null.

## 6. Audit Service

### 6.1 Writing

```ts
// api/src/services/audit.ts
export interface EventInput {
  actor: Actor;
  tripId: string | null;
  entityType: EntityType;
  entityId: string;
  action: Action;
  before?: Snapshot | null;   // raw row; filtered through the allow-list here
  after?: Snapshot | null;
  metadata?: Record<string, unknown>;
}

/** Build the INSERT for one event. Returns null when `action === "update"` and the diff is empty. */
export function auditInsert(db: Db, input: EventInput): BatchItem | null;
```

`auditInsert` does not execute anything. It returns a Drizzle query (`db.insert(auditEvents).values(...)`) that the caller places in its `db.batch([...])` next to the data statement. This is what makes the write atomic. The helper:

1. Applies the per-entity allow-list to `before` and `after` (6.4).
2. Computes `changes = diffSnapshots(before, after)` for updates. If empty, returns `null`; the caller then skips the whole batch (7.1).
3. Derives `entityLabel` with `labelFor(entityType, after ?? before)`.
4. Fills actor fields from `actor`, `createdAt` from `new Date().toISOString()`, `id` from `crypto.randomUUID()`.

For KV-backed entities (OAuth grants and clients) and for anything that cannot share a batch, a thin `recordEvent(db, input): Promise<void>` runs the insert on its own. See 7.4 for where that is accepted.

### 6.2 Reading

```ts
export interface ListOptions {
  cursor?: string; limit?: number;                       // default 50, max 200
  entityType?: EntityType; entityId?: string;
  actorUserId?: string; action?: Action;
  since?: string; until?: string;                        // ISO timestamps, inclusive
}
export interface AdminListOptions extends ListOptions {
  tripId?: string; channel?: Channel; clientId?: string;
}
export interface AuditPage { events: AuditEventView[]; nextCursor: string | null }

export async function listTripEvents(db, user: AuthUser, tripId, opts: ListOptions): Promise<AuditPage>;
export async function listEntityEvents(db, user, tripId, entityType, entityId, opts): Promise<AuditPage>;
export async function listAdminEvents(db, user, opts: AdminListOptions): Promise<AuditPage>;
```

- `listTripEvents` and `listEntityEvents` call `requireTripRole(db, user, tripId, "Editor")`. Non-members get `not_found`, Viewers get `forbidden`, exactly as the entity writes do. Both add `tripId = ?` to the query so administration events (`tripId IS NULL`) can never be returned by a trip-scoped call, whatever filters are passed.
- `listAdminEvents` throws `forbidden` unless `isAdmin(user)`. It applies no `tripId` constraint unless the filter is given.
- `AuditEventView` is the row minus `seq`, and minus `requestId` for non-admin reads.

### 6.3 Cursor

The cursor is the `seq` of the last returned row, encoded as base64url of its decimal string. The query is `WHERE ... AND seq < :cursorSeq ORDER BY seq DESC LIMIT :limit + 1`. If `limit + 1` rows come back, the last is dropped and `nextCursor` is set from the new last row. A malformed cursor is a `validation` error. Opaque to clients, trivially stable, and index-backed by `(trip_id, seq)` and `(entity_type, entity_id, seq)`.

### 6.4 Snapshot allow-lists and labels

Allow-lists are the explicit set of columns copied into `before`/`after`. Anything not listed is dropped, so a sensitive column added later is excluded until someone opts it in (PRD 7).

| Entity | Columns in snapshot |
|---|---|
| trip | id, name, destination, startDate, endDate, description, splitwiseGroupId |
| itinerary | id, tripId, type, status, schemaVersion, content, confirmationNumber, totalCost, currency, notes |
| expense | id, tripId, description, amount, currency, category, payerId, payerName (joined at write time), splitType |
| participant | id, tripId, userId, email, name, role, traveling |
| document | id, tripId, reservationId, fileUrl, documentType, name |
| invite | id, tripId, participantId, name, role, status, invitedBy, expiresAt. **Never** `token`. |
| user | id, email, name, role, avatarUrl, googleId. **Never** `passwordHash`. |
| user_email | id, userId, email, isPrimary |
| service_identity | id, cfAccessSubject, commonName, userId |
| oauth_grant | grantId, userId, clientId, clientName, scopes, createdAt. **Never** token hashes. |
| oauth_client | clientId, clientName, redirectUris, tokenEndpointAuthMethod. **Never** the secret or its hash. |

`labelFor(entityType, snapshot)`:

| Entity | Label |
|---|---|
| trip | `name` |
| itinerary | by `type`: Flight `"{airline} {flightNumber} {departureAirport} to {arrivalAirport}"` of leg 0; Lodging `propertyName`; others the first of `name`, `title`, `vendor` present in `content`; fallback `type` |
| expense | `description` |
| participant | `name` |
| document | `name` |
| invite | `name ?? "Invite"` |
| user | `email` |
| user_email | `email` |
| service_identity | `commonName` |
| oauth_grant | `clientName ?? clientId` |
| oauth_client | `clientName` |

Labels are stored as plain strings, clipped to 200 characters. The web renders them as text (React escapes by default; no `dangerouslySetInnerHTML` anywhere in the feed).

## 7. Write Hooks

### 7.1 Pattern in a service function

`updateTrip` after the change, showing the full shape every update follows:

```ts
export async function updateTrip(db: Db, actor: Actor, tripId: string, patch: UpdateTrip): Promise<Trip> {
  await requireTripRole(db, actor, tripId, "Editor");
  const existing = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!existing.length) throw new ServiceError("not_found", "Trip not found");

  const before = existing[0];
  const updated = { ...before, ...patch, updatedAt: new Date().toISOString() };
  const audit = auditInsert(db, { actor, tripId, entityType: "trip", entityId: tripId, action: "update", before, after: updated });
  if (!audit) return before;                       // no-op update: nothing written, updatedAt untouched

  await db.batch([db.update(trips).set(updated).where(eq(trips.id, tripId)), audit]);
  return updated;
}
```

Creates pass `after` only; deletes pass `before` only. Each service already selects the existing row before updating or deleting, so no extra read is added for those. Creates do not need a read.

Returning `before` on a no-op update changes `updatedAt` behavior: today a re-sent identical body bumps `updatedAt`. PRD 6.4 requires that it does not. This is a REST behavior change and is listed in 12.

### 7.2 Per-service specifics

| Function | Batch contents | Notes |
|---|---|---|
| `createTrip` | insert trip, insert owner participant, `trip.create` | `metadata: { ownerParticipantId }`. No separate `participant.create`: the trip event covers it. |
| `deleteTrip` | delete trip (cascades), `trip.delete` | Child counts read before the batch with four `count(*)` queries, into `metadata: { itineraries, expenses, participants, documents, invites }`. Children get no individual events. |
| `createItinerary` / `updateItinerary` / `deleteItinerary` | data statement, event | `content` is validated before the snapshot is taken, so `after.content` is the normalized value that is stored. |
| `createExpense` / `updateExpense` / `deleteExpense` | data statement, event | `payerName` is resolved from `participants` before the batch and added to the snapshot. `payerId` null gives `payerName` null. |
| `participants.*` (new service) | data statement, event | Owner-only checks move from the route into the service with `requireTripRole(..., "Owner")`. Route keeps the `403`/`404` responses through `ServiceError`. |
| `documents.*` (new service) | data statement, event | Today these routes have no role check beyond `requireTripEditor`. The service calls `requireTripRole(..., "Editor")`, which is the same rule, made explicit. |
| `invites.create` / `invites.delete` (new service) | data statement, event | Owner-only. The snapshot allow-list drops `token`. |
| `invites.accept` (new service, called from `routes/auth.ts`) | `[maybe update users.name, maybe insert participant, update invites.status, user.update?, participant.create?, invite.accept]` | Actor is the accepting user (it may have just been created by `createUserWithEmail`, which itself records `user.create` with the new user as actor, channel `web`). `invite.accept` metadata: `{ participantId, alreadyParticipant }`. |

### 7.3 Administration

Extracted into `api/src/services/users.ts` and hooked the same way:

| Route | Event | Batch |
|---|---|---|
| `POST /admin/users` | `user.create` | insert users, insert user_emails, event |
| `PUT /admin/users/:id` | `user.update` | update, event (skipped when diff is empty) |
| `DELETE /admin/users/:id` | `user.delete` | `revokeAllGrantsForUser` first (KV, as today), then batch delete + event. `metadata: { revokedGrants }`. Ordering is fail-closed: if the batch then fails, the grants are already gone (unaudited) and the user row remains; the reverse order would leave live tokens for a deleted user. Merge follows the same order and its metadata carries no grant count. |
| `PUT /me` | `user.update` | update, event |
| `POST /me/link`, `POST /link`, `POST /link/{token}/confirm` | `user.merge` | These flows merge the linking account into the existing one through `mergeAccountsD1`; no path inserts a bare `user_emails` row today. `linkEmail` exists in the users service for a future single-address link and records `user_email.link`. (amended at Phase 1) |
| `DELETE /me/emails/:id` | `user_email.unlink` | delete, event |
| `PUT /me/emails/:id/primary` | `user_email.set_primary` | the existing three-statement batch plus event. `before`/`after` are the user_email row; `metadata: { previousPrimaryEmailId }`. |
| `POST /admin/service-identities` | `service_identity.create` | insert, event |
| `DELETE /admin/service-identities/:id` | `service_identity.delete` | delete, event |
| `POST /admin/users/merge` | `user.merge` | see below |

**Merge.** `mergeAccountsD1` runs its writes sequentially today, with a comment noting D1 has no transactions. It is restructured as read-then-batch: all reads (both users, both participant lists, the dedup decisions) happen first, then every `update`/`delete` statement and the `user.merge` event go into one `db.batch`. This makes the merge itself atomic, which it is not today, and lets the audit row ride the same batch. `user.merge` is recorded on the surviving user: `entityId = keepUserId`, `before` = keep user snapshot, `after` = keep user after promotion, `metadata: { mergedUserId, mergedEmail, movedEmails, movedParticipants, dedupedTrips, promotedRole }`. The merged-away user's grant revocation stays before the batch as it is today.

### 7.4 KV-backed entities (OAuth grants and clients)

`revokeGrant`, `createStaticClient` and `deleteClient` in `api/src/oauth/grants.ts` write to `OAUTH_KV` through the provider helpers. KV and D1 cannot share a batch. For these three, the event is written with `recordEvent` **after** the KV operation succeeds:

- Success then audit failure: the request returns `500` through `onError`, but the KV change stands. The event is lost.
- This is the one place the PRD's "data is never changed without a record" cannot be guaranteed by construction. It is accepted because these are rare admin actions, the alternative (write the event first, then roll it back on KV failure) would need an audit delete, and the grant list itself remains the source of truth. Noted in PRD section 7 as an amendment.

`revokeGrant` is called by both `/admin/grants/:userId/:grantId` and `/me/grants/:grantId`. Both route handlers call `recordEvent` with their own actor after a `true` result. `metadata: { scopes, clientId, selfService: boolean }`.

### 7.5 What is not audited

- OAuth token issuance, refresh, consent screens, DCR registration (PRD non-goal).
- `account_link_tokens` creation (`POST /me/link-token`): a short-lived token, not a durable change. The resulting `user_email.link` is recorded.
- `GET` requests of any kind.

## 8. REST Endpoints

`api/src/routes/audit.ts`, mounted in `api/src/index.ts` as `app.route("/trips/:tripId/audit", auditRoutes)` after the existing `/trips/*` middleware. `requireTripEditor` lets `GET` through; the Editor check is done in the service (6.2). The admin endpoint is added to `routes/admin.ts`, which is already behind `requireAdmin`.

| Method and path | Query | Response |
|---|---|---|
| `GET /trips/{tripId}/audit` | `cursor, limit, entityType, entityId, actorUserId, action, since, until` | `AuditPage` |
| `GET /trips/{tripId}/audit/{entityType}/{entityId}` | `cursor, limit, action, since, until` | `AuditPage` |
| `GET /admin/audit` | all of the above plus `tripId, channel, clientId` | `AuditPage` (with `requestId`) |

Schemas in `api/src/schemas/audit.ts`:

```ts
export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  actorUserId: z.string().uuid().nullable(),
  actorName: z.string(), actorEmail: z.string(), actorRole: z.string(),
  channel: z.enum(["web", "service_token", "mcp_stage1", "mcp_oauth", "dev", "backfill"]),
  clientId: z.string().nullable(),
  requestId: z.string().nullable().optional(),     // admin only
  tripId: z.string().uuid().nullable(),
  entityType: z.enum([...]), entityId: z.string(), entityLabel: z.string(),
  action: z.enum([...]),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  changes: z.record(z.object({ from: z.unknown().optional(), to: z.unknown().optional() })).nullable(),
  metadata: z.record(z.unknown()).nullable(),
}).openapi("AuditEvent");

export const AuditPageSchema = z.object({ events: z.array(AuditEventSchema), nextCursor: z.string().nullable() }).openapi("AuditPage");
```

Status codes: `403` for Viewers and non-admins, `404` for non-members, `400` for a bad cursor or filter, all through the existing `ServiceError` mapping in `onError`. The `openapi.test.ts` snapshot is updated for the three new paths.

## 9. Web

### 9.1 API client and types

`web/src/lib/types.ts` gains `AuditEvent` and `AuditPage` mirroring 8. `web/src/lib/api.ts` gains:

```ts
export const audit = {
  trip: (tripId: string, q: AuditQuery) => request<AuditPage>(`/trips/${tripId}/audit?${qs(q)}`),
  entity: (tripId: string, type: string, id: string, q: AuditQuery) =>
    request<AuditPage>(`/trips/${tripId}/audit/${type}/${id}?${qs(q)}`),
};
export const admin = { ..., audit: (q: AdminAuditQuery) => request<AuditPage>(`/admin/audit?${qs(q)}`) };
```

### 9.2 Rendering

`web/src/lib/auditText.ts` exports `describeEvent(e: AuditEvent): { headline: string; details: Array<{ label: string; from?: unknown; to?: unknown }> }`:

- Headline: `"{actor} {verb} {entityNoun} {entityLabel}"` with a `via {client}` suffix when `channel` is `mcp_oauth`, `mcp_stage1` or `service_token`. Actor is `actorName`. Verbs per action: created, changed, deleted, accepted, merged, linked, unlinked, made primary, revoked. For an `update` with exactly one change the headline inlines it: `"Alice changed Flight UA 123 departure time from 08:10 to 09:45"`.
- Details: one row per `changes` key. `FIELD_LABELS` maps known paths to words (`status` to "status", `content.legs[0].departureTime` to "leg 1 departure time" through a small pattern table, `confirmationNumber` to "confirmation number"). Unknown paths fall back to the raw path. Values are formatted with the helpers in `web/src/lib/format.ts` where the type is known (dates, money), else `JSON.stringify`.
- Create and delete show the snapshot as a key/value list with the same labels.

`ActivityFeed` is a presentational list: takes a loader `(cursor) => Promise<AuditPage>`, renders headlines newest first, expands a row on click to show details, and has a "Load more" button driven by `nextCursor`. It is used in three places with different loaders and filter chips.

### 9.3 Trip page

`TripDetail.tsx` gains an **Activity** tab next to the itinerary. It is rendered only when the caller's role on the trip is Editor or Owner, using the same role derivation the page already uses to show edit controls. Filters: person (built from the trip's participants plus any `actorUserId` seen in the page), item type, date range. Each itinerary item, expense and participant row gets a "History" control that opens `HistoryModal`, an `ActivityFeed` with the entity loader. The API enforces the role independently; the UI gate only avoids a `403` round-trip for Viewers.

### 9.4 Admin page

`Admin.tsx` gains an **Audit log** section after Connected apps, with filters for trip (free text id or picked from the users' trips), person, channel, client, entity type, action and date range. Rows expand to the raw `before`, `after`, `changes` and `metadata` in a `<pre>`.

## 10. Security Design

- **Authorization in the service.** Minimum role Editor is enforced by `requireTripRole` inside `listTripEvents` and `listEntityEvents`; `isAdmin` inside `listAdminEvents`. Routes and UI add nothing the service does not enforce.
- **Scope isolation.** Trip-scoped queries always constrain `trip_id = ?`; administration events have `trip_id IS NULL` and are unreachable from them.
- **Actor from context only.** `EventInput.actor` is the `Actor` the middleware or MCP context built. No route reads an actor from a body or query.
- **Allow-listed snapshots.** 6.4. Tested by `audit.secrets.test.ts` (11).
- **Append-only.** No code path issues `UPDATE` or `DELETE` against `audit_events`. Enforced by `api/scripts/check-audit-append-only.sh`, run in CI, which fails on any `auditEvents` reference passed to `db.update` or `db.delete`, and on the strings `UPDATE audit_events` / `DELETE FROM audit_events` outside the test helpers. The test harness's `resetStorage` is the sole exception and lives under `api/test/`.
- **No secrets in `requestId` or `clientId`.** `cf-ray` and OAuth client ids are public identifiers. `authInfo.token` is never read (existing MCP rule).
- **Rendering.** All strings are rendered as React text nodes.

## 11. Testing

All tests run in workerd under the existing harness (`api/vitest.config.mts`, `api/test/setup.ts`), which applies migrations once per file and wipes tables before each test.

| File | Covers |
|---|---|
| `lib.diff.test.ts` | Flat rows, nested `content`, array growth and shrink, null vs absent, ignored root keys, type-mismatch leaves, empty diff. |
| `services.audit.test.ts` | `auditInsert` returns null on empty update diff; allow-lists drop `token`, `passwordHash`; `labelFor` per type; cursor round-trip; filters; `listTripEvents` never returns `tripId IS NULL` rows even with crafted filters. |
| `services.{trips,itineraries,expenses}.test.ts` (extended) | Each write produces exactly one event with the expected `changes`; no-op update produces none and leaves `updatedAt`; delete trip metadata counts. |
| `services.{participants,documents,invites,users}.test.ts` (new) | Parity with the old route behavior (status codes via `ServiceError`) plus events. Invite accept produces `invite.accept` and `participant.create` with the accepting user as actor. Merge produces one `user.merge` and leaves the data as before the refactor. |
| `audit.atomicity.test.ts` | Wraps `db` with `Object.create(db, { batch: { value: () => Promise.reject(new Error("boom")) } })`, calls `updateTrip`, asserts the trip row is unchanged and no event exists. Same for one create and one delete. |
| `audit.routes.test.ts` | Owner/Editor `200`, Viewer `403`, non-member `404`, admin `200`; `/admin/audit` non-admin `403`; `requestId` present only for admin; pagination walks all pages; bad cursor `400`. |
| `audit.secrets.test.ts` | Drives every administration path (user create, link, primary, service identity, static client create, grant revoke after an OAuth flow using the `oauth.flow.test.ts` helpers) and then scans every `before`/`after`/`metadata` for the literal secret values used in the test. |
| `mcp.*.test.ts` (extended) | `update_itinerary` over Stage 1 records `channel = mcp_stage1`; over the Stage 2 handler records `mcp_oauth` with the client id from the flow test. |
| `openapi.test.ts` | Snapshot includes the three new paths. |

The append-only check (10) is a shell script, not a workerd test, because tests in the pool cannot read the source tree.

### 11.1 Acceptance mapping

One row per PRD section 10 criterion. "Automated" rows run in `npm test`; "CI-only" rows run as a workflow step; "manual" rows name the exact step to perform against a deployed or `wrangler dev` build.

| AC | Criterion | Test file and name(s) | Status |
|---|---|---|---|
| 1 | Web itinerary departure-time PUT: one `itinerary.update`, actor, `channel = web`, `changes` exactly the leg path | `audit.acceptance.test.ts` "AC1: web itinerary PUT changing a departure time ..." (real Access JWT, so the channel is `web`); service level: `services.itineraries.test.ts` "update changing one flight leg's departure time records exactly that JSON path" | Automated |
| 2 | Same over MCP Stage 2: `channel = mcp_oauth`, `clientId` set, attributed to the human | `mcp.audit.test.ts` "PRD acceptance 2: a flight departure-time change over Stage 2 is the same event as over REST, except channel and clientId"; `audit.acceptance.test.ts` "AC2: ..." | Automated |
| 3 | Unchanged PUT: no event, `updatedAt` unchanged | `audit.acceptance.test.ts` "AC3: a PUT that re-sends every field unchanged ..." (REST); `services.itineraries.test.ts` "a no-op update records nothing, writes nothing and returns the stored row with updatedAt untouched"; `mcp.audit.test.ts` "Stage 1: re-sending every stored value records nothing and leaves updatedAt", "Stage 2: the same no-op ..." | Automated |
| 4 | Delete trip: one `trip.delete` with snapshot and child counts, readable via `/admin/audit` afterwards | `audit.acceptance.test.ts` "AC4: deleting a trip records one trip.delete ..."; `services.trips.test.ts` "delete metadata counts every child table, and children get no events of their own" | Automated |
| 5 | Delete or merge a user: past events keep `actorName` / `actorEmail` | `audit.acceptance.test.ts` "AC5: deleting and merging users leaves their earlier events intact ..." | Automated |
| 6 | Viewer gets `403` on both trip endpoints; Activity tab and History affordances hidden | API half: `audit.acceptance.test.ts` "AC6: ..."; `audit.routes.test.ts` "trip endpoint: Owner, Editor and admin (not a participant) 200; Viewer 403; non-member 404", "entity endpoint: ...". UI half: manual. Sign in as a Viewer on a trip, open the trip page, confirm there is no Activity tab and no History link on any itinerary, expense, participant or document row. | Automated (API) / manual (UI) |
| 7 | Non-member `404` on `/trips/{id}/audit`; non-admin `403` on `/admin/audit` | `audit.acceptance.test.ts` "AC7: ..."; `audit.routes.test.ts` "/admin/audit: admin 200; every non-admin (including the trip Owner) 403 Forbidden", "the outsider (Owner of the other trip) can read the other trip but not this one" | Automated |
| 8 | Audit insert failure rolls back the data write | `audit.atomicity.test.ts` (one case per write function, "<fn> records ..." positive controls, "a failing audit insert rolls back a preceding UPDATE" / "... DELETE"); `services.audit.test.ts` "a failing second statement rolls back the data insert (D1 batch atomicity)". No REST-level test: the batch seam is on the `db` object the service receives, which a Worker request does not expose. | Automated (service level) |
| 9 | No `UPDATE` / `DELETE` against `audit_events` in the API source; no route exposes one | CI-only: `api/scripts/check-audit-append-only.sh`, run by the "Check audit_events is append-only" step in `.github/workflows/deploy-api.yml` (also `npm run check:audit`). Tests run in workerd and cannot read the source tree. In-process half: `services.audit.test.ts` "the service module exports no update or delete function for audit rows"; `openapi.test.ts` snapshot shows the three audit paths are `GET` only. | CI-only (script) / automated (exports, OpenAPI) |
| 10 | Activity tab newest first, cursor pagination, MCP events labelled with the client name | API half: `audit.routes.test.ts` "limit=30 walks 5 pages with no duplicates or gaps, newest first throughout, last page nextCursor null", "entity endpoint paginates one entity's history". UI half: manual. Make more than 50 edits on a trip, open Activity, confirm newest first, click "Load more" until the list ends with no repeats. Make one edit through Claude over MCP and confirm the entry shows "via <client>". Note: the event row carries `clientId` only, and the web `viaLabel` falls back to the id, so for a DCR-registered client the label is the opaque client id, not its name (see Phase 4 QA report). | Automated (API) / manual (UI) |
| 11 | No password hash, JWT, OAuth token, client secret, invite token or link token in any `audit_events` row | `audit.secrets.test.ts` "no secret, its SHA-256 (hex or base64url) or its base64/base64url form appears in any column of any row", "no forbidden key name appears anywhere in the JSON columns, nested objects included", and the rest of that file | Automated |

## 12. Rollout

1. **Migration.** The deploy workflow already applies D1 migrations before `wrangler deploy`. `0011_audit_events.sql` creates an empty table; the old code ignores it.
2. **Deploy.** No flag. Events start being written at first request on the new code.
3. **Behavior changes to announce** (same list goes in the README rollout notes, as with the MCP behavior changes):
   - A `PUT` whose body matches the stored row no longer bumps `updatedAt` and returns the stored row.
   - Participants, documents and invites routes now return `ServiceError` bodies (`{ error }`), same messages and status codes as before.
   - Account merge is now atomic. Invite acceptance is now atomic (one batch instead of three sequential statements).
   - `POST /admin/users/merge` returns `404` only for a missing user; any other failure is a `500` through the shared error handler instead of a `404` carrying the internal error text.
   - `GET /trips/{tripId}/participants` and `GET /trips/{tripId}/documents` return `404` for non-members (previously participants returned the full list to anyone authenticated; documents already returned 404). Decided at Phase 1, 2026-10-28: the extracted services apply `requireTripRole(..., "Viewer")` on reads like every other service.
4. **Backfill** (PRD open question). If chosen, `api/scripts/backfill-audit.sql` inserts one `create` event per existing row in trips, itineraries, expenses, participants, documents and invites with `channel = "backfill"`, `actor_user_id = NULL`, `actor_name = "System"`, `actor_email = ""`, `actor_role = ""`, `created_at = <row>.created_at`, `after` built with SQLite `json_object(...)` over the allow-listed columns, `entity_label` from the same expressions `labelFor` uses. It is idempotent (skips rows that already have a `create` event) and run once with `wrangler d1 execute`. Not run by default.

## 13. Open Items

1. **Array diff quality.** Index-based comparison makes "insert a leg at the front" look like every leg changed. If this is noisy in practice, a follow-up can match array elements by a per-type identity key (for flight legs `flightNumber + departureTime`) in `diffSnapshots`. Storage is unaffected.
2. **Expense `payerName` in snapshot.** Joined at write time for readability. It makes the expense allow-list include a derived field; confirm that is acceptable versus resolving names at read time from `participants` (which loses names of removed participants).
3. **Admin page trip filter.** Free-text trip id is sufficient for v1. A trip picker needs an admin trip list endpoint that does not exist yet.
4. **`user.create` on invite accept.** The actor is the brand-new user themselves, channel `web`. Alternative: attribute it to the inviter via `invitedBy`. Current choice keeps "actor = the authenticated principal" uniform.
