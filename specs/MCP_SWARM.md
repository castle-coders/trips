# MCP Swarm Plan

Orchestration plan for implementing `specs/MCP_TDD.md` with the agents in `.claude/agents/mcp-*.md`. The orchestrator is the main Claude Code session. Subagents do not spawn subagents and do not commit; the orchestrator integrates, runs the gate checks, and commits locally. Nothing is pushed and no PR is opened during the run; the user reviews the gate commits and decides how to ship.

## Agents

| Agent | Role | Invoked with |
|---|---|---|
| `mcp-spike` | Resolve every TDD "verify" and Open Item; install deps; write `specs/MCP_SPIKE_RESULTS.md` | once |
| `mcp-qa` | Test harness, parity baseline, then tests per layer | mode: harness, parity-baseline, services, tools, oauth, acceptance |
| `mcp-service-extractor` | Service layer and thin routes | target: foundation, trips, itineraries, expenses |
| `mcp-tool-builder` | Stage 1 MCP server and tools | target: core, trips-tools, itineraries-tools, expenses-tools |
| `mcp-config` | wrangler, Env type, dev vars, deploy workflow | target: stage1, stage2 |
| `mcp-oauth-builder` | Stage 2 provider, consent, upstream | target: provider, consent, upstream |
| `mcp-grants-builder` | Grant endpoints and web UI | target: api, web |
| `mcp-security-reviewer` | Read-only gate review (runs on Fable) | phase name |
| `mcp-docs-writer` | README, setup, behavior-change notes | phase name |

## Branching

Everything stays local on one branch, `claude/mcp-server`, created from `main` at the start. The orchestrator commits at every gate with a message naming the phase (for example `Phase 1 gate: service extraction`). It never pushes, never opens a PR, and never touches `main`. The gate commits are the review boundaries; the user can split them into PRs afterwards if they want, since they line up with the rollout steps in TDD section 12.

## Phases

Agents listed on one line run in parallel in a single message. Lines run in order. A phase ends at its gate.

### Phase 0: Spike and harness
1. `mcp-spike`
2. Orchestrator reads `specs/MCP_SPIKE_RESULTS.md`. If the ESM or `nodejs_compat` verdict changes the build, apply that change now, before any other agent runs, and confirm `wrangler dev` still serves `GET /trips`.
3. `mcp-qa harness`
4. `mcp-qa parity-baseline`

Gate 0: `npm test` green in `api/`; spike results file exists with no item left as "unresolved" unless it requires a live external client. Commit.

### Phase 1: Service extraction
1. `mcp-service-extractor foundation`
2. `mcp-service-extractor trips` | `mcp-service-extractor itineraries` | `mcp-service-extractor expenses`
3. `mcp-qa services`
4. `mcp-security-reviewer phase-1` | `mcp-docs-writer phase-1` (behavior-change notes only)
5. Fix findings rated high or critical by re-invoking the owning extractor with the finding text. Re-run the reviewer on the fix.

Gate 1: `npm test` green with exactly the two announced behavior changes flipped; OpenAPI document unchanged; `npx tsc --noEmit` clean; reviewer says go. Commit.

### Phase 2: Stage 1 MCP
1. `mcp-config stage1` | `mcp-tool-builder core`
2. `mcp-tool-builder trips-tools` | `mcp-tool-builder itineraries-tools` | `mcp-tool-builder expenses-tools`
3. `mcp-qa tools`
4. `mcp-security-reviewer phase-2` | `mcp-docs-writer phase-2`
5. Fix high or critical findings via the owning builder; re-review.

Gate 2: tests green; `tools/list` returns nine tools under `wrangler dev` with the dev header; a Viewer `get_trip` response contains no `confirmationNumber` or `ticketNumber` (seat assignments are allowed for Viewers by user decision 2026-10-27); reviewer says go. Commit.

