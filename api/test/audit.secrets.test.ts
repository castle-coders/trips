// AUDIT_PRD 4.4 / acceptance criterion 11, AUDIT_TDD 6.4, 7.3, 7.4, 7.5, 11: no password hash,
// Access JWT, OAuth token, client secret, invite token or account-link token ever reaches an
// audit_events row.
//
// `driveEverything()` exercises every administration and account path end to end through the
// real Worker export, seeding each secret with an unmistakable marker (or reading the generated
// value back from where the app keeps it), and collects every secret it saw. The tests then scan
// the whole table: every column of every row, serialized, against each secret, its SHA-256 (hex
// and base64url, the forms token stores use) and its base64/base64url encodings; and every key
// of every nested object in the JSON columns against a forbidden-name list.
//
// All hostnames, ids, emails and secrets here are obviously fake test values (example.test).
import { eq } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invites, serviceIdentities, users } from "../src/db/schema";
import { ENTITY_TYPES, type Action, type EntityType } from "../src/services/audit";
import { addParticipant, addUserEmail, seedTrip, seedUser, testDb } from "./helpers";
import { auditRows, type AuditRow } from "./helpers/audit";
import { ACCESS_CLIENT_SECRET, MAIN_ORIGIN, UPSTREAM_ACCESS_TOKEN, UPSTREAM_CODE, asMain, send, signIn, stage2Env } from "./helpers/oauth";

afterEach(() => vi.restoreAllMocks());

// --- Cloudflare Access JWTs (same technique as mcp.audit.test.ts / acceptance.test.ts) -----------
// authMiddleware and jwtOnlyMiddleware verify Cf-Access-Jwt-Assertion against
// https://<team>/cdn-cgi/access/certs via jose's createRemoteJWKSet (global fetch), so the test
// answers that one URL with a local RS256 key. DEV_MODE is off in that env, so only the JWT counts.
const FAKE_TEAM_DOMAIN = "fake-team.access.example.test";
const FAKE_AUDIENCE = "fake-access-audience-tag-secrets-0000";
const FAKE_INVITE_AUDIENCE = "fake-access-invite-audience-tag-secrets-0000";
const FAKE_CERTS_URL = `https://${FAKE_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const accessKeys = await generateKeyPair("RS256");
const ACCESS_JWK = { ...(await exportJWK(accessKeys.publicKey)), kid: "fake-access-kid-secrets", alg: "RS256", use: "sig" };

function stubAccessCerts(): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === FAKE_CERTS_URL) return Response.json({ keys: [ACCESS_JWK] });
    return real(input, init);
  });
}

function accessJwt(claims: Record<string, unknown>, audience = FAKE_AUDIENCE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: ACCESS_JWK.kid })
    .setIssuer(`https://${FAKE_TEAM_DOMAIN}`)
    .setAudience(audience)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 300)
    .sign(accessKeys.privateKey);
}

const accessEnv = () =>
  stage2Env({
    CF_ACCESS_TEAM_DOMAIN: FAKE_TEAM_DOMAIN,
    CF_ACCESS_AUDIENCE: FAKE_AUDIENCE,
    CF_ACCESS_INVITE_AUDIENCE: FAKE_INVITE_AUDIENCE,
    DEV_MODE: "",
  });

/** Main-host request authenticated only by a Cf-Access-Jwt-Assertion header (no DEV header). */
function asJwt(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", jwt);
  headers.set("cf-ray", "ray-secrets-jwt");
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return send(new Request(`${MAIN_ORIGIN}/api${path}`, { ...init, headers }), accessEnv());
}

// --- Encodings a leaked secret could hide behind ------------------------------------------------

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const toB64url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The literal secret plus every encoding of it a store or log might use. */
async function forms(secret: string): Promise<string[]> {
  const raw = new TextEncoder().encode(secret);
  const digest = await sha256(secret);
  return [secret, hex(digest), b64(digest), toB64url(b64(digest)), b64(raw), toB64url(b64(raw))];
}

