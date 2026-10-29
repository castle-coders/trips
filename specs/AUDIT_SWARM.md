# Audit Swarm Plan

Orchestration plan for implementing `specs/AUDIT_TDD.md` with the agents in `.claude/agents/audit-*.md`. The orchestrator is the main Claude Code session. Subagents do not spawn subagents and do not commit; the orchestrator integrates, runs the gate checks, and commits locally. Nothing is pushed and no PR is opened during the run; the user reviews the gate commits and decides how to ship.

Status: complete 2026-10-29 on branch `claude/audit-history`, four gate commits. Log in `specs/AUDIT_SWARM_LOG.md`.

## Agents

| Agent | Role | Invoked with |
|---|---|---|
| `audit-core` | Table and migration, diff library, Actor and channel wiring, audit service | target: schema, diff, actor, service |
| `audit-service-builder` | One audit event per write, in the same batch; service extraction where routes still write directly | target: trips, itineraries, expenses, participants, documents, invites, users, oauth |
| `audit-api-builder` | The three read endpoints and their schemas | once |
| `audit-web-builder` | Activity tab, per-item history, Admin audit log | target: client, trip, admin |
| `audit-qa` | Tests per TDD section 11 and the append-only CI check | mode: diff, core, services, atomicity, secrets, mcp, routes, append-only, acceptance |
| `audit-security-reviewer` | Read-only gate review (runs on Fable, high effort) | phase name |
| `audit-docs-writer` | README section, rollout notes, backfill procedure | phase name |

The MCP agents (`mcp-*`) are not used. Their context is MCP-specific and the audit work does not change MCP tool behavior beyond attribution.

## Branching

Everything stays local on one branch, `claude/audit-history`, created from `main` at the start. The orchestrator commits at every gate with a message naming the phase (for example `Phase 1 gate: audit write hooks`). It never pushes, never opens a PR, and never touches `main`. Gate commits line up with the rollout steps in TDD section 12 so they can become PRs later.

## Phases

Agents listed on one line run in parallel in a single message. Lines run in order. A phase ends at its gate.

### Phase 0: Foundation
1. `audit-core schema` | `audit-core diff` | `audit-core actor`
2. Orchestrator: `npm test` and `npx tsc --noEmit` in `api/`. The actor change widens `Env.Variables.user`; every existing test must pass unchanged before anything else runs.
3. `audit-core service`
4. `audit-qa diff` | `audit-qa core`

Gate 0: tests green; migration `0011_audit_events.sql` contains only `CREATE TABLE` and `CREATE INDEX`; `auditInsert`, `recordEvent`, `diffSnapshots` and the three list functions exist with the TDD signatures; the five diff examples from TDD 5 pass verbatim. Commit.

### Phase 1: Write hooks
1. `audit-service-builder trips` | `audit-service-builder itineraries` | `audit-service-builder expenses` | `audit-service-builder participants` | `audit-service-builder documents`
2. `audit-service-builder invites`
3. `audit-service-builder users`
4. `audit-service-builder oauth`
5. `audit-qa services` | `audit-qa atomicity` | `audit-qa secrets` | `audit-qa mcp`
6. `audit-security-reviewer phase-1`
7. Fix findings rated high or critical by re-invoking the owning builder with the finding text. Re-run the reviewer on the fix.

Lines 2, 3 and 4 are serialized because all three touch `api/src/routes/auth.ts` and `api/src/routes/admin.ts`.

Gate 1: tests green with exactly the one announced behavior change (no-op `PUT` no longer bumps `updatedAt`); OpenAPI document unchanged; every write route and service function is named in the reviewer's event inventory with exactly one event; the atomicity and secrets tests pass; `git grep -n "recordEvent(" api/src` shows only the four KV-backed OAuth call sites (admin grant revoke, self grant revoke, client create, client delete); reviewer says go. Commit.

### Phase 2: Read API
1. `audit-api-builder`
2. `audit-qa routes`
3. `audit-security-reviewer phase-2`
4. Fix high or critical findings; re-review.

Gate 2: tests green; OpenAPI diff shows only the three new paths; under `wrangler dev` with the dev header, an Editor gets `200` from `/api/trips/{id}/audit` and a Viewer on the same trip gets `403`; reviewer says go. Commit.

### Phase 3: Web
1. `audit-web-builder client`
2. `audit-web-builder trip` | `audit-web-builder admin`
3. `audit-security-reviewer phase-3` (web checklist items only)
4. Fix high or critical findings; re-review.