### Phase 3: Stage 2 OAuth
1. `mcp-config stage2`
2. `mcp-oauth-builder provider`
3. `mcp-oauth-builder consent` | `mcp-oauth-builder upstream` | `mcp-grants-builder api`
4. `mcp-grants-builder web` | `mcp-qa oauth`
5. `mcp-security-reviewer phase-3` | `mcp-docs-writer phase-3`
6. Fix high or critical findings; re-review.

Gate 3: tests green including the OAuth flow walk; the three local curl checks from the oauth-builder report reproduce; `web` builds and lints; reviewer says go. Write the operator checklist from the `mcp-config` and `mcp-oauth-builder` reports to `specs/MCP_OPERATOR_CHECKLIST.md`. Commit.

### Phase 4: Hardening
1. `mcp-qa acceptance`
2. `mcp-security-reviewer phase-4` (full diff against `main`)
3. Fix every finding rated medium or above via the owning agent.
4. `mcp-docs-writer phase-4` (final README pass, SKILL.md pointer)

Gate 4: acceptance tests green; reviewer go with no medium or higher open; docs verified against code; `specs/MCP_OPERATOR_CHECKLIST.md` is complete. Commit.

## File ownership

Parallel agents in the same phase must touch disjoint files. The orchestrator enforces this by target:

| Owner | Files |
|---|---|
| foundation | `api/src/services/errors.ts`, `api/src/services/access.ts`, `onError` in `api/src/index.ts` |
| trips / itineraries / expenses | `api/src/services/<domain>.ts`, `api/src/routes/<domain>.ts`, `api/test/<domain>*.test.ts` |
| tool-builder core | `api/src/mcp/{context,handler,server,stage1}.ts`, `api/src/mcp/tools/withTool.ts`, tool module stubs, `api/src/middleware/rateLimit.ts` additions, the mount line in `index.ts` |
| tool-builder <domain>-tools | `api/src/mcp/tools/<domain>.ts` |
| config | `api/wrangler.toml`, `api/src/db/index.ts`, `api/.dev.vars.example`, `.github/workflows/deploy-api.yml` |
| oauth provider | `api/src/oauth/provider.ts`, dispatcher in `api/src/index.ts` |
| oauth consent | `api/src/oauth/authorize.ts`, `api/src/oauth/consent-page.ts` |
| oauth upstream | `api/src/oauth/upstream.ts` |
| grants api | `api/src/oauth/grants.ts`, grant routes in `api/src/routes/admin.ts` and `api/src/routes/auth.ts`, `api/scripts/` |
| grants web | `web/src/lib/api.ts`, `web/src/lib/types.ts`, `web/src/pages/Admin.tsx`, `web/src/pages/Account.tsx` |
| qa | `api/vitest.config.ts`, `api/test/**`, `test` script in `api/package.json` |
| docs | `README.md`, `SKILL.md` |
| orchestrator | `specs/MCP_SWARM_LOG.md`, `specs/MCP_OPERATOR_CHECKLIST.md` |

When an agent reports that it needs a change outside its ownership, the orchestrator makes that change itself if it is under ten lines, or re-invokes the owner.

## Orchestrator rules

- Brief every agent with: its target or mode, the phase, which spec sections to read, the paths it owns, and any relevant lines from earlier agent reports (for example the spike's `authInfo` finding for the tool builder, or the config agent's binding names for the oauth builder). Agents start with no memory of this session.
- After every agent returns, run `npm test` and `npx tsc --noEmit` in `api/` yourself. Do not trust a report that omits verbatim output.
- Never let two agents edit the same file concurrently. If a phase line would violate ownership, serialize it.
- Do not skip a gate. If a gate fails, re-invoke the owning agent with the exact failure output. After two failed attempts on the same item, stop and report to the user with the failing output and the options.
- Do not push, open PRs, deploy, create Cloudflare resources, or run `wrangler secret put`. Collect every operator step into `specs/MCP_OPERATOR_CHECKLIST.md`.
- No hard-coded config anywhere: tokens, keys, hostnames and ids come from env vars or placeholders.
- Keep a running `specs/MCP_SWARM_LOG.md` with one line per agent invocation: phase, agent, target, outcome, follow-ups. Commit it with each gate.
