/**
 * The OAuthProvider `defaultHandler` for the MCP hostname: every request that is not the API
 * route, the token endpoint, the registration endpoint or a `/.well-known/` metadata path.
 *
 * Routes are registered by their owners:
 *  - `GET`/`POST /authorize` -> `registerAuthorizeRoutes` (authorize.ts, consent builder)
 *  - `GET /callback`         -> `registerUpstreamRoutes` (upstream.ts, upstream builder)
 *
 * No CORS middleware here, by design (TDD 9). Uncaught errors, including the library's
 * `AuthorizationError`, become a safe page or client redirect via `authorizationErrorResponse`,
 * never a 500 with details.
 */
import { Hono } from "hono";
import { registerAuthorizeRoutes } from "./authorize";
import { registerUpstreamRoutes } from "./upstream";
import { authorizationErrorResponse, errorPageResponse, type OAuthAppEnv } from "./http";

const app = new Hono<OAuthAppEnv>();

registerAuthorizeRoutes(app);
registerUpstreamRoutes(app);

app.notFound(() => errorPageResponse("Not found.", 404, undefined, "Not found"));
app.onError((err) => authorizationErrorResponse(err));

export const oauthDefaultApp = app;
