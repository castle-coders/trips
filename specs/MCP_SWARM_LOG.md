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
