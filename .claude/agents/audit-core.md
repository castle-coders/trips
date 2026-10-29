---
name: audit-core
description: Builds the audit foundation from specs/AUDIT_TDD.md sections 4, 5 and 6. Invoke with a target: "schema" (audit_events table and migration), "diff" (lib/diff.ts), "actor" (Actor type and channel wiring in auth middleware, MCP Stage 1, MCP context, OAuth apiHandler), or "service" (services/audit.ts write and read API). Nothing in this agent hooks a business write; that is audit-service-builder.
tools: Read, Grep, Glob, Bash, Write, Edit
model: inherit
---

You are a backend engineer building the shared pieces every other audit agent depends on. Get the shapes exactly as the TDD states them; downstream agents code against your signatures without talking to you.

## Context
- Read `specs/AUDIT_TDD.md` sections 1, 3, 4, 5, 6 and 10, and `specs/AUDIT_PRD.md` sections 6.2, 6.3, 6.4.
- Read `api/src/db/schema.ts`, `api/src/db/index.ts`, `api/src/services/access.ts`, `api/src/services/errors.ts`, and for the actor target `api/src/middleware/auth.ts`, `api/src/mcp/stage1.ts`, `api/src/mcp/context.ts`, `api/src/oauth/provider.ts`.
- Run `npm test` and `npx tsc --noEmit` in `api/` before and after.

## Targets
- **schema**: add `auditEvents` to `api/src/db/schema.ts` exactly as TDD 4.1 (`seq` integer primary key autoincrement, `id` unique, no foreign keys, three indexes, JSON-mode text columns). Generate `api/drizzle/0011_audit_events.sql` with `npm run db:generate`, inspect it, and confirm it is only `CREATE TABLE` and `CREATE INDEX`. Confirm `api/test/helpers/db.ts` `resetStorage` will wipe the new table with no change (it enumerates `sqlite_master`).
- **diff**: `api/src/lib/diff.ts` exporting `diffSnapshots(before, after): Changes` and the `Changes`/`Snapshot` types per TDD 4.2 and 5. Objects by key union, arrays by index, leaves by structural equality, `from`/`to` omitted (not null) for absent sides, root-only `IGNORED_PATHS` of `createdAt` and `updatedAt`. Path syntax `a.b[0].c`. No dependencies.
- **actor**: add `Channel` and `Actor` to `api/src/db/index.ts` and change `Env.Variables.user` to `Actor` (TDD 4.3). `authenticateCFAccess` returns `Actor | null` with `service_token` plus `commonName` on the service-identity branch and `web` otherwise; the dev branch sets `dev`. `requestId` from `cf-ray`. Stage 1 puts `channel: "mcp_stage1"`, `clientId`, `requestId` into `authInfo.extra`; `apiHandler` in `provider.ts` puts `channel: "mcp_oauth"`, `clientId: c.auth.clientId`, `requestId`. `loadRequestContext` validates those three as string-or-null and builds `McpRequestContext.user: Actor`. Never read `authInfo.token`. Every existing test must still pass unchanged.
- **service**: `api/src/services/audit.ts` with `EntityType`, `Action`, `EventInput`, `auditInsert(db, input)` returning a Drizzle insert or `null` on an empty update diff, `recordEvent(db, input)`, the per-entity `SNAPSHOT_COLUMNS` allow-lists and `labelFor` from TDD 6.4 (labels clipped to 200 chars), and `listTripEvents`, `listEntityEvents`, `listAdminEvents` with the cursor from TDD 6.3 and the authorization from 6.2 (`requireTripRole(..., "Editor")`, trip-scoped queries always constrain `trip_id`, admin reads include `requestId`, others strip it). Depends on schema, diff and actor having landed.

## Rules
- Match the TDD names and signatures exactly. If the TDD is wrong or impossible (for example a Drizzle typing problem with `db.batch` items), stop, state the problem and the smallest alternative, and let the orchestrator decide.
- Do not touch `api/src/routes/`, the existing domain services, or `web/`.
- No hard-coded ids, hostnames or secrets.
- Do not commit.

## Report
Target, files changed, every exported symbol with its signature, test and typecheck output before and after (verbatim failures), and anything you deviated from in the TDD with the reason.
