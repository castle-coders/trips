// Unit coverage for services/access.ts (requireTripRole, getMembership) and services/errors.ts.
import { describe, expect, it } from "vitest";
import type { AuthUser } from "../src/db";
import { getMembership, hasRole, requireTripRole, type TripRole } from "../src/services/access";
import { ServiceError, serviceErrorBody } from "../src/services/errors";
import { addParticipant, seedTrip, seedUser, testDb } from "./helpers";

const asAuth = (u: { id: string; email: string; name: string; role: string }): AuthUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
});

async function expectServiceError(p: Promise<unknown>, code: string, message: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  expect((err as ServiceError).message).toBe(message);
}

describe("hasRole", () => {
  it("ranks Viewer < Editor < Owner", () => {
    const roles: TripRole[] = ["Viewer", "Editor", "Owner"];
    for (const [i, r] of roles.entries())
      for (const [j, m] of roles.entries()) expect(hasRole(r, m)).toBe(i >= j);
  });
});

describe("requireTripRole / getMembership", () => {
  it("admin is Owner everywhere, including trips that do not exist", async () => {
    const admin = asAuth(await seedUser("admin@example.test", "admin"));
    const { trip } = await seedTrip(null);
    const db = testDb();
    expect(await requireTripRole(db, admin, trip.id, "Owner")).toBe("Owner");
    const missing = crypto.randomUUID();
    expect(await requireTripRole(db, admin, missing, "Owner")).toBe("Owner");
    expect(await getMembership(db, admin, missing)).toBe("Owner");
  });

  it("non-member gets not_found (never Viewer), with default and custom messages", async () => {
    const owner = await seedUser("owner@example.test", "editor");
    const stranger = asAuth(await seedUser("stranger@example.test", "editor"));
    const { trip } = await seedTrip(owner.id);
    const db = testDb();
    expect(await getMembership(db, stranger, trip.id)).toBeNull();
    await expectServiceError(requireTripRole(db, stranger, trip.id, "Viewer"), "not_found", "Trip not found");
    await expectServiceError(
      requireTripRole(db, stranger, trip.id, "Viewer", { notFound: "Not found" }),
      "not_found",
      "Not found"
    );
    // missing trip, non-admin
    await expectServiceError(requireTripRole(db, stranger, crypto.randomUUID(), "Viewer"), "not_found", "Trip not found");
  });

  it("member below min gets forbidden; at or above min returns the role", async () => {
    const owner = asAuth(await seedUser("owner@example.test", "editor"));
    const editor = asAuth(await seedUser("editor@example.test", "editor"));
    const viewer = asAuth(await seedUser("viewer@example.test", "viewer"));
    const { trip } = await seedTrip(owner.id);
    await addParticipant(trip.id, editor.id, "Editor");
    await addParticipant(trip.id, viewer.id, "Viewer");
    const db = testDb();

    expect(await requireTripRole(db, owner, trip.id, "Owner")).toBe("Owner");
    expect(await requireTripRole(db, editor, trip.id, "Editor")).toBe("Editor");
    expect(await requireTripRole(db, viewer, trip.id, "Viewer")).toBe("Viewer");
    expect(await getMembership(db, viewer, trip.id)).toBe("Viewer");

    await expectServiceError(requireTripRole(db, viewer, trip.id, "Editor"), "forbidden", "Forbidden");
    await expectServiceError(
      requireTripRole(db, editor, trip.id, "Owner", { forbidden: "Forbidden: only trip Owners can delete trips" }),
      "forbidden",
      "Forbidden: only trip Owners can delete trips"
    );
  });
});

describe("serviceErrorBody", () => {
  it("is { error } without details and { error, details } with", () => {
    expect(serviceErrorBody(new ServiceError("not_found", "Trip not found"))).toEqual({ error: "Trip not found" });
    const details = { fieldErrors: { x: ["bad"] }, formErrors: [] };
    expect(serviceErrorBody(new ServiceError("validation", "Invalid content for type", details))).toStrictEqual({
      error: "Invalid content for type",
      details,
    });
  });
});
