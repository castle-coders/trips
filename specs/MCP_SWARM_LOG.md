# MCP Swarm Log

One line per agent invocation: phase | agent | target | outcome | follow-ups.

## Setup
- setup | orchestrator | branch | Created `claude/mcp-server` from `main` (4044d40); committed specs, agents, .gitignore, security_review.md as a26246e | Baseline `npx tsc --noEmit` on main fails with 2 pre-existing errors: `src/routes/documents.ts(32,3)` and `src/routes/expenses.ts(32,3)` (TS2345, 404 response not declared in route). No `npm test` script exists yet.

## Phase 0
- 0.1 | mcp-spike | once | All TDD verify items resolved; 23 in-place TDD amendments; deps: @modelcontextprotocol/server 2.4.0, client 2.4.0, workers-oauth-provider 1.2.4, vitest 4.1.12, vitest-pool-workers 0.23.0; `npm test` 3/3 | Keep commonjs, no nodejs_compat. Open: refreshTokenIdleTTL decision (TDD 13), real-client loopback host/path stability, pool package deprecated.
- 0.2 | orchestrator | spike review | No build change required; spike confirmed `/api/trips` still served (401 unauth). Verified npm test 3/3, tsc at baseline (2 errors).
- 0.3 | mcp-qa | harness | vitest.config.mts + test/setup.ts (migrations per file, per-test D1+KV wipe), helpers (seedUser/seedTrip/addParticipant/seedItinerary/seedExpense/asUser), test/tsconfig.json; 9/9 green incl. shuffled | Test typecheck: `npx tsc --noEmit -p test/tsconfig.json`. Pool deprecation notice kept (not migrated).
- 0.4 | mcp-qa | parity-baseline | Per-domain parity tests (trips, itineraries, expenses), behavior-change files with CURRENT BEHAVIOR tests + 13 it.todo, OpenAPI file snapshot; 158 passed / 13 todo, shuffled green | Surprises reported: Viewer projection keeps seatAssignments (FlightLegView, Rail, Transport) contrary to PRD 6.1; viewer projection can 500 on content not matching view schema; listExpenses payer-name join would change REST body; admin missing-trip lists return 200 [].
- GATE 0 | orchestrator | gate | PASS: npm test 158 passed / 13 todo; tsc at baseline (2); spike results present, only live-client items unresolved.

## Decisions (user, 2026-10-27, after Gate 0)
- Viewer seat assignments: allowed for Viewers on REST and MCP (existing view schemas unchanged). Amended PRD 4.1/6.1/11, SWARM Gate 2, mcp-qa tools mode.
- Refresh lifetime: `refreshTokenIdleTTL` 30d, `refreshTokenTTL` 30d, no absolute cap. Amended TDD 7.1 and 13.
- Orchestrator calls (no TDD change): admins keep today's 200 `[]` for itinerary/expense lists of a missing trip (requireTripRole does not add an existence check for admins); `listExpenses` may expose `payerName` for MCP but the REST body must stay byte-identical to the parity snapshots.

## Phase 1
- 1.1 | mcp-service-extractor | foundation | services/errors.ts, services/access.ts (requireTripRole, getMembership, hasRole, isAdmin, ROLE_RANK), app.onError in index.ts; 163 passed / 13 todo | Unknown stored participant role treated as Viewer (least privilege) — accepted.
- 1.2c | mcp-service-extractor | expenses | services/expenses.ts (list w/ payerName, create, update, delete); thin route; REST strips payerName; expenses+openapi 36/36; expenses.ts tsc error gone | None.
- 1.2a | mcp-service-extractor | trips | services/trips.ts (listTrips, listUpcomingTrips, getTrip, createTrip w/ Owner row in db.batch, updateTrip, deleteTrip); thin route; behavior-change flipped (6 current-behavior tests removed, 8 todos → passing, +2) | Unknown stored role → Viewer on PUT (bad data only).
- 1.2b | mcp-service-extractor | itineraries | services/itineraries.ts (list/get/create/update/delete, searchItineraries w/ per-row projection + viewer re-check of text match, groupItinerariesByLocalDate), thin route, behavior-change flipped, +21 service tests | Full suite 187/187.
- 1.2x | orchestrator | documents.ts | Pre-existing TS2345 at routes/documents.ts:32 fixed by throwing ServiceError("not_found","Trip not found") instead of an undeclared c.json 404 (same body; route defs untouched). `npx tsc --noEmit` now clean (0 errors).
- 1.3 | mcp-qa | services | +79 service tests (services.access/trips/expenses/itineraries) + helpers/services.ts; 266 passed, shuffled green; no bugs found | Admin missing-trip: get/update/delete/create → not_found, list/search → [] (encoded as-is).
- 1.4b | mcp-docs-writer | phase-1 | README `### Behavior changes` under `## API` (non-member itinerary 404s; creator Owner row) | None.
- 1.4a | mcp-security-reviewer | phase-1 | GO. 0 critical/high. M1: listExpenses payer join not scoped to trip (expenses.ts:25) → cross-trip payerName. L1: one unprojectable Viewer row fails whole searchItineraries (itineraries.ts:452) | Fixing both now via owners (cheap, pre-Phase 2).
- 1.5a | mcp-service-extractor | expenses fix | M1 fixed: payer join scoped to expense's trip; test inverted | Suite green.
- 1.5b | mcp-service-extractor | itineraries fix | L1 fixed: searchItineraries skips unprojectable Viewer rows (fail closed, id-only log); +1 test | 267 passed.
- 1.5c | mcp-security-reviewer | phase-1 re-review | GO. M1 and L1 fixed with discriminating tests. Info: untyped catch in search loop (non-blocking).
- GATE 1 | orchestrator | gate | PASS: npm test 267/267 (0 todo); exactly the two announced behavior changes flipped (trips.behavior-change, itineraries.behavior-change); all parity snapshots + openapi.json byte-identical to Gate 0; tsc clean; reviewer GO.

