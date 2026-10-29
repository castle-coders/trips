import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Env } from "../db";
import { buildTripsServer } from "./server";

/** Stateless handler: the factory runs once per request. Callers pass authInfo to .fetch(). */
export function createTripsMcpHandler(env: Env["Bindings"], ctx: ExecutionContext) {
  return createMcpHandler((reqCtx) => buildTripsServer({ env, ctx, authInfo: reqCtx.authInfo }));
}
