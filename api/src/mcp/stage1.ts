import { Hono } from "hono";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Env } from "../db";
import { authMiddleware } from "../middleware/auth";
import { mcpRateLimit } from "../middleware/rateLimit";
import { createTripsMcpHandler } from "./handler";

/** Main-hostname MCP route (Cloudflare Access). Mounted at "/" so the path is /mcp (/api/mcp externally). */
const stage1 = new Hono<Env>();

stage1.all("/mcp", authMiddleware, mcpRateLimit, async (c) => {
  const user = c.get("user");
  const authInfo: AuthInfo = {
    token: "", // not an OAuth token; never logged
    clientId: "cf-access",
    scopes: ["trips:read", "trips:write"],
    extra: {
      userId: user.id,
      channel: "mcp_stage1",
      clientId: user.clientId,
      requestId: c.req.header("cf-ray") ?? null,
    },
  };
  return createTripsMcpHandler(c.env, c.executionCtx).fetch(c.req.raw, { authInfo });
});

export default stage1;
