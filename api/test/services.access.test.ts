// services/access.ts gaps not covered by test/access.test.ts: the rank table, role parsing,
// unknown stored roles, and that membership is keyed on participants.user_id only.
import { describe, expect, it } from "vitest";
import { ROLE_RANK, getMembership, hasRole, isAdmin, isTripRole, requireTripRole } from "../src/services/access";
import { addParticipant, expectServiceError, seedTrip, seedUser, testDb, toAuth } from "./helpers";

describe("role ranking", () => {
  it("ROLE_RANK is strictly increasing Viewer < Editor < Owner", () => {
    expect(ROLE_RANK.Viewer).toBeLessThan(ROLE_RANK.Editor);
    expect(ROLE_RANK.Editor).toBeLessThan(ROLE_RANK.Owner);
    expect(Object.keys(ROLE_RANK).sort()).toEqual(["Editor", "Owner", "Viewer"]);
  });

  it("hasRole is reflexive and Owner satisfies every minimum", () => {
    for (const r of ["Viewer", "Editor", "Owner"] as const) {
      expect(hasRole(r, r)).toBe(true);
      expect(hasRole("Owner", r)).toBe(true);
    }
    expect(hasRole("Viewer", "Editor")).toBe(false);
    expect(hasRole("Editor", "Owner")).toBe(false);
  });

  it("isTripRole accepts only the exact three role strings", () => {
    for (const ok of ["Owner", "Editor", "Viewer"]) expect(isTripRole(ok)).toBe(true);
    for (const bad of ["owner", "EDITOR", "admin", "", " Viewer", null, undefined, 1, {}]) expect(isTripRole(bad)).toBe(false);
  });

  it("isAdmin is the global 'admin' role only", () => {
    const base = { id: "u", email: "u@example.test", name: "u" };
    expect(isAdmin({ ...base, role: "admin" })).toBe(true);
    for (const role of ["editor", "viewer", "Admin", "Owner", ""]) expect(isAdmin({ ...base, role })).toBe(false);
  });
});

describe("membership resolution", () => {
  it("an unknown stored participant role resolves to Viewer and cannot write", async () => {
    const owner = await seedUser("owner@example.test", "editor");
    const odd = toAuth(await seedUser("odd@example.test", "editor"));
    const { trip } = await seedTrip(owner.id);
    // Bypass the TripRole type: a legacy or hand-edited row.
    await addParticipant(trip.id, odd.id, "owner" as never);
    const db = testDb();
    expect(await getMembership(db, odd, trip.id)).toBe("Viewer");
    expect(await requireTripRole(db, odd, trip.id, "Viewer")).toBe("Viewer");
    await expectServiceError(requireTripRole(db, odd, trip.id, "Editor"), "forbidden", "Forbidden");
  });

  it("the trip role governs, not the global role (global viewer who is trip Editor passes Editor; global editor who is trip Viewer does not)", async () => {
    const gViewer = toAuth(await seedUser("gviewer@example.test", "viewer"));
    const gEditor = toAuth(await seedUser("geditor@example.test", "editor"));
    const { trip } = await seedTrip(null);
    await addParticipant(trip.id, gViewer.id, "Editor");
    await addParticipant(trip.id, gEditor.id, "Viewer");
    const db = testDb();
    expect(await requireTripRole(db, gViewer, trip.id, "Editor")).toBe("Editor");
    await expectServiceError(requireTripRole(db, gEditor, trip.id, "Editor"), "forbidden");
  });

  it("a participant row matching only by email (user_id null) is not membership", async () => {
    const u = toAuth(await seedUser("byemail@example.test", "editor"));
    const { trip } = await seedTrip(null);
    await addParticipant(trip.id, null, "Owner", { name: "Email Only", email: u.email });
    expect(await getMembership(testDb(), u, trip.id)).toBeNull();
    await expectServiceError(requireTripRole(testDb(), u, trip.id, "Viewer"), "not_found", "Trip not found");
  });

  it("membership on one trip says nothing about another", async () => {
    const u = toAuth(await seedUser("member@example.test", "editor"));
    const { trip: a } = await seedTrip(u.id);
    const { trip: b } = await seedTrip(null);
    expect(await getMembership(testDb(), u, a.id)).toBe("Owner");
    expect(await getMembership(testDb(), u, b.id)).toBeNull();
  });
});
