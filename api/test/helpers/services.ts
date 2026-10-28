// Shared helpers for test/services.*.test.ts (direct service-layer calls, no HTTP).
import { expect } from "vitest";
import type { AuthUser } from "../../src/db";
import { expenses, itineraries, participants, trips } from "../../src/db/schema";
import { ServiceError, type ServiceErrorCode } from "../../src/services/errors";
import { testDb } from "./db";

/** AuthUser as the auth middleware would build it from a users row. */
export const toAuth = (u: { id: string; email: string; name: string; role: string }): AuthUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
});

/** Resolve a promise to its rejection value, or null when it fulfils. */
export async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e
  );
}

/** Assert a promise rejects with a ServiceError of `code` (and `message`, when given). */
export async function expectServiceError(p: Promise<unknown>, code: ServiceErrorCode, message?: string) {
  const err = await errorOf(p);
  expect(err, `expected ServiceError(${code})`).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  if (message !== undefined) expect((err as ServiceError).message).toBe(message);
  return err as ServiceError;
}

/** Full snapshot of the mutable tables, for "nothing was written" assertions. */
export async function dbState() {
  const db = testDb();
  const sortById = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return {
    trips: sortById(await db.select().from(trips)),
    participants: sortById(await db.select().from(participants)),
    itineraries: sortById(await db.select().from(itineraries)),
    expenses: sortById(await db.select().from(expenses)),
  };
}
