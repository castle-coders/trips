# Product Requirements Document: Audit History

Status: Draft, 2026-10-28. Decisions 2026-10-28: history is visible to Editors, Owners and admins only (never Viewers); no MCP history tool.

## 1. Overview

Trips are edited by several people through several channels: the web app, the REST API, and (since the MCP server shipped) Claude and Gemini agents acting on a user's behalf. Today the only trace of a change is the `updated_at` column on the row. Nobody can answer "who moved this flight?", "who changed the hotel confirmation number?", or "what did this expense look like before an agent edited it?".

This feature adds an append-only audit history to the Trips API and surfaces it in the web app. Every create, update and delete of trip data records **who** made the change, **through what channel**, **when**, and **exactly what changed** (field-level before and after values). Editors and Owners can read the history of their trip; admins can read everything, including account and access administration events. Viewers never see history.

## 2. Goals

- Record every mutation of trip data (trips, itineraries, expenses, participants, documents, invites) with the acting user and a field-level diff.
- Record account and access administration events (user role changes, account merges, service identities, OAuth grants and clients, email linking) so admins can see who changed who-can-do-what.
- Attribute agent-driven changes correctly: an edit made by Claude through MCP is recorded as the human user the token belongs to, with the channel and OAuth client identified.
- Capture the audit record in the same atomic write as the data change, so the history can never disagree with the data.
- Show the history in the web app on the trip page (per trip and per item) for Editors and Owners, and on the Admin page (global).
- Keep one implementation: a single audit helper called from the service layer, shared by REST and MCP, so the two paths can never drift.

## 3. Non-Goals

- Undo, restore or rollback from history. v1 is read-only. The stored snapshots must be complete enough that restore can be added later without a schema change.
- Auditing reads (who viewed a trip). Only writes are recorded.
- Export to an external log system or SIEM. Events live in D1 and are read through the API.
- Automatic retention purging. v1 keeps events indefinitely (see Open Questions).
- Auditing the OAuth server's own internal state (token issuance, refresh, consent screens). Those remain in Worker logs. Grant **revocation** and client create/delete are in scope because they are user-visible administration actions.
- Exposing history through MCP. No history tool is added and none is planned. MCP write tools still produce events (6.7).

## 4. Background and Constraints

### 4.1 Existing write paths

| Entity | Where writes happen today | Channels |
|---|---|---|
| trips, itineraries, expenses | `api/src/services/*.ts` (shared by REST routes and MCP tools) | web, REST, MCP |
| participants, documents, invites | Directly inside `api/src/routes/*.ts` | web, REST |
| users, user_emails, service_identities, account merge | `api/src/routes/admin.ts`, `api/src/routes/auth.ts`, `api/src/lib/merge.ts` | web, REST |
| OAuth grants and static clients | `api/src/routes/admin.ts`, `api/src/routes/auth.ts` via `api/src/oauth/grants.ts` (stored in KV, not D1) | web, REST |

The service layer only covers three entities. Participants, documents and invites write to D1 straight from the route handlers, so the audit hook cannot simply live in the service layer today. See 5.2.

### 4.2 Identity available at write time

- REST: `authMiddleware` sets `c.var.user` (`AuthUser`: id, email, name, global role). It does **not** currently expose whether the request came from a human session or a Cloudflare Access service token mapped through `service_identities`.
- MCP Stage 1: same as REST (service token behind Access).
- MCP Stage 2: `loadRequestContext` reloads the user from D1 by `userId`; the OAuth `clientId` is available in `authInfo` but is not currently put on `McpRequestContext`.
- Local development: `DEV_MODE` plus the `X-Dev-User-Email` header.

The audit record needs a richer actor context than `AuthUser` provides. See 6.2.

### 4.3 Storage constraints

- D1 (SQLite) does not support `BEGIN`/`COMMIT`. Atomic multi-statement writes must use `db.batch([...])`, which D1 executes as one transaction. Today's services issue sequential statements.
- D1 row size and query limits are generous but not infinite. Full JSON snapshots of itinerary `content` are small (kilobytes), so storing before and after snapshots per event is acceptable.
- Trips are cascade-deleted with all children. Audit rows must **not** cascade, or the record of a deletion would delete itself.

