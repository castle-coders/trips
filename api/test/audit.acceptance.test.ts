// specs/AUDIT_PRD.md section 10 (Acceptance Criteria), one named test per criterion that is
// phrased end to end, each driven through the real Worker export. Criteria that are already
// proven in full elsewhere are referenced rather than duplicated; the mapping table lives in
// specs/AUDIT_TDD.md 11.1.
//
//   AC1  web itinerary PUT            here (real Access JWT so the channel is `web`, not `dev`)
//   AC2  same over MCP Stage 2        here (brief), full proof in mcp.audit.test.ts
//                                      "PRD acceptance 2: a flight departure-time change over Stage 2 ..."
//   AC3  no-op PUT                     here (REST), service level in services.itineraries.test.ts
//   AC4  delete trip + /admin/audit    here
//   AC5  delete / merge a user         here
//   AC6  Viewer 403                    here (API half); the UI half is manual
//   AC7  non-member 404, non-admin 403 here
//   AC8  batch failure rolls back      audit.atomicity.test.ts (service seam; no REST-level seam exists)
//   AC9  append-only grep              CI only: api/scripts/check-audit-append-only.sh, run by the
//                                      "Check audit_events is append-only" step in
//                                      .github/workflows/deploy-api.yml. Tests run in workerd and
//                                      cannot read the source tree or spawn a shell.
//   AC10 Activity tab                  API half in audit.routes.test.ts (newest first, cursor walk);
//                                      the UI half is manual
//   AC11 no secrets in audit_events    audit.secrets.test.ts
//
// All emails, hosts, ids and secrets here are obviously fake test values (example.test).
import { eq } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documents, invites, itineraries, trips, users } from "../src/db/schema";
import { AuditEventSchema, AuditPageSchema } from "../src/schemas/audit";
import { IDS, IT, flightContent, read, seedExpense, seedItineraries, seedRoleWorld, testDb, type RoleWorld } from "./helpers";
import { auditRows, type AuditRow } from "./helpers/audit";
import { MAIN_ORIGIN, mcpRpc, send, signIn, stage2Env } from "./helpers/oauth";

afterEach(() => vi.restoreAllMocks());

let w: RoleWorld;

const TRIP_AUDIT = `/api/trips/${IDS.trip}/audit`;
const ADMIN_AUDIT = "/api/admin/audit";
const entityAudit = (entityType: string, entityId: string, tripId: string = IDS.trip) => `/api/trips/${tripId}/audit/${entityType}/${entityId}`;

const LEG_TIME = "2030-01-10T09:00"; // flightContent() default for legs[0].departureTime
const NEW_LEG_TIME = "2030-01-10T09:45";
const LEG_PATH = "content.legs[0].departureTime";

/** flightContent() with only legs[0].departureTime moved; everything else byte-identical. */
function movedFlight(participantId: string) {
  const content = flightContent(participantId);
  content.legs[0] = { ...content.legs[0], departureTime: NEW_LEG_TIME };
  return content;
}

/** Actor columns an event must carry for the seeded user (PRD 6.2). */
const actorOf = (u: { id: string; name: string; email: string; role: string }) => ({
  actorUserId: u.id,
  actorName: u.name,
  actorEmail: u.email,
  actorRole: u.role,
});

async function storedItinerary(id: string) {
  const [row] = await testDb().select().from(itineraries).where(eq(itineraries.id, id));
  return row;
}

/** GET a page as `fetch`, assert 200 and that it parses as an AuditPage; return the raw body. */
async function page(fetch: RoleWorld["as"][keyof RoleWorld["as"]], url: string) {
  const r = await read(await fetch.get(url));
  expect(r.status, `${url} -> ${JSON.stringify(r.body)}`).toBe(200);
  const parsed = AuditPageSchema.safeParse(r.body);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  return r.body as { events: Record<string, unknown>[]; nextCursor: string | null };
}

// --- Cloudflare Access JWT (the web app's real session; same technique as audit.secrets.test.ts) --
// authMiddleware verifies Cf-Access-Jwt-Assertion against https://<team>/cdn-cgi/access/certs via
// jose's createRemoteJWKSet (global fetch), so the test answers that URL with a local RS256 key.
// DEV_MODE is off in that env, so only the JWT authenticates and the channel is `web`.
const FAKE_TEAM_DOMAIN = "fake-team.access.example.test";
const FAKE_AUDIENCE = "fake-access-audience-tag-acceptance-0000";
const FAKE_CERTS_URL = `https://${FAKE_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const accessKeys = await generateKeyPair("RS256");
const ACCESS_JWK = { ...(await exportJWK(accessKeys.publicKey)), kid: "fake-access-kid-acceptance", alg: "RS256", use: "sig" };

function stubAccessCerts(): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === FAKE_CERTS_URL) return Response.json({ keys: [ACCESS_JWK] });
    return real(input, init);
  });
}

function accessJwt(email: string, name: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: `fake-human-sub-${email}`, email, name })
    .setProtectedHeader({ alg: "RS256", kid: ACCESS_JWK.kid })
    .setIssuer(`https://${FAKE_TEAM_DOMAIN}`)
    .setAudience(FAKE_AUDIENCE)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 300)
    .sign(accessKeys.privateKey);
}