Gate 3: `npm run build` and `npm run lint` clean in `web/`; with both dev servers running, an Editor sees the Activity tab and a Viewer does not; an itinerary edit made in the UI appears at the top of the feed with the correct field sentence; reviewer says go. Commit.

### Phase 4: Hardening
1. `audit-qa acceptance` | `audit-qa append-only`
2. `audit-security-reviewer phase-4` (full diff against `main`)
3. Fix every finding rated medium or above via the owning agent.
4. `audit-docs-writer phase-4`

Gate 4: acceptance tests cover every item of PRD section 10 or name why one cannot be automated; append-only script wired into CI and passing; reviewer go with no medium or higher open; docs verified against code. Commit.

## File ownership

Parallel agents in the same phase must touch disjoint files. The orchestrator enforces this by target:

| Owner | Files |
|---|---|
| core schema | `api/src/db/schema.ts`, `api/drizzle/0011_audit_events.sql`, `api/drizzle/meta/` |
| core diff | `api/src/lib/diff.ts` |
| core actor | `api/src/db/index.ts`, `api/src/middleware/auth.ts`, `api/src/mcp/stage1.ts`, `api/src/mcp/context.ts`, the `apiHandler` block in `api/src/oauth/provider.ts` |
| core service | `api/src/services/audit.ts` |
| service-builder trips / itineraries / expenses | `api/src/services/<domain>.ts`, `api/test/services.<domain>.test.ts` |
| service-builder participants / documents | `api/src/services/<domain>.ts`, `api/src/routes/<domain>.ts`, `api/test/services.<domain>.test.ts` |
| service-builder invites | `api/src/services/invites.ts`, `api/src/routes/invites.ts`, the accept handler in `api/src/routes/auth.ts` |
| service-builder users | `api/src/services/users.ts`, `api/src/lib/merge.ts`, user and email handlers in `api/src/routes/admin.ts` and `api/src/routes/auth.ts` |
| service-builder oauth | revoke and client handlers in `api/src/routes/admin.ts` and `api/src/routes/auth.ts` |
| api-builder | `api/src/routes/audit.ts`, `api/src/schemas/audit.ts`, `GET /admin/audit` in `api/src/routes/admin.ts`, the mount line in `api/src/index.ts` |
| web client | `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/auditText.ts`, `web/src/components/ActivityFeed.tsx`, `web/src/components/HistoryModal.tsx` |
| web trip | `web/src/pages/TripDetail.tsx` |
| web admin | `web/src/pages/Admin.tsx` |
| qa | `api/test/**` except the per-domain service tests above while a builder holds them, `api/scripts/check-audit-append-only.sh`, the CI workflow step |
| docs | `README.md`, `SKILL.md` |
| orchestrator | `specs/AUDIT_SWARM_LOG.md` |

When an agent reports that it needs a change outside its ownership, the orchestrator makes that change itself if it is under ten lines, or re-invokes the owner.

## Decisions already made (do not reopen)

- Viewers never see history. Editor and above on the trip, or admin. (user, 2026-10-28)
- No MCP tool for reading history. MCP writes are still recorded with channel and client id. (user, 2026-10-28)
- `seq` is the primary key; `id` is unique. (TDD 4.1)
- OAuth grant and client events are recorded after the KV write and are not atomic. (TDD 7.4)
- Backfill is not run by the swarm. The docs writer documents the script only if the user asks for it to be written. (PRD open question)
- Retention is indefinite. No purge code is written. (PRD open question)

## Orchestrator rules

- Brief every agent with: its target or mode, the phase, which spec sections to read, the paths it owns, and any relevant lines from earlier agent reports (for example `audit-core service`'s exported signatures for every builder, or the invites builder's note on where the accept handler now calls the service for the users builder). Agents start with no memory of this session.
- After every agent returns, run `npm test` and `npx tsc --noEmit` in `api/` yourself, and `npm run build` in `web/` for web targets. Do not trust a report that omits verbatim output.
- Never let two agents edit the same file concurrently. If a phase line would violate ownership, serialize it.
- Do not skip a gate. If a gate fails, re-invoke the owning agent with the exact failure output. After two failed attempts on the same item, stop and report to the user with the failing output and the options.
- Do not push, open PRs, deploy, apply migrations to a remote D1, or run the backfill.
- No hard-coded config anywhere: ids, hostnames and secrets come from env vars or placeholders.
- Keep a running `specs/AUDIT_SWARM_LOG.md` with one line per agent invocation: phase, agent, target, outcome, follow-ups. Commit it with each gate.
