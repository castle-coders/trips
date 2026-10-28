import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { authMiddleware } from "./middleware/auth";
import { requireAdmin } from "./middleware/admin";
import { requireTripEditor } from "./middleware/tripRole";
import { evalRateLimit } from "./middleware/rateLimit";
import type { Env } from "./db";
import authRoutes from "./routes/auth";
import adminRoutes from "./routes/admin";
import tripRoutes from "./routes/trips";
import participantRoutes from "./routes/participants";
import expenseRoutes from "./routes/expenses";
import documentRoutes from "./routes/documents";
import itineraryRoutes from "./routes/itineraries";
import inviteRoutes from "./routes/invites";
import evalRoutes from "./routes/eval";
import mcpStage1 from "./mcp/stage1";
import { cors } from "hono/cors";
import { ServiceError, SERVICE_ERROR_STATUS, serviceErrorBody } from "./services/errors";
import { getOAuthProvider, OAUTH_RATE_LIMITED_PATHS } from "./oauth/provider";

const app = new OpenAPIHono<Env>();

// Map service-layer errors to HTTP. Anything else keeps Hono's default handler behavior
// (HTTPException -> its response; otherwise log and 500 "Internal Server Error").
app.onError((err, c) => {
  if (err instanceof ServiceError) {
    return c.json(serviceErrorBody(err), SERVICE_ERROR_STATUS[err.code]);
  }
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
});

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://trips.prenticew.com",
];

app.use("*", cors({
  origin: (origin) => {
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    if (origin.endsWith(".trips-web-cm1.pages.dev")) return origin;
    return null;
  },
  allowHeaders: ["Content-Type", "Authorization", "CF-Access-Jwt-Assertion", "X-Dev-User-Email"],
  allowMethods: ["POST", "GET", "OPTIONS", "PUT", "DELETE"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: true,
}));

// Public routes (no auth required)
app.route("/auth", authRoutes);
app.use("/eval/*", evalRateLimit);
app.route("/eval", evalRoutes);
// OpenAPI spec + docs (public)
app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Trips API",
    version: "1.0.0",
    description: "Travel itinerary management API for Openclaw",
  },
});
app.get(
  "/docs",
  apiReference({
    url: "/openapi.json",
  })
);

// Authenticated routes
app.use("/trips/*", authMiddleware);
app.use("/admin/*", authMiddleware);

// Block viewers from write operations on trip resources
app.use("/trips/*", requireTripEditor);

// Admin-only routes
app.use("/admin/*", requireAdmin);

// Mount routes
app.route("/trips", tripRoutes);
app.route("/trips/:tripId/participants", participantRoutes);
app.route("/trips/:tripId/expenses", expenseRoutes);
app.route("/trips/:tripId/documents", documentRoutes);
app.route("/trips/:tripId/itineraries", itineraryRoutes);
app.route("/trips/:tripId/invites", inviteRoutes);
app.route("/admin", adminRoutes);
// MCP (Cloudflare Access); the route itself applies authMiddleware, so /api/mcp is never unauthenticated
app.route("/", mcpStage1);

/** Query parameters that look like credentials. Tokens are accepted only in the Authorization header. */
const QUERY_CREDENTIAL_PARAMS: ReadonlySet<string> = new Set(["token", "access_token", "apikey"]);

function hasQueryCredential(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (QUERY_CREDENTIAL_PARAMS.has(name.toLowerCase())) return true;
  }
  return false;
}

/** Stage 2: everything on the MCP hostname goes through the OAuth provider (TDD 5). No CORS here. */
async function handleMcpHost(request: Request, url: URL, env: Env["Bindings"], ctx: ExecutionContext): Promise<Response> {
  // Before the provider: otherwise a query-only token gets the library's 401 first (spike 8).
  if (hasQueryCredential(url)) {
    return Response.json(
      { error: "invalid_request", error_description: "Credentials must be sent in the Authorization header, not the URL" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  // Per-IP limit on the OAuth endpoints; the library serves token and registration itself.
  if (OAUTH_RATE_LIMITED_PATHS.has(url.pathname) && env.OAUTH_RATE_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.OAUTH_RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return Response.json({ error: "Too many requests" }, { status: 429 });
    }
  }
  return getOAuthProvider(env).fetch(request, env, ctx);
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const bindings = env as Env["Bindings"];
    if (bindings.MCP_HOST && url.hostname === bindings.MCP_HOST) {
      return handleMcpHost(request, url, bindings, ctx);
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      url.pathname = url.pathname.slice(4) || "/";
      request = new Request(url, request);
    }
    return app.fetch(request, env as never, ctx);
  },
};
