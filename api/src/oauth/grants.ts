/**
 * Grant and static-client management for the Stage 2 OAuth server (TDD 7.5, PRD 6.3, 6.4).
 *
 * Runs on the MAIN hostname, outside `OAuthProvider.fetch`, so `env.OAUTH_PROVIDER` is not set
 * there. Every call goes through `getOAuthApi(buildProviderOptions(env), env)`, which reads and
 * writes the same `OAUTH_KV` binding as the provider on the MCP hostname (MCP_SPIKE_RESULTS 4).
 *
 * Stage 2 off: `buildProviderOptions` throws when `MCP_PUBLIC_URL` is empty. Callers check
 * `isOAuthConfigured(env)` first. List functions return `[]`; mutating functions throw
 * `OAuthNotConfiguredError`, which routes map to 503 `{ error: "OAuth is not configured" }`.
 *
 * Library facts relied on (1.2.4, read from dist):
 *  - `listUserGrants` pages over `grant:<userId>:` keys; there is no list-all helper, so
 *    `listAllGrants` loops over D1 users.
 *  - `revokeGrant(grantId, userId)` deletes every `token:<userId>:<grantId>:*` key and then the
 *    grant, so the next bearer call is 401. It does NOT check that the grant exists or belongs
 *    to `userId`; a wrong pair silently does nothing. `revokeGrant` below therefore confirms
 *    membership in `listUserGrants(userId)` first and reports "not found" otherwise.
 *  - `createClient` generates the client id and a 32-character secret itself, stores only
 *    SHA-256(secret) in KV, and returns the plaintext secret once in its result.
 *  - `lookupClient`/`listClients` return the stored record, which still carries the secret HASH
 *    in `clientSecret`. Nothing here ever returns that field.
 *  - `lookupClient` on a Client ID Metadata Document URL fetches the document over the network
 *    on every call. Grant listings never do that: CIMD clients get `clientName: null`.
 */
import { getOAuthApi, type ClientInfo, type GrantSummary, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { getDb } from "../db";
import { users } from "../db/schema";
import { logField, type Bindings } from "./http";
import { buildProviderOptions } from "./provider";
import { isAllowedRedirect } from "./redirects";

export const OAUTH_NOT_CONFIGURED = "OAuth is not configured";

export class OAuthNotConfiguredError extends Error {
  constructor() {
    super(OAUTH_NOT_CONFIGURED);
    this.name = "OAuthNotConfiguredError";
  }
}

/** Raised for a static-client request the server refuses; the message is safe to return. */
export class StaticClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticClientError";
  }
}

/** Stage 2 is on when the canonical resource URL is set (same test `buildProviderOptions` uses). */
export function isOAuthConfigured(env: Bindings): boolean {
  return typeof env.MCP_PUBLIC_URL === "string" && env.MCP_PUBLIC_URL !== "";
}

function helpers(env: Bindings): OAuthHelpers {
  if (!isOAuthConfigured(env)) throw new OAuthNotConfiguredError();
  return getOAuthApi(buildProviderOptions(env), env);
}

/** Library page size cap (`ListOptions.limit`, max 1000). */
const PAGE_LIMIT = 1000;

async function allUserGrants(api: OAuthHelpers, userId: string): Promise<GrantSummary[]> {
  const out: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listUserGrants(userId, { limit: PAGE_LIMIT, cursor });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

function isCimdClientId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}

/** Per-request client-name cache, so N grants for one client cost one lookup. */
type ClientNameCache = Map<string, Promise<string | null>>;

function clientName(api: OAuthHelpers, cache: ClientNameCache, clientId: string): Promise<string | null> {
  let hit = cache.get(clientId);
  if (!hit) {
    hit = isCimdClientId(clientId)
      ? Promise.resolve(null)
      : api.lookupClient(clientId).then(
          (c) => c?.clientName ?? null,
          () => null,
        );
    cache.set(clientId, hit);
  }
  return hit;
}

