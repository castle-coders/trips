import type { z } from "@hono/zod-openapi";
import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import type { AuthUser } from "../db";
import { participants, trips } from "../db/schema";
import type { CreateTripSchema, UpdateTripSchema } from "../schemas/trip";
import { isAdmin, isTripRole, requireTripRole, type Db, type TripRole } from "./access";
import { ServiceError } from "./errors";

export type Trip = typeof trips.$inferSelect;
export type CreateTrip = z.infer<typeof CreateTripSchema>;
export type UpdateTrip = z.infer<typeof UpdateTripSchema>;

export interface ParticipantSummary {
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  role: TripRole;
  traveling: boolean;
}

export interface UpcomingTrip {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  participants: Array<{ name: string; email: string | null; traveling: boolean }>;
}

const toRole = (role: string): TripRole => (isTripRole(role) ? role : "Viewer");

/** Trips the caller can see (admin: all), each with the caller's role. */
export async function listTrips(db: Db, user: AuthUser): Promise<Array<Trip & { role: TripRole }>> {
  if (isAdmin(user)) {
    const rows = await db.select().from(trips);
    return rows.map((t) => ({ ...t, role: "Owner" as TripRole }));
  }
  const rows = await db
    .select({ trips, role: participants.role })
    .from(trips)
    .innerJoin(participants, and(eq(participants.tripId, trips.id), eq(participants.userId, user.id)));
  return rows.map((r) => ({ ...r.trips, role: toRole(r.role) }));
}

/** Next 3 trips (with both dates set) whose end date has not passed, with their participants. */
export async function listUpcomingTrips(db: Db, user: AuthUser): Promise<UpcomingTrip[]> {
  const today = new Date().toISOString().slice(0, 10);
  const datedAndNotPast = and(isNotNull(trips.endDate), isNotNull(trips.startDate), gte(trips.endDate, today));

  const query = isAdmin(user)
    ? db.select({ trips }).from(trips).where(datedAndNotPast)
    : db
        .select({ trips })
        .from(trips)
        .innerJoin(participants, and(eq(participants.tripId, trips.id), eq(participants.userId, user.id)))
        .where(datedAndNotPast);

  const result = await query.orderBy(asc(trips.startDate)).limit(3);
  const tripRows = result.map((r) => r.trips);

  return Promise.all(
    tripRows.map(async (trip) => {
      const tripParticipants = await db
        .select({ name: participants.name, email: participants.email, traveling: participants.traveling })
        .from(participants)
        .where(eq(participants.tripId, trip.id));
      return {
        id: trip.id,
        name: trip.name,
        startDate: trip.startDate!,
        endDate: trip.endDate!,
        participants: tripParticipants,
      };
    })
  );
}

/** A trip the caller is a member of (admin: any), with the caller's role and the participant list. */
export async function getTrip(
  db: Db,
  user: AuthUser,
  tripId: string
): Promise<{ trip: Trip; role: TripRole; participants: ParticipantSummary[] }> {
  const role = await requireTripRole(db, user, tripId, "Viewer");
  const result = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!result.length) throw new ServiceError("not_found", "Trip not found");
  const rows = await db
    .select({
      id: participants.id,
      userId: participants.userId,
      name: participants.name,
      email: participants.email,
      role: participants.role,
      traveling: participants.traveling,
    })
    .from(participants)
    .where(eq(participants.tripId, tripId));
  return { trip: result[0], role, participants: rows.map((p) => ({ ...p, role: toRole(p.role) })) };
}

/**
 * Create a trip and make the caller its Owner participant (MCP_TDD 4.3), in one D1 batch.
 * Global viewers are forbidden (matches requireTripEditor). Returns the bare trip row.
 */
export async function createTrip(db: Db, user: AuthUser, input: CreateTrip): Promise<Trip> {
  if (user.role === "viewer") throw new ServiceError("forbidden", "Forbidden: Viewers cannot create trips");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row: Trip = {
    id,
    name: input.name,
    destination: input.destination ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    description: input.description ?? null,
    splitwiseGroupId: input.splitwiseGroupId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.batch([
    db.insert(trips).values(row),
    db.insert(participants).values({
      id: crypto.randomUUID(),
      tripId: id,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: "Owner",
      traveling: false,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return row;
}

/** Patch a trip. Requires Editor. */
export async function updateTrip(db: Db, user: AuthUser, tripId: string, patch: UpdateTrip): Promise<Trip> {
  await requireTripRole(db, user, tripId, "Editor");
  const existing = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!existing.length) throw new ServiceError("not_found", "Trip not found");
  const updated = {
    ...existing[0],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await db.update(trips).set(updated).where(eq(trips.id, tripId));
  return updated;
}

/** Delete a trip. Requires Owner. */
export async function deleteTrip(db: Db, user: AuthUser, tripId: string): Promise<void> {
  await requireTripRole(db, user, tripId, "Owner", { forbidden: "Forbidden: only trip Owners can delete trips" });
  const existing = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!existing.length) throw new ServiceError("not_found", "Trip not found");
  await db.delete(trips).where(eq(trips.id, tripId));
}