### 4.4 Sensitive data

- Viewer-role users already receive projected view schemas that strip `confirmationNumber` and ticket numbers. History contains those values in snapshots, so it is restricted to Editor and above rather than projected.
- Password hashes, Access JWTs, OAuth tokens, invite tokens and account-link tokens must never be written to an audit row, even inside a snapshot.

## 5. Architecture

### 5.1 Components

| Component | Location | Responsibility |
|---|---|---|
| Audit table | `api/src/db/schema.ts`, new migration | Append-only `audit_events` table (6.3). |
| Audit service | `api/src/services/audit.ts` | `recordEvent(...)` builds a row from before/after snapshots and the actor context; `listTripEvents`, `listEntityEvents`, `listAdminEvents` read with authorization (Editor+ on the trip, or admin). |
| Diff helper | `api/src/lib/diff.ts` | Produces the `changes` JSON from two snapshots, column-level for flat rows and path-level for the itinerary `content` document. |
| Actor context | `api/src/db/index.ts`, `authMiddleware`, `loadRequestContext` | Extends the per-request identity with channel and client information (6.2). |
| Service hooks | `api/src/services/{trips,itineraries,expenses,participants,documents,invites}.ts` | Every write calls the audit service inside the same `db.batch`. Participants, documents and invites are extracted into services as part of this work. |
| Admin and auth hooks | `api/src/routes/admin.ts`, `api/src/routes/auth.ts`, `api/src/lib/merge.ts` | Record administration events. |
| REST endpoints | `api/src/routes/audit.ts` | `GET /trips/{tripId}/audit`, `GET /trips/{tripId}/audit/{entityType}/{entityId}`, `GET /admin/audit`. |
| Web UI | `web/src/pages/TripDetail.tsx`, `web/src/pages/Admin.tsx`, new `web/src/components/ActivityFeed.tsx` | Activity tab on the trip page, "History" on each item, global log on Admin. |

### 5.2 Where the hook lives

The audit write must happen in exactly one place per entity, below both REST and MCP. For trips, itineraries and expenses that is the existing service function. Participants, documents and invites are moved into `api/src/services/` following the same pattern (validate in the route, call the service, map the result) before the hook is added. Route handlers must not write to D1 directly for any audited entity after this work.

Each service write function:
1. Loads the current row (the **before** snapshot). For creates there is none.
2. Builds the new row (the **after** snapshot). For deletes there is none.
3. Computes `changes` from the two snapshots. If an update produces an empty diff, no row is written and no audit event is recorded.
4. Executes the data statement and the audit insert in one `db.batch`.

### 5.3 Reading history

Reads go through the audit service, which calls `requireTripRole` with a minimum of Editor for trip history (admins are Owner everywhere) and `isAdmin` for the global log. Viewers receive `403`, the same as any other write-level action on the trip. No field projection is applied: everyone who can read history can already see every field in the current data.

## 6. Functional Requirements

### 6.1 Events recorded

**Trip data** (visible to trip members):

| Entity | Actions | Notes |
|---|---|---|
| trip | create, update, delete | Delete records a full snapshot of the trip row plus counts of deleted children (itineraries, expenses, participants, documents, invites). Children are not individually recorded on cascade. |
| itinerary | create, update, delete | `content` is diffed by JSON path (6.4). |
| expense | create, update, delete | Includes `payerId` and the payer's name at the time, so the history reads correctly after a participant is removed. |
| participant | create, update, delete | Role changes are the main case. A participant created by invite acceptance is recorded with the accepting user as actor. |
| document | create, update, delete | `fileUrl` is included; it is a reference, not a secret. |
| invite | create, accept, delete | The invite token is never stored. `accept` is recorded on the invite entity alongside the `participant.create` it causes, both with the accepting user as actor. |

**Administration** (visible to admins only, under the global log):

| Entity | Actions | Notes |
|---|---|---|
| user | create, update, delete, merge | `update` covers global role and name changes. `merge` records both user ids and the surviving user; it is recorded once, not per moved row. Password hashes are excluded from snapshots. |
| user_email | link, unlink, set_primary | Recorded for both self-service (`/me/emails`) and admin paths. |
| service_identity | create, delete | Subject and common name are recorded. |
| oauth_grant | revoke | Recorded for both admin and self-service revocation. Client id and the grant's scopes are recorded. Grant creation is a non-goal (4, Non-Goals). |
| oauth_client | create, delete | Client id and name. Secrets are never recorded. |

