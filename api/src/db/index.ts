import { drizzle } from "drizzle-orm/d1";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import * as schema from "./schema";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export type Channel = "web" | "service_token" | "mcp_stage1" | "mcp_oauth" | "dev";

export interface Actor extends AuthUser {
  channel: Channel;
  /** OAuth client id (mcp_oauth) or service identity common name (service_token, mcp_stage1). */
  clientId: string | null;
  /** Cloudflare cf-ray when present. */
  requestId: string | null;
}

export interface CfIdentity {
  email: string;
  name: string;
}

/** Cloudflare Workers ratelimit binding (`[[unsafe.bindings]] type = "ratelimit"`). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export type Env = {
  Bindings: {
    DB: D1Database;
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUDIENCE: string;
    CF_ACCESS_INVITE_AUDIENCE: string;
    WEB_APP_ORIGIN?: string;
    BOOTSTRAP_ADMIN_EMAIL?: string;
    DEV_MODE?: string;
    EXTERNAL_EVAL_PRIVATE_KEY: string;
    EXTERNAL_EVAL_KEY_ID?: string;
    /** Per-IP limiter on the External Evaluation endpoints (namespace 1001). */
    EVAL_RATE_LIMITER?: RateLimiter;
    /** Per-user limiter on MCP tool calls, keyed on userId (namespace 1002). */
    MCP_RATE_LIMITER?: RateLimiter;

    // --- Stage 2: OAuth authorization server on the MCP hostname (TDD 7, 8) ---

    /** OAuth provider storage: clients, grants, hashed tokens, consent and upstream state. */
    OAUTH_KV: KVNamespace;
    /**
     * Set by the library only inside `OAuthProvider.fetch` (MCP hostname). Main-hostname
     * code must use `getOAuthApi(buildProviderOptions(env), env)` instead.
     */
    OAUTH_PROVIDER?: OAuthHelpers;
    /** Per-IP limiter on /authorize, /oauth/token, /oauth/register, keyed on cf-connecting-ip (namespace 1003). */
    OAUTH_RATE_LIMITER?: RateLimiter;
    /** Bare MCP hostname. Empty or unset disables Stage 2 dispatch entirely. */
    MCP_HOST?: string;
    /** Public MCP endpoint, `https://<mcp-host>/mcp`; the OAuth protected-resource identifier. */
    MCP_PUBLIC_URL?: string;
    /** Access for SaaS (OIDC) upstream endpoints and issuer. */
    ACCESS_AUTHORIZATION_URL?: string;
    ACCESS_TOKEN_URL?: string;
    ACCESS_JWKS_URL?: string;
    ACCESS_ISSUER?: string;
    /** Secrets (`wrangler secret put`): Access for SaaS OIDC client credentials. */
    ACCESS_CLIENT_ID?: string;
    ACCESS_CLIENT_SECRET?: string;
  };
  Variables: {
    user: Actor;
    cfIdentity: CfIdentity;
  };
};

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
