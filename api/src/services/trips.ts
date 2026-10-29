import type { z } from "@hono/zod-openapi";
import { and, asc, count, eq, gte, isNotNull } from "drizzle-orm";
import type { Actor, AuthUser } from "../db";
import { documents, expenses, invites, itineraries, participants, trips } from "../db/schema";
import type { CreateTripSchema, UpdateTripSchema } from "../schemas/trip";
import { isAdmin, isTripRole, requireTripRole, type Db, type TripRole } from "./access";
import { auditInsert } from "./audit";
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
 * Create a trip and make the caller its Owner participant (MCP_TDD 4.3), in one D1 batch
 * with the `trip.create` event (AUDIT_TDD 7.2: the event covers the owner row via
 * `metadata.ownerParticipantId`; no separate `participant.create`).
 * Global viewers are forbidden (matches requireTripEditor). Returns the bare trip row.
 */
export async function createTrip(db: Db, actor: Actor, input: CreateTrip): Promise<Trip> {
  if (actor.role === "viewer") throw new ServiceError("forbidden", "Forbidden: Viewers cannot create trips");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const ownerParticipantId = crypto.randomUUID();
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
  const audit = auditInsert(db, {
    actor,
    tripId: id,
    entityType: "trip",
    entityId: id,
    action: "create",
    after: row,
    metadata: { ownerParticipantId },
  });
  if (!audit) throw new Error("auditInsert returned null for trip.create");
  await db.batch([
    db.insert(trips).values(row),
    db.insert(participants).values({
      id: ownerParticipantId,
      tripId: id,
      userId: actor.id,
      email: actor.email,
      name: actor.name,
      role: "Owner",
      traveling: false,
      createdAt: now,
      updatedAt: now,
    }),
    audit,
  ]);
  return row;
}

/**
 * Patch a trip. Requires Editor. Records `trip.update` in the same batch as the UPDATE.
 * When the allow-listed diff is empty (AUDIT_TDD 7.1 / 12), nothing is written and the stored
 * row is returned with `updatedAt` untouched. That is safe here only because every column
 * `UpdateTrip` can set is in the trip snapshot allow-list.
 */
export async function updateTrip(db: Db, actor: Actor, tripId: string, patch: UpdateTrip): Promise<Trip> {
  await requireTripRole(db, actor, tripId, "Editor");
  const existing = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!existing.length) throw new ServiceError("not_found", "Trip not found");
  const before = existing[0];
  const updated: Trip = {
    ...before,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "trip",
    entityId: tripId,
    action: "update",
    before,
    after: updated,
  });
  if (!audit) return before;
  await db.batch([db.update(trips).set(updated).where(eq(trips.id, tripId)), audit]);
  return updated;
}

/**
 * Delete a trip. Requires Owner. Children cascade in the database and get no events of their
 * own; their counts are read before the batch into the `trip.delete` metadata (AUDIT_TDD 7.2).
 */
export async function deleteTrip(db: Db, actor: Actor, tripId: string): Promise<void> {
  await requireTripRole(db, actor, tripId, "Owner", { forbidden: "Forbidden: only trip Owners can delete trips" });
  const existing = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!existing.length) throw new ServiceError("not_found", "Trip not found");
  const before = existing[0];

  const [its, exps, ps, docs, invs] = await db.batch([
    db.select({ n: count() }).from(itineraries).where(eq(itineraries.tripId, tripId)),
    db.select({ n: count() }).from(expenses).where(eq(expenses.tripId, tripId)),
    db.select({ n: count() }).from(participants).where(eq(participants.tripId, tripId)),
    db.select({ n: count() }).from(documents).where(eq(documents.tripId, tripId)),
    db.select({ n: count() }).from(invites).where(eq(invites.tripId, tripId)),
  ]);

  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "trip",
    entityId: tripId,
    action: "delete",
    before,
    metadata: {
      itineraries: its[0].n,
      expenses: exps[0].n,
      participants: ps[0].n,
      documents: docs[0].n,
      invites: invs[0].n,
    },
  });
  if (!audit) throw new Error("auditInsert returned null for trip.delete");
  await db.batch([db.delete(trips).where(eq(trips.id, tripId)), audit]);
}