A user editing their own name through `PUT /me` is recorded as `user.update` with themselves as actor.

### 6.2 Actor and channel

Every event records:

| Field | Description |
|---|---|
| `actorUserId` | The human user the change is attributed to. For MCP this is the token's user, never a client or service identity. May point to a user that was later deleted or merged. |
| `actorName`, `actorEmail` | Snapshot at the time of the event, so history stays readable after the user is deleted, renamed or merged. |
| `actorRole` | The actor's global role at the time. |
| `channel` | One of `web`, `service_token`, `mcp_stage1`, `mcp_oauth`, `dev`. |
| `clientId` | For `mcp_oauth`: the OAuth client id. For `service_token` and `mcp_stage1`: the service identity common name. Null otherwise. |
| `requestId` | The Cloudflare `cf-ray` header when present, for correlating with Worker logs. |

To support this, the per-request identity must carry channel and client information:
- `authMiddleware` sets the channel to `service_token` when the subject resolved through `service_identities`, and records the common name. Otherwise `web`. In `DEV_MODE` with the dev header, `dev`.
- The Stage 1 MCP route sets `mcp_stage1` and carries the service identity common name.
- `loadRequestContext` sets `mcp_oauth` and the `clientId` from `authInfo`.
- The bearer token itself is never read for this purpose and never stored (consistent with the existing MCP rule that `authInfo.token` is never touched).

Distinguishing `web` from direct REST calls by a human with a browser session is not possible from the Access JWT and is not required.

### 6.3 Event record

Table `audit_events`, append-only. No REST endpoint, service function or admin tool updates or deletes rows. The deploy role for D1 is the only thing that can remove them.

| Column | Type | Notes |
|---|---|---|
| `id` | text, unique | UUID, the public identifier. |
| `seq` | integer PK, autoincrement | Strictly increasing insertion order, used for stable cursor pagination. ISO timestamps alone can collide. (amended by TDD 4.1: `seq` is the primary key because SQLite only auto-increments an `INTEGER PRIMARY KEY`; `id` is unique.) |
| `createdAt` | text | ISO 8601 UTC. |
| `actorUserId`, `actorName`, `actorEmail`, `actorRole` | text | 6.2. `actorUserId` has **no** foreign key so rows survive user deletion. |
| `channel`, `clientId`, `requestId` | text | 6.2. |
| `tripId` | text, nullable, indexed | Set for all trip-data events. **No** foreign key, so rows survive trip deletion. Null for administration events. |
| `entityType` | text | `trip`, `itinerary`, `expense`, `participant`, `document`, `invite`, `user`, `user_email`, `service_identity`, `oauth_grant`, `oauth_client`. |
| `entityId` | text, indexed with `entityType` | The row id (or KV key for grants and clients). |
| `entityLabel` | text | Human label at the time: trip name, itinerary summary ("Flight UA 123 SFO to JFK"), expense description, participant name, user email. Lets the feed render without joining rows that may be gone. |
| `action` | text | `create`, `update`, `delete`, `accept`, `merge`, `link`, `unlink`, `set_primary`, `revoke`. |
| `before` | text (JSON), nullable | Full snapshot before the change. Null for create. |
| `after` | text (JSON), nullable | Full snapshot after the change. Null for delete. |
| `changes` | text (JSON), nullable | For update: `{ "<path>": { "from": ..., "to": ... } }`. Null for create and delete, where the snapshot is the record. For accept, merge and set_primary it is the diff of the two snapshots when both are present (amended at Phase 1). |
| `metadata` | text (JSON), nullable | Action-specific extras: child counts on trip delete, merged user id on merge, scopes on grant revoke. |

Indexes: `(tripId, seq)`, `(entityType, entityId, seq)`, `(actorUserId, seq)`, `(seq)`.