/**
 * Key names that must never appear in a JSON column, compared after lower-casing and dropping
 * underscores so `password_hash`, `refresh_token` and `clientSecretHash` all match. Exact match
 * on the normalized key, so `tokenEndpointAuthMethod` (allow-listed on oauth_client) is fine.
 */
const FORBIDDEN_KEYS = [
  "token",
  "passwordhash",
  "clientsecret",
  "clientsecrethash",
  "secret",
  "refreshtoken",
  "accesstoken",
  "jwt",
];

const normalizeKey = (k: string) => k.toLowerCase().replace(/_/g, "");

/** Every key of every nested object (arrays walked too), as `column.path.to.key`. */
function collectKeys(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectKeys(v, `${path}[${i}]`, out));
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.push(`${path}.${k}`);
      collectKeys(v, `${path}.${k}`, out);
    }
  }
}

const JSON_COLUMNS = ["before", "after", "changes", "metadata"] as const;

// --- The drive -----------------------------------------------------------------------------------

interface Drive {
  /** Every secret the drive seeded or was handed, by kind (kind is for the failure message only). */
  secrets: { kind: string; value: string }[];
  inviteTokens: string[];
  /** `auditRows().length` immediately before and after `POST /auth/me/link-token`. */
  linkTokenRowCounts: { before: number; after: number };
  /** The `{ entityType, action }` pairs the drive expects, keyed by the path that produces them. */
  expected: Record<string, { entityType: EntityType; action: Action }>;
}

const PW = {
  admin: "PWHASH-ADMIN-7f3a-SECRET",
  alice: "PWHASH-ALICE-1b2c-SECRET",
  bob: "PWHASH-BOB-9e8d-SECRET",
  created: "PWHASH-CREATED-4d5e-SECRET",
  keep1: "PWHASH-KEEP1-a1a1-SECRET",
  keep2: "PWHASH-KEEP2-b2b2-SECRET",
  keep3: "PWHASH-KEEP3-c3c3-SECRET",
  linker: "PWHASH-LINKER-d4d4-SECRET",
  conf: "PWHASH-CONF-e5e5-SECRET",
};

const SERVICE_SUBJECT = "fake-service-token-subject-secrets-0001";
const SERVICE_COMMON_NAME = "fake-secrets-service-token.access";
const CLIENT_SECRET_NAME = "Fake Static Client (secrets)";
const RAY = { "cf-ray": "ray-secrets-dev" };

async function setHash(userId: string, passwordHash: string): Promise<void> {
  await testDb().update(users).set({ passwordHash }).where(eq(users.id, userId));
}

async function seedWithHash(email: string, role: "admin" | "editor" | "viewer", passwordHash: string) {
  const u = await seedUser(email, role);
  await setHash(u.id, passwordHash);
  return u;
}

