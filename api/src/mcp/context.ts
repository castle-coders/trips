import { eq } from "drizzle-orm";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { getDb, type Actor, type Channel, type Env } from "../db";
import { users } from "../db/schema";
import type { Db } from "../services/access";

export type McpScope = "trips:read" | "trips:write";

/** Thrown when the caller's token lacks a scope. withTool turns it into an isError result. */
export class ScopeError extends Error {
  constructor(public scope: string) {
    super(`Missing required scope: ${scope}`);
    this.name = "ScopeError";
  }
}

export interface McpRequestContext {
  db: Db;
  /** Reloaded from D1 once per request, so tools always see the current global role. */
  user: Actor;
  scopes: string[];
  log: (event: string, fields: Record<string, unknown>) => void;
}

const CHANNELS: ReadonlySet<string> = new Set<Channel>(["web", "service_token", "mcp_stage1", "mcp_oauth", "dev"]);

/**
 * Only the two MCP entry points build authInfo.extra, so a missing channel means Stage 2.
 * Kept lenient on purpose: direct-handler tests pass only userId. Reviewer finding phase-1 #1 (low).
 */
function readChannel(value: unknown): Channel {
  if (value === undefined || value === null) return "mcp_oauth";
  if (typeof value === "string" && CHANNELS.has(value)) return value as Channel;
  throw new Error("MCP request has an invalid channel");
}

function readStringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`MCP request has an invalid ${field}`);
}

/**
 * Build the per-request context. Called once by the server factory (buildTripsServer) with the
 * authInfo the caller passed to handler.fetch. Throws if authInfo or the user is missing; the SDK
 * then answers HTTP 500 / JSON-RPC -32603 without leaking the message.
 * authInfo.token is never read or logged.
 */
export async function loadRequestContext(
  env: Env["Bindings"],
  authInfo: AuthInfo | undefined,
): Promise<McpRequestContext> {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) throw new Error("MCP request has no authenticated user");
  const channel = readChannel(authInfo?.extra?.channel);
  const clientId = readStringOrNull(authInfo?.extra?.clientId, "clientId");
  const requestId = readStringOrNull(authInfo?.extra?.requestId, "requestId");

  const db = getDb(env.DB);
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows.length) throw new Error("MCP user no longer exists");

  return {
    db,
    user: { ...rows[0], channel, clientId, requestId },
    scopes: [...(authInfo?.scopes ?? [])],
    log: (event, fields) => {
      const parts = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`);
      console.log(`[mcp] event=${event} ${parts.join(" ")}`);
    },
  };
}

export function requireScope(rc: McpRequestContext, scope: McpScope): void {
  if (!rc.scopes.includes(scope)) throw new ScopeError(scope);
}