## Phase 2
- 2.1a | mcp-config | stage1 | MCP_RATE_LIMITER (1002, 120/60s) in wrangler.toml; `RateLimiter` + optional EVAL/MCP limiters in Env Bindings; .dev.vars.example rewritten (names only); deploy workflow unchanged; dry-run OK | `.dev.vars` tracked & not ignored; `.dev.vars.local` not auto-loaded by wrangler dev (TDD 8.5 wording) → checklist.
- 2.1b | mcp-tool-builder | core | mcp/{context,handler,server,stage1}.ts, tools/withTool.ts (scope check, catch-all → "Internal error", [mcp] log line), stubs registerXTools(server, rc), mcpRateLimit, `app.route("/", mcpStage1)`; placeholder get_me; wrangler dev initialize/tools/list/tools/call OK | Deviation: loadRequestContext in factory instead of requestContext(ctx); TDD 6.3 amended.
- 2.2c | mcp-tool-builder | expenses-tools | list_expenses, add_expense registered; tsc clean; 267 passed | Input schema hand-written (violates PRD 6.1 derivation) → re-invoked to derive from CreateExpenseSchema.
- 2.2a | mcp-tool-builder | trips-tools | get_me, list_trips, get_trip (trip, role, participants, itineraries once, days[] by local date), create_trip; input from CreateTripSchema.shape; tsc clean; 267 passed | Handlers not executed yet (QA tools mode + orchestrator e2e).
- 2.2b | mcp-tool-builder | itineraries-tools | search_itineraries (limit/truncated), create_itinerary, update_itinerary; content description generated from contentSchemaByType; tsc clean; 267 passed | Inputs hand-written, update accepts null to clear → re-invoked to derive from Create/UpdateItinerarySchema and match REST nullability.
- 2.2c' | mcp-tool-builder | expenses-tools fix | add_expense input and outputs now derived from CreateExpenseSchema/ExpenseSchema shape + .describe(); constraints verified in JSON schema; 267 passed | None.
- 2.2b' | mcp-tool-builder | itineraries-tools fix | create/update inputs derived from Create/UpdateItinerarySchema shape; nullability matches REST exactly; 267 passed | None.
- 2.2e2e | orchestrator | wrangler dev | tools/list = 9 tools with annotations (dev header); Viewer get_trip: no confirmationNumber/ticketNumber (values absent), seatAssignments present (allowed); Viewer search for hidden ticket → 0; Viewer add_expense → "Forbidden". Local D1 only, fake example.test users.
- 2.3 | mcp-qa | tools | +90 tests in 7 mcp.*.test.ts files + helpers/mcp.ts (tools/list, scopes, roles, get_trip grouping, outputSchema conformance, error hygiene sweep, stage1 401s, per-user rate limit 121st→429); 357 passed, shuffled green | Observations: SDK output-validation error text could echo values if a schema ever drifts; deleted user → 500/-32603 (TDD-accepted).
- 2.4b | mcp-docs-writer | phase-2 | README `## MCP server` (tools table, roles/projection, rate limit, audit log, Stage 1 connection, local dev + Inspector), Access config paragraph, Bindings table | Flagged checklist step 5 (cfAccessSubject must be common_name) — verified at auth.ts:81 and fixed by orchestrator.
- 2.4a | mcp-security-reviewer | phase-2 | GO. 0 critical/high/medium. L-F1 search loads all rows before limit (add service hard cap + text max len); L-F2 SDK output-validation error bypasses withTool (validate structuredContent in withTool); L-F3 internal-error log includes raw e.message; Info-F4 getTripRole Viewer default still used by participants/invites REST (pre-existing) | F1–F3 carried to Phase 4 hardening.
- GATE 2 | orchestrator | gate | PASS: npm test 357/357; tsc clean; tools/list = 9 tools under wrangler dev with dev header; Viewer get_trip has no confirmationNumber/ticketNumber (seatAssignments allowed per user decision); reviewer GO.