const accessEnv = () => stage2Env({ CF_ACCESS_TEAM_DOMAIN: FAKE_TEAM_DOMAIN, CF_ACCESS_AUDIENCE: FAKE_AUDIENCE, DEV_MODE: "" });

/** Main-host request authenticated only by the Access JWT (no DEV header), as the web app sends it. */
function asWeb(jwt: string, path: string, init: RequestInit = {}, ray = "ray-acceptance-web"): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", jwt);
  headers.set("cf-ray", ray);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return send(new Request(`${MAIN_ORIGIN}/api${path}`, { ...init, headers }), accessEnv());
}

beforeEach(async () => {
  w = await seedRoleWorld();
  await seedItineraries(w);
});

describe("PRD 10 acceptance", () => {
  it("AC1: web itinerary PUT changing a departure time records one itinerary.update by the user, channel web, changes exactly the leg path", async () => {
    stubAccessCerts();
    const jwt = await accessJwt(w.users.editor.email, "Editor Access");
    const p = w.participants.editor.id;

    const res = await asWeb(jwt, `/trips/${IDS.trip}/itineraries/${IT.flight}`, { method: "PUT", body: JSON.stringify({ content: movedFlight(p)}) }, "ray-ac1-0001");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as any).content.legs[0].departureTime).toBe(NEW_LEG_TIME);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const [e] = rows;
    expect(e).toMatchObject({
      ...actorOf(w.users.editor),
      channel: "web",
      clientId: null,
      requestId: "ray-ac1-0001",
      tripId: IDS.trip,
      entityType: "itinerary",
      entityId: IT.flight,
      action: "update",
    });
    expect(e.changes).toEqual({ [LEG_PATH]: { from: LEG_TIME, to: NEW_LEG_TIME } });
    expect((e.before as any).content.legs[0].departureTime).toBe(LEG_TIME);
    expect((e.after as any).content.legs[0].departureTime).toBe(NEW_LEG_TIME);

    // The same event is what the trip's Activity feed and the item's History get back.
    for (const url of [TRIP_AUDIT, entityAudit("itinerary", IT.flight)]) {
      const body = await page(w.as.editor, url);
      expect(body.events.map((x) => x.id)).toEqual([e.id]);
      expect(body.events[0]).toMatchObject({ actorName: w.users.editor.name, actorEmail: w.users.editor.email, channel: "web", action: "update", changes: e.changes });
      expect(body.events[0]).not.toHaveProperty("requestId");
    }
  });

  it("AC2: the same update over MCP Stage 2 is identical except channel mcp_oauth and clientId, attributed to the human user", async () => {
    const p = w.participants.editor.id;
    const { clientId, tokens } = await signIn(w.users.editor.email, { ticked: ["trips:read", "trips:write"] });
    const before = await auditRows(); // sign-in may record OAuth administration events; exclude them

    const r = await mcpRpc(
      tokens.access_token,
      "tools/call",
      { name: "update_itinerary", arguments: { tripId: IDS.trip, itineraryId: IT.flight, content: movedFlight(p) } },
      { headers: { "cf-ray": "ray-ac2-0001" } },
    );
    expect(r.status, r.raw).toBe(200);
    expect(r.message?.error, r.raw).toBeUndefined();
    expect(r.message.result.isError, r.raw).not.toBe(true);

    const last = before.length ? before[before.length - 1].seq : -1;
    const added = (await auditRows()).filter((x) => x.seq > last);
    expect(added).toHaveLength(1);
    const [e] = added;
    expect(e).toMatchObject({
      ...actorOf(w.users.editor),
      channel: "mcp_oauth",
      clientId,
      requestId: "ray-ac2-0001",
      tripId: IDS.trip,
      entityType: "itinerary",
      entityId: IT.flight,
      action: "update",
    });
    expect(clientId).toBeTruthy();
    expect(e.changes).toEqual({ [LEG_PATH]: { from: LEG_TIME, to: NEW_LEG_TIME } });
    // The bearer token itself is never stored.
    expect(JSON.stringify(added)).not.toContain(tokens.access_token);
    // Full side-by-side comparison with the REST event: mcp.audit.test.ts "PRD acceptance 2".
  });

  it("AC3: a PUT that re-sends every field unchanged records no event and leaves updatedAt alone", async () => {
    const before = await storedItinerary(IT.flight);
    const body = {
      type: before.type,
      status: before.status,
      content: before.content,
      confirmationNumber: before.confirmationNumber,
      totalCost: before.totalCost,
      currency: before.currency,
      notes: before.notes,
    };
    const r = await read(await w.as.editor.put(`/api/trips/${IDS.trip}/itineraries/${IT.flight}`, body));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual(JSON.parse(JSON.stringify(before)));
    expect(r.body.updatedAt).toBe(before.updatedAt);

    const after = await storedItinerary(IT.flight);
    expect(after).toEqual(before);
    expect(await auditRows()).toEqual([]);
    expect((await page(w.as.editor, TRIP_AUDIT)).events).toEqual([]);
  });

  it("AC4: deleting a trip records one trip.delete with the full snapshot and child counts, readable via /admin/audit afterwards", async () => {
    // Children beyond the five seeded itineraries and four participants.
    const ts = new Date().toISOString();
    await seedExpense(IDS.trip, { payerId: IDS.editorP });
    await seedExpense(IDS.trip);
    await testDb().insert(documents).values({ id: crypto.randomUUID(), tripId: IDS.trip, reservationId: null, fileUrl: "https://files.example.test/fake.pdf", documentType: "Other", name: "Fake Doc", createdAt: ts, updatedAt: ts });
    await testDb().insert(invites).values({ id: crypto.randomUUID(), tripId: IDS.trip, email: "invitee@example.test", name: "Invitee", role: "Viewer", token: "fake-invite-token-ac4", status: "pending", participantId: null, invitedBy: IDS.owner, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: ts });
    const expectedCounts = { itineraries: 5, expenses: 2, participants: 4, documents: 1, invites: 1 };

    const del = await w.as.owner.delete(`/api/trips/${IDS.trip}`, { headers: { "cf-ray": "ray-ac4-0001" } });
    expect(del.status, await del.clone().text()).toBe(204);
    expect(await testDb().select().from(trips).where(eq(trips.id, IDS.trip))).toEqual([]);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const [e] = rows;
    expect(e).toMatchObject({
      ...actorOf(w.users.owner),
      channel: "dev",
      requestId: "ray-ac4-0001",
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      entityLabel: w.trip.name,
      action: "delete",
      after: null,
      changes: null,
      metadata: expectedCounts,
    });
    const { createdAt: _c, updatedAt: _u, ...snapshot } = w.trip;
    expect(e.before).toEqual(snapshot);

    // Still readable after the trip row is gone: /admin/audit?tripId= (with requestId) ...
    const admin = await page(w.as.admin, `${ADMIN_AUDIT}?tripId=${IDS.trip}`);
    expect(admin.events.map((x) => x.id)).toEqual([e.id]);
    expect(admin.events[0]).toMatchObject({ action: "delete", entityType: "trip", requestId: "ray-ac4-0001", metadata: expectedCounts, before: snapshot });
    // ... and, for admins only, through the trip endpoint (PRD 6.5 as amended at Phase 2).
    expect((await page(w.as.admin, TRIP_AUDIT)).events.map((x) => x.id)).toEqual([e.id]);
    // The former Owner's participant row cascaded away, so they are a non-member now: 404.
    expect((await w.as.owner.get(TRIP_AUDIT)).status).toBe(404);
  });

  it("AC5: deleting and merging users leaves their earlier events intact with actorName and actorEmail populated", async () => {
    const p = w.participants.editor.id;
    // Two earlier events: one by the editor (to be deleted), one by the outsider (to be merged away).
    const e1 = await w.as.editor.put(`/api/trips/${IDS.trip}/itineraries/${IT.flight}`, { content: movedFlight(p) });
    expect(e1.status, await e1.clone().text()).toBe(200);
    const e2 = await w.as.outsider.put(`/api/trips/${IDS.otherTrip}/itineraries/${IT.otherTripActivity}`, { notes: "outsider was here" });
    expect(e2.status, await e2.clone().text()).toBe(200);
    const earlier = await auditRows();
    expect(earlier.map((x) => [x.actorUserId, x.actorName, x.actorEmail])).toEqual([
      [w.users.editor.id, w.users.editor.name, w.users.editor.email],
      [w.users.outsider.id, w.users.outsider.name, w.users.outsider.email],
    ]);

    const del = await w.as.admin.delete(`/api/admin/users/${w.users.editor.id}`);
    expect(del.status, await del.clone().text()).toBe(204);
    const merge = await read(await w.as.admin.post("/api/admin/users/merge", { keepUserId: w.users.owner.id, mergeUserId: w.users.outsider.id }));
    expect(merge.status, JSON.stringify(merge.body)).toBe(200);
    expect(await testDb().select().from(users).where(eq(users.id, w.users.editor.id))).toEqual([]);
    expect(await testDb().select().from(users).where(eq(users.id, w.users.outsider.id))).toEqual([]);

    const now = await auditRows();
    // The two earlier rows are byte-identical (append-only; nothing cascaded or rewrote them).
    expect(now.slice(0, 2)).toEqual(earlier);
    const byId = new Map(now.map((x) => [x.id, x]));
    for (const old of earlier) {
      const still = byId.get(old.id) as AuditRow;
      expect(still.actorUserId).toBe(old.actorUserId);
      expect(still.actorName).toBe(old.actorName);
      expect(still.actorEmail).toBe(old.actorEmail);
      expect(still.actorName.length).toBeGreaterThan(0);
      expect(still.actorEmail.length).toBeGreaterThan(0);
    }
    // The administration events themselves were recorded, by the admin.
    const adminEvents = now.slice(2).map((x) => `${x.entityType}.${x.action}`);
    expect(adminEvents).toContain("user.delete");
    expect(adminEvents).toContain("user.merge");
    expect(now.slice(2).every((x) => x.actorUserId === w.users.admin.id)).toBe(true);

    // And the readers still show the deleted / merged users by name on their events.
    const feed = await page(w.as.admin, `${ADMIN_AUDIT}?entityType=itinerary`);
    expect(feed.events.map((x) => [x.actorUserId, x.actorName, x.actorEmail])).toEqual([
      [w.users.outsider.id, w.users.outsider.name, w.users.outsider.email],
      [w.users.editor.id, w.users.editor.name, w.users.editor.email],
    ]);
    const item = await page(w.as.owner, entityAudit("itinerary", IT.flight));
    expect(item.events).toHaveLength(1);
    expect(item.events[0]).toMatchObject({ actorUserId: w.users.editor.id, actorName: w.users.editor.name, actorEmail: w.users.editor.email });
  });

  it("AC6: a Viewer on the trip gets 403 from the trip feed and the per-item history (the UI half, no Activity tab or History affordance, is manual)", async () => {
    // Something to hide, so a leak would be visible.
    const r = await w.as.editor.put(`/api/trips/${IDS.trip}/itineraries/${IT.flight}`, { content: movedFlight(w.participants.editor.id) });
    expect(r.status).toBe(200);
    for (const url of [TRIP_AUDIT, entityAudit("itinerary", IT.flight)]) {
      const res = await read(await w.as.viewer.get(url));
      expect(res.status, url).toBe(403);
      expect(res.body).toEqual({ error: expect.any(String) });
      expect(res.body).not.toHaveProperty("events");
    }
    // Control: the Editor sees the one event through both.
    for (const url of [TRIP_AUDIT, entityAudit("itinerary", IT.flight)]) expect((await page(w.as.editor, url)).events).toHaveLength(1);
  });

  it("AC7: a non-member gets 404 from the trip feed and per-item history; every non-admin gets 403 from /admin/audit", async () => {
    for (const url of [TRIP_AUDIT, entityAudit("itinerary", IT.flight)]) {
      const res = await read(await w.as.outsider.get(url));
      expect(res.status, url).toBe(404);
      expect(res.body).not.toHaveProperty("events");
    }
    for (const who of ["owner", "editor", "viewer", "outsider"] as const) {
      const res = await read(await w.as[who].get(ADMIN_AUDIT));
      expect(res.status, who).toBe(403);
      expect(res.body).not.toHaveProperty("events");
    }
    // Controls: the admin reads /admin/audit; the Owner reads their own trip.
    expect((await w.as.admin.get(ADMIN_AUDIT)).status).toBe(200);
    expect((await w.as.owner.get(TRIP_AUDIT)).status).toBe(200);
  });

  // AC8  audit.atomicity.test.ts: every create/update/delete against a db whose batch() rejects
  //      leaves every table, audit_events included, byte-identical; plus two D1-level proofs.
  // AC9  CI only: api/scripts/check-audit-append-only.sh (deploy-api.yml step "Check audit_events
  //      is append-only"). services.audit.test.ts "the service module exports no update or delete
  //      function for audit rows" covers the "no route exposes such an operation" half in-process.
  // AC10 audit.routes.test.ts "pagination": "limit=30 walks 5 pages with no duplicates or gaps,
  //      newest first throughout, last page nextCursor null". The Activity tab rendering and the
  //      MCP "via <client>" label are manual (see TDD 11.1).
  // AC11 audit.secrets.test.ts.

  it("every event the criteria above produced parses with the public AuditEventSchema", async () => {
    await w.as.editor.put(`/api/trips/${IDS.trip}/itineraries/${IT.flight}`, { content: movedFlight(w.participants.editor.id) });
    const body = await page(w.as.admin, ADMIN_AUDIT);
    expect(body.events).toHaveLength(1);
    expect(AuditEventSchema.safeParse(body.events[0]).success).toBe(true);
  });
});
