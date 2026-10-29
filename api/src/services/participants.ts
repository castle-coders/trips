/**
 * Participants service (specs/AUDIT_TDD.md 7.2, "participants.*").
 *
 * Writes require Owner on the trip (admins are Owner everywhere) and record exactly one
 * audit event in the same `db.batch` as the data statement. A no-op update writes nothing
 * and returns the stored row.
 */
import type { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Actor, AuthUser } from "../db";
import { participants, trips } from "../db/schema";
import type { CreateParticipantSchema, UpdateParticipantSchema } from "../schemas/participant";
import { requireTripRole, type Db } from "./access";
import { auditInsert } from "./audit";
import { ServiceError } from "./errors";

export type Participant = typeof participants.$inferSelect;
export type CreateParticipant = z.infer<typeof CreateParticipantSchema>;
export type UpdateParticipant = z.infer<typeof UpdateParticipantSchema>;

/** Status messages the participants routes have always returned. */
const MESSAGES = { notFound: "Trip not found", forbidden: "Forbidden" } as const;

/** Every participant row on a trip. Requires Viewer (admins everywhere). */
export async function listParticipants(db: Db, user: AuthUser, tripId: string): Promise<Participant[]> {
  await requireTripRole(db, user, tripId, "Viewer", MESSAGES);
  return db.select().from(participants).where(eq(participants.tripId, tripId));
}

async function findParticipant(db: Db, tripId: string, participantId: string): Promise<Participant> {
  const rows = await db
    .select()
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.tripId, tripId)));
  if (!rows.length) throw new ServiceError("not_found", "Participant not found");
  return rows[0];
}

/** Add a participant. Requires Owner. Records `participant.create`. */
export async function createParticipant(
  db: Db,
  actor: Actor,
  tripId: string,
  input: CreateParticipant
): Promise<Participant> {
  await requireTripRole(db, actor, tripId, "Owner", MESSAGES);
  const trip = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId));
  if (!trip.length) throw new ServiceError("not_found", MESSAGES.notFound);

  const now = new Date().toISOString();
  const row: Participant = {
    id: crypto.randomUUID(),
    tripId,
    userId: input.userId ?? null,
    email: input.email ?? null,
    name: input.name,
    role: input.role,
    traveling: input.traveling ?? false,
    createdAt: now,
    updatedAt: now,
  };
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "participant",
    entityId: row.id,
    action: "create",
    after: row,
  });
  if (!audit) throw new Error("auditInsert returned null for participant.create");

  await db.batch([db.insert(participants).values(row), audit]);
  return row;
}

/**
 * Patch a participant. Requires Owner. Records `participant.update`; when the allow-listed
 * diff is empty nothing is written and the stored row is returned (TDD 7.1, 12).
 */
export async function updateParticipant(
  db: Db,
  actor: Actor,
  tripId: string,
  participantId: string,
  patch: UpdateParticipant
): Promise<Participant> {
  await requireTripRole(db, actor, tripId, "Owner", MESSAGES);
  const before = await findParticipant(db, tripId, participantId);

  const updated: Participant = { ...before, ...patch, updatedAt: new Date().toISOString() };
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "participant",
    entityId: participantId,
    action: "update",
    before,
    after: updated,
  });
  if (!audit) return before;

  await db.batch([db.update(participants).set(updated).where(eq(participants.id, participantId)), audit]);
  return updated;
}

/** Remove a participant. Requires Owner. Records `participant.delete` with the row as `before`. */
export async function deleteParticipant(db: Db, actor: Actor, tripId: string, participantId: string): Promise<void> {
  await requireTripRole(db, actor, tripId, "Owner", MESSAGES);
  const before = await findParticipant(db, tripId, participantId);

  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "participant",
    entityId: participantId,
    action: "delete",
    before,
  });
  if (!audit) throw new Error("auditInsert returned null for participant.delete");

  await db.batch([db.delete(participants).where(eq(participants.id, participantId)), audit]);
}
