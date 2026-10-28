import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import type { Env } from "../db";
import { loadRequestContext } from "./context";
import { registerTripTools } from "./tools/trips";
import { registerItineraryTools } from "./tools/itineraries";
import { registerExpenseTools } from "./tools/expenses";

export interface BuildServerOptions {
  env: Env["Bindings"];
  ctx: ExecutionContext;
  authInfo?: AuthInfo;
}

/** Fresh McpServer per request. Loads the user once, then registers every tool module. */
export async function buildTripsServer({ env, authInfo }: BuildServerOptions): Promise<McpServer> {
  const rc = await loadRequestContext(env, authInfo);
  const server = new McpServer({ name: "trips", version: "1.0.0" });
  registerTripTools(server, rc);
  registerItineraryTools(server, rc);
  registerExpenseTools(server, rc);
  return server;
}
