// MCP test helpers: POST JSON-RPC to the Trips MCP handler and parse the (SSE or JSON) reply.
// Two transports:
//  - mcpDirect(authInfo): createTripsMcpHandler(env, ctx).fetch(request, { authInfo }), so tests
//    control scopes and clientId exactly (Stage 2 shape).
//  - mcpStage1(email):    the real Worker at /api/mcp through authMiddleware + DEV_MODE header
//    (Stage 1: fixed cf-access authInfo with both scopes).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createTripsMcpHandler } from "../../src/mcp/handler";
import { TEST_ORIGIN } from "./http";

export const ALL_SCOPES = ["trips:read", "trips:write"];
export const READ_TOOLS = ["get_me", "list_trips", "get_trip", "search_itineraries", "list_expenses"] as const;
export const WRITE_TOOLS = ["create_trip", "create_itinerary", "update_itinerary", "add_expense"] as const;
export const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

/** AuthInfo as Stage 2's apiHandler builds it. token stays empty on purpose (never logged). */
export function authFor(userId: string, scopes: string[] = ALL_SCOPES, clientId = "test-client"): AuthInfo {
  return { token: "", clientId, scopes, extra: { userId } };
}

export interface RpcReply {
  status: number;
  contentType: string;
  /** Raw body text (SSE frames or JSON). */
  raw: string;
  /** Parsed JSON-RPC message (the last `data:` frame for SSE), or null if the body was empty/unparseable. */
  message: any;
}

let nextId = 1;

export function rpcBody(method: string, params?: unknown) {
  return { jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) };
}

const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

/** Parse a handler response: SSE `data:` frames (last one wins) or a plain JSON body. */
export async function parseRpc(res: Response): Promise<RpcReply> {
  const raw = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let message: any = null;
  if (contentType.includes("text/event-stream")) {
    const frames = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (frames.length) message = JSON.parse(frames[frames.length - 1]);
  } else if (raw) {
    try {
      message = JSON.parse(raw);
    } catch {
      message = null;
    }
  }
  return { status: res.status, contentType, raw, message };
}

export interface McpClient {
  rpc(method: string, params?: unknown): Promise<RpcReply>;
  listTools(): Promise<any[]>;
  /** tools/call; returns the CallToolResult (asserts a JSON-RPC result, not a JSON-RPC error). */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  isError: boolean;
  text: string;
  structured: any;
  /** Full CallToolResult as received. */
  result: any;
  reply: RpcReply;
}

function makeClient(send: (body: unknown) => Promise<Response>): McpClient {
  const rpc = async (method: string, params?: unknown) => parseRpc(await send(rpcBody(method, params)));
  return {
    rpc,
    async listTools() {
      const r = await rpc("tools/list", {});
      expect(r.status, r.raw).toBe(200);
      expect(r.message?.error, r.raw).toBeUndefined();
      return r.message.result.tools;
    },
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      expect(r.status, r.raw).toBe(200);
      expect(r.message?.error, r.raw).toBeUndefined();
      const result = r.message.result;
      const text = (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      return { isError: result.isError === true, text, structured: result.structuredContent, result, reply: r };
    },
  };
}