function isoFromEpochSeconds(seconds: number | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/** One grant as returned by `GET /auth/me/grants`. */
export interface GrantView {
  id: string;
  clientId: string;
  /** From the client record; `null` for unknown, deleted or CIMD clients. */
  clientName: string | null;
  scopes: string[];
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or `null` when the grant has no expiry recorded. */
  expiresAt: string | null;
}

/** One grant as returned by `GET /admin/grants`. */
export interface AdminGrantView extends GrantView {
  userId: string;
  userEmail: string;
}

async function toView(api: OAuthHelpers, cache: ClientNameCache, g: GrantSummary): Promise<GrantView> {
  return {
    id: g.id,
    clientId: g.clientId,
    clientName: await clientName(api, cache, g.clientId),
    scopes: Array.isArray(g.scope) ? [...g.scope] : [],
    createdAt: isoFromEpochSeconds(g.createdAt) ?? new Date(0).toISOString(),
    expiresAt: isoFromEpochSeconds(g.expiresAt),
  };
}

function newestFirst<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** The user's grants, newest first. `[]` when Stage 2 is off. */
export async function listGrantsForUser(env: Bindings, userId: string): Promise<GrantView[]> {
  if (!isOAuthConfigured(env)) return [];
  const api = helpers(env);
  const cache: ClientNameCache = new Map();
  const grants = await allUserGrants(api, userId);
  const views = await Promise.all(grants.map((g) => toView(api, cache, g)));
  return views.sort(newestFirst);
}

/**
 * Every user's grants, newest first. No library helper lists across users, so this walks the
 * D1 `users` table and calls `listUserGrants` per user. `[]` when Stage 2 is off.
 */
export async function listAllGrants(env: Bindings): Promise<AdminGrantView[]> {
  if (!isOAuthConfigured(env)) return [];
  const api = helpers(env);
  const cache: ClientNameCache = new Map();
  const rows = await getDb(env.DB).select({ id: users.id, email: users.email }).from(users);
  const perUser = await Promise.all(
    rows.map(async (u) => {
      const grants = await allUserGrants(api, u.id);
      return Promise.all(
        grants.map(async (g) => ({ ...(await toView(api, cache, g)), userId: u.id, userEmail: u.email })),
      );
    }),
  );
  return perUser.flat().sort(newestFirst);
}

/**
 * One of `userId`'s grants as a view, or `null` when no grant with that id belongs to the user.
 * Route handlers read this before `revokeGrant` so the audit event (AUDIT_TDD 7.4) can carry
 * the grant's client, scopes and creation time after the grant itself is gone from KV.
 * Throws `OAuthNotConfiguredError` when Stage 2 is off.
 */
export async function getGrant(env: Bindings, userId: string, grantId: string): Promise<GrantView | null> {
  const api = helpers(env);
  const grant = (await allUserGrants(api, userId)).find((g) => g.id === grantId);
  if (!grant) return null;
  return toView(api, new Map(), grant);
}

/**
 * Revokes `grantId` if, and only if, it is one of `userId`'s grants. Returns `false` (caller
 * answers 404) otherwise, because the library's `revokeGrant` silently no-ops on a wrong pair.
 * On success the grant and all its access and refresh tokens are gone from KV.
 * Throws `OAuthNotConfiguredError` when Stage 2 is off.
 */
export async function revokeGrant(env: Bindings, userId: string, grantId: string): Promise<boolean> {
  const api = helpers(env);
  const grants = await allUserGrants(api, userId);
  if (!grants.some((g) => g.id === grantId)) return false;
  await api.revokeGrant(grantId, userId);
  console.log(`[oauth] event=revoke grant=${logField(grantId, 40)} user=${logField(userId, 40)}`);
  return true;
}

/**
 * Revokes every grant (and, through the library, every access and refresh token) belonging to
 * `userId`. Call it BEFORE the user's D1 row is removed (admin delete, account merge): once the
 * row is gone, `listAllGrants` can no longer see the grant, so it would be unrevocable while its
 * refresh token kept sliding. Returns the number revoked. No-op returning 0 when Stage 2 is off.
 * Throws on KV failure; callers must then abort rather than delete the user.
 *
 * Grants are re-listed until none remain (at most a few passes), so a page boundary shifting
 * under deletion cannot leave any behind.
 */
export async function revokeAllGrantsForUser(env: Bindings, userId: string): Promise<number> {
  if (!isOAuthConfigured(env)) return 0;
  const api = helpers(env);
  let count = 0;
  for (let pass = 0; ; pass++) {
    const grants = await allUserGrants(api, userId);
    if (grants.length === 0) break;
    // Bounded: if grants survive repeated revocation, fail loudly instead of spinning.
    if (pass >= 3) throw new Error("grant revocation did not converge");
    for (const g of grants) {
      await api.revokeGrant(g.id, userId);
      count++;
    }
  }
  console.log(`[oauth] event=revoke scope=user user=${logField(userId, 40)} count=${count}`);
  return count;
}

// ---------------------------------------------------------------------------------------------
// Static pre-registered clients (PRD 6.3: Gemini Spark and other platforms without DCR)
// ---------------------------------------------------------------------------------------------

export type StaticClientAuthMethod = "client_secret_basic" | "client_secret_post";

export interface CreateStaticClientInput {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod?: StaticClientAuthMethod;
}

/** A client as listed to admins. Never carries a secret or its hash. */
export interface ClientView {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  /** True when the client authenticates with a secret at the token endpoint. */
  confidential: boolean;
  /** ISO 8601, or `null` when the library did not record it. */
  registrationDate: string | null;
}

/** Returned once from `createStaticClient`; the plaintext secret is not stored anywhere. */
export interface CreatedStaticClient extends ClientView {
  clientSecret: string;
}

function toClientView(c: ClientInfo): ClientView {
  return {
    clientId: c.clientId,
    clientName: c.clientName ?? null,
    redirectUris: [...(c.redirectUris ?? [])],
    tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
    confidential: c.tokenEndpointAuthMethod !== "none",
    registrationDate: isoFromEpochSeconds(c.registrationDate),
  };
}

/**
 * Seeds a confidential client into `OAUTH_KV` with a server-generated secret. Every redirect
 * URI must pass the same allow-list as DCR (`isAllowedRedirect`), because `createClient` skips
 * `clientRegistrationCallback`. The library hashes the secret before storing it and returns the
 * plaintext once; the caller must hand it to the admin and never log it.
 */
export async function createStaticClient(env: Bindings, input: CreateStaticClientInput): Promise<CreatedStaticClient> {
  const api = helpers(env);
  if (input.redirectUris.length === 0) throw new StaticClientError("redirectUris must not be empty");
  for (const uri of input.redirectUris) {
    if (!isAllowedRedirect(uri)) throw new StaticClientError("redirect_uri not allowed");
  }
  let created: ClientInfo;
  try {
    created = await api.createClient({
      clientName: input.clientName,
      redirectUris: [...input.redirectUris],
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? "client_secret_basic",
    });
  } catch {
    // Library validation (redirect URI form, capabilities). Its message may echo input; do not.
    throw new StaticClientError("client metadata rejected");
  }
  if (!created.clientSecret) throw new Error("createClient returned no secret for a confidential client");
  console.log(`[oauth] event=client_create client=${logField(created.clientId, 40)} name=${logField(created.clientName, 80)}`);
  return { ...toClientView(created), clientSecret: created.clientSecret };
}

/** Every stored client (static and DCR), without secrets. `[]` when Stage 2 is off. */
export async function listClients(env: Bindings): Promise<ClientView[]> {
  if (!isOAuthConfigured(env)) return [];
  const api = helpers(env);
  const out: ClientView[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listClients({ limit: PAGE_LIMIT, cursor });
    out.push(...page.items.map(toClientView));
    cursor = page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.clientId.localeCompare(b.clientId));
}

/**
 * One stored client as a view (never the secret hash), or `null` when none has that id. CIMD
 * URL ids are never stored, so they return `null` without a network fetch. Route handlers read
 * this before `deleteClient` so the audit event (AUDIT_TDD 7.4) can carry the client's name and
 * redirect URIs. Throws `OAuthNotConfiguredError` when Stage 2 is off.
 */
export async function getClient(env: Bindings, clientId: string): Promise<ClientView | null> {
  const api = helpers(env);
  if (isCimdClientId(clientId)) return null;
  const existing = await api.lookupClient(clientId);
  return existing ? toClientView(existing) : null;
}

/**
 * Deletes a stored client and, through the library, revokes its grants and tokens across all
 * users. Returns `false` when no stored client has that id (CIMD URL ids are never stored).
 */
export async function deleteClient(env: Bindings, clientId: string): Promise<boolean> {
  const api = helpers(env);
  if (isCimdClientId(clientId)) return false;
  const existing = await api.lookupClient(clientId);
  if (!existing) return false;
  await api.deleteClient(clientId);
  console.log(`[oauth] event=client_delete client=${logField(clientId, 40)}`);
  return true;
}
