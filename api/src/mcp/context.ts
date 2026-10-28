import { eq } from "drizzle-orm";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { getDb, type AuthUser, type Env } from "../db";
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
  user: AuthUser;
  scopes: string[];
  log: (event: string, fields: Record<string, unknown>) => void;
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

  const db = getDb(env.DB);
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows.length) throw new Error("MCP user no longer exists");

  return {
    db,
    user: rows[0],
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