/** Call createTripsMcpHandler(env, ctx).fetch(request, { authInfo }) directly. */
export function mcpDirect(authInfo: AuthInfo | undefined): McpClient {
  return makeClient(async (body) => {
    const ctx = createExecutionContext();
    const req = new Request(`${TEST_ORIGIN}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
    const res = await createTripsMcpHandler(env as never, ctx).fetch(req, authInfo ? { authInfo } : {});
    await waitOnExecutionContext(ctx);
    return res;
  });
}

/** POST to the real Worker at /api/mcp (Stage 1). email=null sends no auth header. */
export function mcpStage1(email: string | null, extraHeaders: Record<string, string> = {}): McpClient {
  return makeClient((body) => {
    const headers = new Headers({ ...MCP_HEADERS, ...extraHeaders });
    if (email) headers.set("X-Dev-User-Email", email);
    return exports.default.fetch(new Request(`${TEST_ORIGIN}/api/mcp`, { method: "POST", headers, body: JSON.stringify(body) }));
  });
}

/** Every key name and every string value anywhere in a JSON value. */
export function keysAndStrings(value: unknown, keys = new Set<string>(), strings = new Set<string>()) {
  if (typeof value === "string") strings.add(value);
  else if (Array.isArray(value)) value.forEach((v) => keysAndStrings(v, keys, strings));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      keysAndStrings(v, keys, strings);
    }
  }
  return { keys, strings };
}

/** Assert a tool result (structured + text + raw wire body) carries no hidden Viewer fields. */
export function expectNoHiddenFields(r: ToolResult, hiddenValues: string[]) {
  const fromText = r.text ? safeParse(r.text) : null;
  for (const v of [r.structured, fromText]) {
    const { keys, strings } = keysAndStrings(v);
    expect([...keys]).not.toContain("confirmationNumber");
    expect([...keys]).not.toContain("ticketNumber");
    for (const h of hiddenValues) expect([...strings]).not.toContain(h);
  }
  expect(r.reply.raw).not.toMatch(/confirmationNumber|ticketNumber/);
  for (const h of hiddenValues) expect(r.reply.raw).not.toContain(h);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Text that must never appear in an error result: stacks, SQL, internal paths, zod issue dumps. */
export const LEAK_RE = /\bat \S+:\d+|\.ts:\d+|\.js:\d+|stack|SQLITE|D1_|select |insert |update .* set |from "|node_modules|ZodError|"code":\s*"invalid/i;

// --- shared MCP world ---------------------------------------------------------------------------

import { IDS, seedRoleWorld, type Actor, type RoleWorld } from "./parity";
import { IT, seedItineraries } from "./itineraryFixtures";
import { seedExpense } from "./seed";

/** Every sensitive value seeded by seedItineraries(); none may reach a Viewer. */
export const HIDDEN_VALUES = [
  "CONF-FAKE-ACT",
  "CONF-FAKE-FLT",
  "CONF-FAKE-OLD",
  "CONF-FAKE-RAIL",
  "TKT-FAKE-0001",
  "TKT-FAKE-OLD1",
  "TKT-FAKE-RAIL",
];

export const EXP = {
  paid: "00000000-0000-4000-8000-00000000f001",
  noPayer: "00000000-0000-4000-8000-00000000f002",
  other: "00000000-0000-4000-8000-00000000f003",
} as const;

export interface McpWorld extends RoleWorld {
  /** Direct-handler clients with both scopes, keyed by actor. */
  mcp: Record<Actor, McpClient>;
}

/** seedRoleWorld() + one itinerary of each fixture shape + expenses (with and without payer). */
export async function seedMcpWorld(): Promise<McpWorld> {
  const w = await seedRoleWorld();
  await seedItineraries(w);
  await seedExpense(IDS.trip, { id: EXP.paid, description: "Dinner", amount: 80, payerId: IDS.editorP });
  await seedExpense(IDS.trip, { id: EXP.noPayer, description: "Taxi", amount: 12.5, category: "Transport", payerId: null });
  await seedExpense(IDS.otherTrip, { id: EXP.other, description: "Elsewhere lunch", payerId: IDS.outsiderP });
  const mcp = Object.fromEntries(
    (Object.keys(w.users) as Actor[]).map((a) => [a, mcpDirect(authFor(w.users[a].id))]),
  ) as Record<Actor, McpClient>;
  return { ...w, mcp };
}

export { IT, IDS };

/** Valid arguments for every tool against the McpWorld trip. */
export function validArgs(): Record<(typeof ALL_TOOLS)[number], Record<string, unknown>> {
  return {
    get_me: {},
    list_trips: {},
    get_trip: { tripId: IDS.trip },
    search_itineraries: { tripId: IDS.trip },
    list_expenses: { tripId: IDS.trip },
    create_trip: { name: "Scope Probe Trip" },
    create_itinerary: {
      tripId: IDS.trip,
      type: "Activity",
      content: { name: "Probe activity", startTime: "2090-03-04T10:00" },
      confirmationNumber: "CONF-FAKE-NEW",
    },
    update_itinerary: { tripId: IDS.trip, itineraryId: IT.activity, status: "Cancelled", notes: "changed" },
    add_expense: { tripId: IDS.trip, description: "Probe expense", amount: 5, currency: "USD", category: "Other", splitType: "EQUAL" },
  };
}