async function json<T = any>(res: Response, status: number, what: string): Promise<T> {
  const text = await res.text();
  expect(res.status, `${what}: ${text.slice(0, 300)}`).toBe(status);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** OAuth sign-in for `email`; returns the grant id and every token the flow produced. */
async function connect(email: string, clientName: string) {
  const r = await signIn(email, { ticked: ["trips:read", "trips:write", "offline_access"], clientName });
  const grants = await json<any[]>(await asMain(email, "/auth/me/grants"), 200, `me/grants for ${email}`);
  const grant = grants.find((g) => g.clientId === r.clientId);
  expect(grant, `grant for ${clientName}`).toBeDefined();
  const secrets = [
    { kind: `oauth access token (${clientName})`, value: r.tokens.access_token },
    { kind: `oauth auth code (${clientName})`, value: r.code },
    ...(r.tokens.refresh_token ? [{ kind: `oauth refresh token (${clientName})`, value: r.tokens.refresh_token }] : []),
    ...r.upstream.idTokens.map((t) => ({ kind: `upstream id_token (${clientName})`, value: t })),
  ];
  return { grantId: grant.id as string, clientId: r.clientId, secrets };
}

async function driveEverything(): Promise<Drive> {
  const secrets: Drive["secrets"] = [];
  const expected: Drive["expected"] = {};
  for (const [who, hash] of Object.entries(PW)) secrets.push({ kind: `passwordHash (${who})`, value: hash });
  secrets.push(
    { kind: "upstream client secret", value: ACCESS_CLIENT_SECRET },
    { kind: "upstream auth code", value: UPSTREAM_CODE },
    { kind: "upstream access token", value: UPSTREAM_ACCESS_TOKEN },
  );

  // --- Users (every one carries a password hash marker in its row) ---
  const admin = await seedWithHash("admin@example.test", "admin", PW.admin);
  const alice = await seedWithHash("alice@example.test", "editor", PW.alice);
  const bob = await seedWithHash("bob@example.test", "viewer", PW.bob);
  const keep1 = await seedWithHash("keep1@example.test", "viewer", PW.keep1);
  const keep2 = await seedWithHash("keep2@example.test", "viewer", PW.keep2);
  const keep3 = await seedWithHash("keep3@example.test", "viewer", PW.keep3);
  const linker = await seedWithHash("linker@example.test", "viewer", PW.linker);
  const conf = await seedWithHash("conf@example.test", "viewer", PW.conf);
  const { trip, owner } = await seedTrip(admin.id, { name: "Secrets Trip" });
  await addParticipant(trip.id, alice.id, "Editor"); // alice writes an expense over her Access JWT below

  // --- OAuth grants (Stage 2 flow through the real provider; every token is a secret) ---
  const adminGrant = await connect(admin.email, "Admin Tool");
  const aliceGrant = await connect(alice.email, "Alice Tool");
  const bobGrant = await connect(bob.email, "Bob Tool");
  const linkerGrant = await connect(linker.email, "Linker Tool");
  secrets.push(...adminGrant.secrets, ...aliceGrant.secrets, ...bobGrant.secrets, ...linkerGrant.secrets);

  // --- Admin: user create / update / delete ---
  const created = await json(
    await asMain(admin.email, "/admin/users", { method: "POST", headers: RAY, body: JSON.stringify({ email: "created@example.test", name: "Created User", role: "editor" }) }),
    201,
    "POST /admin/users",
  );
  expected["POST /admin/users"] = { entityType: "user", action: "create" };
  await setHash(created.id, PW.created);
  const createdGrant = await connect("created@example.test", "Created Tool");
  secrets.push(...createdGrant.secrets);
  await json(
    await asMain(admin.email, `/admin/users/${created.id}`, { method: "PUT", headers: RAY, body: JSON.stringify({ name: "Created Renamed", role: "viewer" }) }),
    200,
    "PUT /admin/users/:id",
  );
  expected["PUT /admin/users/:id"] = { entityType: "user", action: "update" };
  expect((await asMain(admin.email, `/admin/users/${created.id}`, { method: "DELETE", headers: RAY })).status).toBe(204);
  expected["DELETE /admin/users/:id"] = { entityType: "user", action: "delete" };

  // --- Profile, email set-primary and unlink ---
  await json(await asMain(admin.email, "/auth/me", { method: "PUT", headers: RAY, body: JSON.stringify({ name: "Admin Renamed" }) }), 200, "PUT /auth/me");
  expected["PUT /auth/me"] = { entityType: "user", action: "update" };
  await addUserEmail(admin.id, "admin-second@example.test");
  const me = await json(await asMain(admin.email, "/auth/me"), 200, "GET /auth/me");
  const second = me.emails.find((e: any) => e.email === "admin-second@example.test");
  const first = me.emails.find((e: any) => e.email === admin.email);
  await json(await asMain(admin.email, `/auth/me/emails/${second.id}/primary`, { method: "PUT", headers: RAY }), 200, "PUT /auth/me/emails/:id/primary");
  expected["PUT /auth/me/emails/:id/primary"] = { entityType: "user_email", action: "set_primary" };
  await json(await asMain(admin.email, `/auth/me/emails/${first.id}`, { method: "DELETE", headers: RAY }), 200, "DELETE /auth/me/emails/:id");
  expected["DELETE /auth/me/emails/:id"] = { entityType: "user_email", action: "unlink" };
  // admin's primary address is now admin-second@example.test; the DEV header resolves any linked email.
  const adminEmail = "admin-second@example.test";

  // --- Service identity create, a write authenticated by its Access service-token JWT, delete ---
  const identity = await json(
    await asMain(adminEmail, "/admin/service-identities", {
      method: "POST",
      headers: RAY,
      body: JSON.stringify({ cfAccessSubject: SERVICE_SUBJECT, commonName: SERVICE_COMMON_NAME, userId: admin.id }),
    }),
    201,
    "POST /admin/service-identities",
  );
  expected["POST /admin/service-identities"] = { entityType: "service_identity", action: "create" };
  expect((await testDb().select().from(serviceIdentities).where(eq(serviceIdentities.id, identity.id))).length).toBe(1);

  // Restore the OAuth upstream spies before stubbing the Access certs URL (both spy on fetch).
  vi.restoreAllMocks();
  stubAccessCerts();
  const serviceJwt = await accessJwt({ sub: "", common_name: SERVICE_SUBJECT, type: "app" });
  const humanJwt = await accessJwt({ sub: "fake-human-sub-0001", email: alice.email, name: "Alice Access" });
  const inviteJwt = await accessJwt({ sub: "fake-human-sub-0002", email: "jwtnew@example.test", name: "JWT Newcomer" }, FAKE_INVITE_AUDIENCE);
  secrets.push(
    { kind: "Access service-token JWT", value: serviceJwt },
    { kind: "Access human JWT", value: humanJwt },
    { kind: "Access invite-app JWT", value: inviteJwt },
  );

  await json(await asJwt(serviceJwt, `/trips/${trip.id}`, { method: "PUT", body: JSON.stringify({ name: "Secrets Trip (service token)" }) }), 200, "PUT /trips/:id via service token");
  expected["PUT /trips/:id (service token)"] = { entityType: "trip", action: "update" };
  await json(
    await asJwt(humanJwt, `/trips/${trip.id}/expenses`, {
      method: "POST",
      body: JSON.stringify({ description: "Museum tickets", amount: 30, currency: "EUR", category: "Entertainment", payerId: owner!.id, splitType: "EQUAL" }),
    }),
    201,
    "POST /trips/:id/expenses via human Access JWT",
  );
  expected["POST /trips/:id/expenses (human JWT)"] = { entityType: "expense", action: "create" };

  // --- Invites: create x4, accept (new user via JWT, new user via DEV, existing user), delete ---
  const inviteIds: string[] = [];
  for (const name of ["Invitee JWT", "Invitee New", "Invitee Existing", "Invitee Deleted"]) {
    const inv = await json(await asMain(adminEmail, `/trips/${trip.id}/invites`, { method: "POST", headers: RAY, body: JSON.stringify({ name }) }), 201, `POST invites (${name})`);
    inviteIds.push(inv.id);
  }
  expected["POST /trips/:id/invites"] = { entityType: "invite", action: "create" };
  const inviteRows = await testDb().select().from(invites);
  const tokenOf = (id: string) => inviteRows.find((r) => r.id === id)!.token;
  const inviteTokens = inviteRows.map((r) => r.token);
  for (const t of inviteTokens) secrets.push({ kind: "invite token", value: t });

  const jwtAccept = await asJwt(inviteJwt, `/auth/invite/${tokenOf(inviteIds[0])}/accept`, { method: "POST" });
  await json(jwtAccept, 200, "POST /auth/invite/:token/accept via invite-app JWT (new user)");
  expected["POST /auth/invite/:token/accept (JWT, new user)"] = { entityType: "invite", action: "accept" };
  vi.restoreAllMocks();

  await json(await asMain("invitee-new@example.test", `/auth/invite/${tokenOf(inviteIds[1])}/accept`, { method: "POST", headers: RAY }), 200, "accept as new DEV user");
  expected["POST /auth/invite/:token/accept (new user)"] = { entityType: "participant", action: "create" };
  await json(await asMain(alice.email, `/auth/invite/${tokenOf(inviteIds[2])}/accept`, { method: "POST", headers: RAY }), 200, "accept as existing user");
  expect((await asMain(adminEmail, `/trips/${trip.id}/invites/${inviteIds[3]}`, { method: "DELETE", headers: RAY })).status).toBe(204);
  expected["DELETE /trips/:id/invites/:inviteId"] = { entityType: "invite", action: "delete" };

  // --- Account link tokens: /me/link, public /link, public /link/:token/confirm ---
  const rowsBeforeLinkToken = (await auditRows()).length;
  const t1 = await json(await asMain(keep1.email, "/auth/me/link-token", { method: "POST", headers: RAY }), 200, "POST /auth/me/link-token");
  const rowsAfterLinkToken = (await auditRows()).length;
  const t2 = await json(await asMain(keep2.email, "/auth/me/link-token", { method: "POST", headers: RAY }), 200, "POST /auth/me/link-token (keep2)");
  const t3 = await json(await asMain(keep3.email, "/auth/me/link-token", { method: "POST", headers: RAY }), 200, "POST /auth/me/link-token (keep3)");
  secrets.push({ kind: "account-link token (t1)", value: t1.token }, { kind: "account-link token (t2)", value: t2.token }, { kind: "account-link token (t3)", value: t3.token });

  await json(await asMain(linker.email, "/auth/me/link-preview", { method: "POST", body: JSON.stringify({ token: t1.token }) }), 200, "POST /auth/me/link-preview");
  await json(await asMain(linker.email, "/auth/me/link", { method: "POST", headers: RAY, body: JSON.stringify({ token: t1.token }) }), 200, "POST /auth/me/link");
  expected["POST /auth/me/link"] = { entityType: "user", action: "merge" };

  await json(await asMain("pubnew@example.test", "/auth/link-preview", { method: "POST", body: JSON.stringify({ token: t2.token }) }), 200, "POST /auth/link-preview");
  await json(await asMain("pubnew@example.test", "/auth/link", { method: "POST", headers: RAY, body: JSON.stringify({ token: t2.token }) }), 200, "POST /auth/link (new user)");
  expected["POST /auth/link (new user)"] = { entityType: "user", action: "merge" };

  expect((await asMain(conf.email, `/auth/link/${t3.token}`)).status).toBe(200);
  const confirm = await asMain(conf.email, `/auth/link/${t3.token}/confirm`, { method: "POST", headers: RAY });
  expect(confirm.status, await confirm.clone().text()).toBe(200);
  expect(await confirm.text()).toContain("Accounts Linked");
  expected["POST /auth/link/:token/confirm"] = { entityType: "user", action: "merge" };

  // --- Grant revoke: admin on another user's grant, and self-service ---
  expect((await asMain(adminEmail, `/admin/grants/${alice.id}/${aliceGrant.grantId}`, { method: "DELETE", headers: RAY })).status).toBe(204);
  expected["DELETE /admin/grants/:userId/:grantId"] = { entityType: "oauth_grant", action: "revoke" };
  expect((await asMain(adminEmail, `/auth/me/grants/${adminGrant.grantId}`, { method: "DELETE", headers: RAY })).status).toBe(204);
  expected["DELETE /auth/me/grants/:grantId"] = { entityType: "oauth_grant", action: "revoke" };

  // --- Static OAuth client: create (secret shown once) and delete ---
  const client = await json(
    await asMain(adminEmail, "/admin/oauth-clients", {
      method: "POST",
      headers: RAY,
      body: JSON.stringify({ clientName: CLIENT_SECRET_NAME, redirectUris: ["http://127.0.0.1:5555/callback"], tokenEndpointAuthMethod: "client_secret_post" }),
    }),
    201,
    "POST /admin/oauth-clients",
  );
  expect(typeof client.clientSecret).toBe("string");
  secrets.push({ kind: "static client secret", value: client.clientSecret });
  expected["POST /admin/oauth-clients"] = { entityType: "oauth_client", action: "create" };
  expect((await asMain(adminEmail, `/admin/oauth-clients/${client.clientId}`, { method: "DELETE", headers: RAY })).status).toBe(204);
  expected["DELETE /admin/oauth-clients/:clientId"] = { entityType: "oauth_client", action: "delete" };

  // --- Admin merge (bob, who holds a grant and a hash, into alice) ---
  await json(
    await asMain(adminEmail, "/admin/users/merge", { method: "POST", headers: RAY, body: JSON.stringify({ keepUserId: alice.id, mergeUserId: bob.id }) }),
    200,
    "POST /admin/users/merge",
  );
  expected["POST /admin/users/merge"] = { entityType: "user", action: "merge" };

  // --- One itinerary write so every trip entity kind is represented ---
  await json(
    await asMain(adminEmail, `/trips/${trip.id}/itineraries`, {
      method: "POST",
      headers: RAY,
      body: JSON.stringify({ type: "Activity", content: { name: "Museum", startTime: "2030-01-11T10:00" }, confirmationNumber: "CONF-FAKE-SECRETS" }),
    }),
    201,
    "POST /trips/:id/itineraries",
  );
  expected["POST /trips/:id/itineraries"] = { entityType: "itinerary", action: "create" };

  for (const s of secrets) expect(s.value, `${s.kind} is a non-empty string`).toBeTruthy();
  return { secrets, inviteTokens, linkTokenRowCounts: { before: rowsBeforeLinkToken, after: rowsAfterLinkToken }, expected };
}

// --- Tests ---------------------------------------------------------------------------------------

describe("audit_events never holds a secret (PRD 4.4, acceptance 11)", () => {
  let drive: Drive;
  let rows: AuditRow[];

  beforeEach(async () => {
    drive = await driveEverything();
    rows = await auditRows();
  });

  it("the drive produced rows for every secret-bearing entity type and every exercised path", () => {
    expect(rows.length).toBeGreaterThan(0);
    const seen = new Set(rows.map((r) => `${r.entityType}.${r.action}`));
    for (const t of ["user", "user_email", "service_identity", "invite", "oauth_grant", "oauth_client"] as const) {
      expect(rows.some((r) => r.entityType === t), `at least one ${t} row`).toBe(true);
    }
    for (const [path, { entityType, action }] of Object.entries(drive.expected)) {
      expect(seen.has(`${entityType}.${action}`), `${path} should record ${entityType}.${action}`).toBe(true);
    }
    // The JWT-authenticated writes really went through Access, not the DEV header.
    expect(rows.some((r) => r.channel === "service_token" && r.clientId === SERVICE_COMMON_NAME && r.entityType === "trip")).toBe(true);
    expect(rows.some((r) => r.channel === "web" && r.entityType === "expense" && r.actorEmail === "alice@example.test")).toBe(true);
    expect(rows.some((r) => r.channel === "web" && r.entityType === "user" && r.action === "create" && r.actorEmail === "jwtnew@example.test")).toBe(true);
    // Every row has a known entity type (nothing is recorded for account_link_tokens or anything else).
    for (const r of rows) expect(ENTITY_TYPES as readonly string[], `row ${r.id} entityType`).toContain(r.entityType);
    // Secret kinds all represented.
    const kinds = new Set(drive.secrets.map((s) => s.kind.replace(/ \(.*\)$/, "")));
    for (const k of [
      "passwordHash",
      "invite token",
      "account-link token",
      "static client secret",
      "oauth access token",
      "oauth refresh token",
      "oauth auth code",
      "upstream id_token",
      "Access service-token JWT",
      "Access human JWT",
      "Access invite-app JWT",
    ]) {
      expect(kinds, `secret kind ${k} was seeded`).toContain(k);
    }
  });

  it("no secret, its SHA-256 (hex or base64url) or its base64/base64url form appears in any column of any row", async () => {
    const haystacks = rows.map((r) => ({ id: r.id, where: `${r.entityType}.${r.action} (${r.entityLabel})`, text: JSON.stringify(r) }));
    const hits: string[] = [];
    for (const s of drive.secrets) {
      for (const form of await forms(s.value)) {
        for (const h of haystacks) {
          if (h.text.includes(form)) hits.push(`${s.kind} [${form === s.value ? "literal" : "encoded"}] in row ${h.id} ${h.where}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("the specific columns PRD 4.4 names (before, after, changes, metadata, entityLabel, actorName, actorEmail, clientId, requestId) are clean", () => {
    const literal = drive.secrets.map((s) => s.value);
    for (const r of rows) {
      const cells: Record<string, string> = {
        before: JSON.stringify(r.before ?? null),
        after: JSON.stringify(r.after ?? null),
        changes: JSON.stringify(r.changes ?? null),
        metadata: JSON.stringify(r.metadata ?? null),
        entityLabel: r.entityLabel ?? "",
        actorName: r.actorName ?? "",
        actorEmail: r.actorEmail ?? "",
        clientId: r.clientId ?? "",
        requestId: r.requestId ?? "",
      };
      for (const [col, text] of Object.entries(cells)) {
        for (const v of literal) expect(text, `${col} of row ${r.id} (${r.entityType}.${r.action})`).not.toContain(v);
      }
    }
  });

  it("no forbidden key name appears anywhere in the JSON columns, nested objects included", () => {
    const offenders: string[] = [];
    for (const r of rows) {
      for (const col of JSON_COLUMNS) {
        const keys: string[] = [];
        collectKeys(r[col], col, keys);
        for (const k of keys) {
          const leaf = k.split(".").pop()!.replace(/\[\d+\]$/, "");
          if (FORBIDDEN_KEYS.includes(normalizeKey(leaf))) offenders.push(`row ${r.id} (${r.entityType}.${r.action}): ${k}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("invite rows never carry the token, not even in entityLabel, and the user.create / participant.create they trigger are clean too", () => {
    const inviteRows = rows.filter((r) => r.entityType === "invite");
    expect(inviteRows.length).toBeGreaterThanOrEqual(6); // 4 creates, 2+ accepts, 1 delete
    for (const r of inviteRows) {
      for (const t of drive.inviteTokens) {
        expect(r.entityLabel ?? "").not.toContain(t);
        expect(JSON.stringify([r.before, r.after, r.changes, r.metadata])).not.toContain(t);
      }
      for (const col of ["before", "after"] as const) {
        if (r[col]) expect(r[col], `${col} of invite row ${r.id}`).not.toHaveProperty("token");
      }
    }
  });

  it("POST /auth/me/link-token records nothing (TDD 7.5) and no row mentions account_link_tokens", () => {
    expect(drive.linkTokenRowCounts.after).toBe(drive.linkTokenRowCounts.before);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("account_link_tokens");
    expect(text).not.toContain("accountLinkToken");
    expect(text).not.toContain("linkToken");
  });

  it("user rows drop passwordHash from before and after on every action", () => {
    const userRows = rows.filter((r) => r.entityType === "user");
    expect(new Set(userRows.map((r) => r.action))).toEqual(new Set(["create", "update", "delete", "merge"]));
    for (const r of userRows) {
      for (const col of ["before", "after"] as const) {
        const snap = r[col] as Record<string, unknown> | null;
        if (!snap) continue;
        expect(snap, `${col} of ${r.action} row ${r.id}`).not.toHaveProperty("passwordHash");
        expect(snap).not.toHaveProperty("password_hash");
        expect(Object.keys(snap).sort()).toEqual(["avatarUrl", "email", "googleId", "id", "name", "role"].filter((k) => k in snap).sort());
      }
    }
  });
});
