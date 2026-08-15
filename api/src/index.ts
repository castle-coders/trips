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
import { cors } from "hono/cors";

const app = new OpenAPIHono<Env>();

app.use("*", (c, next) => {
  const allowedOrigins = ["http://localhost:5173", c.env.WEB_APP_ORIGIN].filter(Boolean);
  return cors({
    origin: (origin) => {
      if (allowedOrigins.includes(origin)) return origin;
      if (origin.endsWith(".trips-web-cm1.pages.dev")) return origin;
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization", "CF-Access-Jwt-Assertion", "X-Dev-User-Email"],
    allowMethods: ["POST", "GET", "OPTIONS", "PUT", "DELETE"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  })(c, next);
});

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

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      url.pathname = url.pathname.slice(4) || "/";
      request = new Request(url, request);
    }
    return app.fetch(request, env as never, ctx);
  },
};
