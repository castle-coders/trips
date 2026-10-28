import type { CallToolResult } from "@modelcontextprotocol/server";
import { ServiceError } from "../../services/errors";
import { requireScope, ScopeError, type McpRequestContext, type McpScope } from "../context";

/**
 * Wrap a tool body. Order: scope check first, then `fn` (which calls a service).
 *  - ServiceError / ScopeError: returned as { isError: true, content: [message] } (message is safe).
 *  - Anything else (D1 errors, viewer projection failures, bugs): logged server-side, returned as
 *    the fixed text "Internal error". The SDK would otherwise send error.message to the client.
 * Emits `[mcp] tool=<name> user=<id> trip=<id|-> scopes=<a,b> ok=<bool> err=<code|-> ms=<n>`.
 * The trip id is taken from args.tripId when present. authInfo.token is never touched.
 */
export function withTool<A>(
  rc: McpRequestContext,
  name: string,
  scope: McpScope,
  fn: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    const start = Date.now();
    const tripId = (args as { tripId?: unknown } | undefined)?.tripId;
    const trip = typeof tripId === "string" && tripId ? tripId : "-";
    const line = (ok: boolean, err: string) =>
      console.log(
        `[mcp] tool=${name} user=${rc.user.id} trip=${trip} scopes=${rc.scopes.join(",")} ok=${ok} err=${err} ms=${Date.now() - start}`,
      );
    try {
      requireScope(rc, scope);
      const result = await fn(args);
      line(true, "-");
      return result;
    } catch (e) {
      if (e instanceof ScopeError) {
        line(false, "scope");
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
      if (e instanceof ServiceError) {
        line(false, e.code);
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
      line(false, "internal");
      console.error(`[mcp] tool=${name} internal error: ${e instanceof Error ? e.name + ": " + e.message : "unknown"}`);
      return { isError: true, content: [{ type: "text", text: "Internal error" }] };
    }
  };
}

/** Helper: build a success result with both text content and structuredContent. */
export function ok<T extends Record<string, unknown>>(structured: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}