Snapshots exclude `createdAt`, `updatedAt`, `passwordHash`, every `token` column, and OAuth client secrets. Everything else on the row is included. (amended 2026-10-28 at Gate 0: the `oauth_grant` snapshot keeps the grant's `createdAt`, since a revoke event is the only record of when the grant was made.)

### 6.4 What counts as a change

- Column-level diff for flat rows. `createdAt` and `updatedAt` are ignored. An update whose diff is empty records nothing and does not bump `updatedAt`.
- For itinerary `content` (a type-specific JSON document), the diff is by JSON path, for example `content.legs[0].departureTime` or `content.address.city`. Array elements are compared by index; inserting or removing an element records the affected index and everything after it. Whole-object replacement is not acceptable because the UI must say "departure time changed from 08:10 to 09:45".
- Values are stored as JSON, with their original types.
- Partial updates (`PUT` with a subset of fields, MCP `update_itinerary`) record only the fields that actually changed, never the fields that were merely re-sent with the same value.

### 6.5 REST API

All endpoints require authentication and return `AuditEvent` objects as described in 6.3, minus `requestId` for non-admins.

| Endpoint | Who | Behavior |
|---|---|---|
| `GET /trips/{tripId}/audit` | Editor+ on the trip, admin | All trip-data events for the trip, newest first. Query: `cursor`, `limit` (default 50, max 200), `entityType`, `entityId`, `actorUserId`, `action`, `since`, `until`. |
| `GET /trips/{tripId}/audit/{entityType}/{entityId}` | Editor+ on the trip, admin | History of one item. Same query parameters minus the entity filters. |
| `GET /admin/audit` | Admin | Every event across all trips plus administration events. Adds filters `tripId`, `channel`, `clientId`. Includes events for trips that no longer exist. |

Rules:
- Pagination is cursor-based on `seq`. Responses carry `nextCursor`; the cursor is opaque to clients.
- Viewers on the trip get `403`. Non-members get `404`, matching `requireTripRole` behavior for the entity itself.
- History of a deleted trip is reachable only by admins, through `/admin/audit` or `/trips/{tripId}/audit` (admins are Owner everywhere with no trip-existence check), since no one else is a member of a deleted trip. (amended at Phase 2)
- The endpoints are included in the OpenAPI document like every other route.

### 6.6 Web app

**Trip page** (`TripDetail.tsx`):
- A new **Activity** tab alongside the existing views. It lists events newest first as sentences: "Alice changed Flight UA 123 departure time from 08:10 to 09:45", "Claude (for Bob) added expense Dinner, $84.00", "Carol removed Dave from the trip". Each entry expands to the full field-level diff.
- Filters: by person, by item type, by date range. Infinite scroll or "Load more" driven by `nextCursor`.
- Entries made through MCP show the channel and client name ("via Claude") so members can tell human edits from agent edits.
- Each itinerary item, expense and participant has a **History** affordance that opens the per-item history (`6.5`, second endpoint). (amended at Phase 3: the trip page renders no expense or document rows today, so History controls exist on itinerary cards and participant rows; the endpoint supports every entity type.)
- The Activity tab and the History affordances are not rendered for Viewers. The API enforces this independently of the UI.

**Admin page** (`Admin.tsx`):
- A new **Audit log** section listing every event with filters on trip, person, channel, client, entity type, action and date. Includes administration events and deleted trips.
- Each row expands to the raw `before`, `after`, `changes` and `metadata`.

### 6.7 MCP

No new tool in v1. Existing write tools (`create_trip`, `create_itinerary`, `update_itinerary`, `add_expense`) must produce events with `channel = mcp_oauth` (or `mcp_stage1`) and the correct `clientId`, through the shared service functions with no MCP-specific code.

## 7. Security Requirements

- Authorization for reading history is identical to reading the entity: the audit service calls `requireTripRole` with the same minimum role. Admin-only events are never returned by trip-scoped endpoints, even when `tripId` is null and a filter is crafted to match.
- The Editor minimum is enforced in the audit service, not in the route or the UI, so any future consumer gets the same restriction.
- Secrets listed in 4.4 are excluded at snapshot time by an allow-list of columns per entity, not a deny-list, so a newly added sensitive column is excluded by default until someone opts it in.
- Audit rows are append-only. No code path updates or deletes them; the Drizzle schema exposes no delete helper for the table and tests assert the absence of `UPDATE`/`DELETE` against it in the API.
- Actor attribution cannot be spoofed by the caller: the actor comes from the authenticated context only, never from the request body.
- `entityLabel`, `actorName` and all snapshot values are untrusted user content. The web app renders them as text, never as HTML.
- Audit writes are part of the data write's `db.batch`. A failure to record an event fails the request; data is never changed without a record. (amended by TDD 7.4: OAuth grant revocation and static client create/delete live in KV and cannot share a D1 batch; their events are written after the KV operation, so an audit failure there returns 500 with the KV change in place.)

## 8. Configuration

No new secrets, bindings or vars. One new D1 migration under `api/drizzle/`. The migration runs through the existing deploy workflow.

## 9. Delivery Plan

1. **Schema and service.** Add `audit_events` and the migration. Build `api/src/services/audit.ts` and `api/src/lib/diff.ts` with unit tests for the diff (flat rows, nested `content`, array edits, empty diff).
2. **Actor context.** Extend the per-request identity with channel and client id in `authMiddleware`, the Stage 1 route and `loadRequestContext`.
3. **Hook the existing services.** Trips, itineraries, expenses: switch each write to `db.batch` with the audit insert. REST parity tests stay green.
4. **Extract and hook the rest.** Move participants, documents and invites into services with audit calls. Add administration events in `admin.ts`, `auth.ts` and `merge.ts`.
5. **Read endpoints.** `api/src/routes/audit.ts` with the Editor+ check and cursor pagination. OpenAPI updated.
6. **Web.** Activity tab, per-item history, Admin audit log.
7. **Backfill (optional).** No historical events exist. If desired, a one-off script writes a synthetic `create` event per existing row with `actorUserId = null`, `channel = backfill`, and `createdAt` copied from the row, so every item has at least one history entry. This is an operator decision at rollout.

## 10. Acceptance Criteria

1. Updating an itinerary's departure time through the web app produces one `itinerary.update` event with the acting user, `channel = web`, and `changes` containing exactly the departure-time path with correct from and to values.
2. The same update through Claude over MCP Stage 2 produces an identical event except `channel = mcp_oauth` and `clientId` set to the OAuth client id, attributed to the human user.
3. A `PUT` that re-sends every field unchanged produces no event and does not change `updatedAt`.
4. Deleting a trip produces one `trip.delete` event with the full trip snapshot and child counts, and the event remains readable through `/admin/audit` afterwards.
5. Deleting or merging a user leaves their past events intact with `actorName` and `actorEmail` still populated.
6. A Viewer on the trip requesting `/trips/{id}/audit` or the per-item history receives `403`, and the Activity tab and History affordances do not render for them.
7. A non-member requesting `/trips/{id}/audit` receives `404`. A non-admin requesting `/admin/audit` receives `403`.
8. If the audit insert fails, the data write is rolled back and the request fails. Verified with a test that forces the batch to fail.
9. A grep of the API source for `UPDATE`/`DELETE` statements against `audit_events` finds none, and no route exposes such an operation.
10. The Activity tab lists events newest first, paginates with the cursor, and labels MCP-originated events with the client name.
11. No password hash, JWT, OAuth token, client secret, invite token or link token appears in any `audit_events` row, verified by a test that exercises every administration path and scans the table.

## 11. Open Questions

1. **Retention.** Keep forever (v1 assumption) or purge after N years? If purging is wanted, it must be an explicit admin operation, not automatic, to preserve the append-only guarantee for everything else.
2. **Backfill.** Run the synthetic `create` backfill at rollout, or accept that pre-existing rows have no history until first edited?
3. **Trip-level notification.** Should the Activity feed also be the basis for "what's new since I last looked"? That needs a per-user read marker and is out of scope here, but the event `seq` makes it cheap later.

## 12. References

- `specs/PRD.md`, `specs/MCP_PRD.md` sections 4.1 and 6.1 (roles, shared service layer)
- `api/src/services/access.ts` (`requireTripRole`)
- `api/src/mcp/context.ts`, `api/src/mcp/tools/withTool.ts` (MCP identity and the rule that tokens are never logged)
- `api/src/lib/merge.ts` (account merge, which must record a single `user.merge` event)
- Cloudflare D1 `batch()` documentation for atomic multi-statement writes
