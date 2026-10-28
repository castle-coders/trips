import { McpServer, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../db";
import { loadRequestContext, type McpRequestContext } from "./context";
import { registerTripTools } from "./tools/trips";
import { registerItineraryTools } from "./tools/itineraries";
import { registerExpenseTools } from "./tools/expenses";

type AnyCb = (...a: any[]) => Promise<CallToolResult> | CallToolResult;

/**
 * Wrap a registered callback: on a success result carrying structuredContent, validate it against the
 * tool's outputSchema ourselves. On mismatch log only the issue paths (never values) and return the
 * fixed "Internal error", so the SDK's "Output validation error" text (schema paths) never reaches clients.
 */
function guardOutput(rc: McpRequestContext, name: string, schema: any, cb: AnyCb): AnyCb {
  return async (...a: any[]) => {
    const result = await cb(...a);
    if (!schema || result.isError || result.structuredContent === undefined) return result;
    const std = schema["~standard"];
    if (!std?.validate) return result;
    let issues: ReadonlyArray<{ path?: ReadonlyArray<unknown> }> | undefined;
    try {
      const r = await std.validate(result.structuredContent);
      issues = r.issues;
    } catch {
      issues = [{ path: ["<validator>"] }];
    }
    if (!issues?.length) return result;
    const tripId = (a[0] as { tripId?: unknown } | undefined)?.tripId;
    const trip = typeof tripId === "string" && tripId ? tripId : "-";
    const paths = [
      ...new Set(
        issues.map((i) =>
          (i.path ?? []).map((p) => String(typeof p === "object" && p && "key" in p ? (p as { key: unknown }).key : p)).join(".") || "<root>",
        ),
      ),
    ]
      .slice(0, 10)
      .join(",")
      .replace(/[^\w.,<>\[\]-]/g, "?");
    console.error(
      `[mcp] tool=${name} user=${rc.user.id} trip=${trip} scopes=${rc.scopes.join(",")} ok=false err=output paths=${paths}`,
    );
    return { isError: true, content: [{ type: "text", text: "Internal error" }] };
  };
}

/** Thin view of the McpServer handed to tool modules; same type, registerTool callbacks are guarded. */
function guardedServer(server: McpServer, rc: McpRequestContext): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, config: { outputSchema?: unknown }, cb: AnyCb) =>
          (target.registerTool as any).call(target, name, config, guardOutput(rc, name, config?.outputSchema, cb));
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export interface BuildServerOptions {
  env: Env["Bindings"];
  ctx: ExecutionContext;
  authInfo?: AuthInfo;
}

/** Fresh McpServer per request. Loads the user once, then registers every tool module. */
export async function buildTripsServer({ env, authInfo }: BuildServerOptions): Promise<McpServer> {
  const rc = await loadRequestContext(env, authInfo);
  const server = new McpServer({ name: "trips", version: "1.0.0" });
  const guarded = guardedServer(server, rc);
  registerTripTools(guarded, rc);
  registerItineraryTools(guarded, rc);
  registerExpenseTools(guarded, rc);
  return server;
}
