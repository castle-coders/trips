/**
 * Invites service (specs/AUDIT_TDD.md 7.2, "invites.create / invites.delete / invites.accept").
 *
 * Create and delete require Owner on the trip (admins are Owner everywhere) and record exactly
 * one audit event in the same `db.batch` as the data statement. Accept runs every write the
 * acceptance causes (optional user rename, optional participant insert, invite status) and
 * their events in one batch.
 *
 * The invite `token` never reaches a snapshot: the allow-list drops it, and nothing here puts
 * it in `metadata` either.
 */
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Actor, AuthUser } from "../db";
import { invites, participants, trips, userEmails, users } from "../db/schema";
import { getMembership, hasRole, requireTripRole, type Db } from "./access";
import { auditInsert } from "./audit";
import { ServiceError } from "./errors";

export type Invite = typeof invites.$inferSelect;
export type Participant = typeof participants.$inferSelect;

/** Body of `POST /trips/{tripId}/invites` after validation (the route's CreateInvite schema). */
export interface CreateInvite {
  name: string;
  participantId?: string;
}

type Statement = BatchItem<"sqlite">;

/** Status messages the invites routes have always returned. */
const MESSAGES = { notFound: "Trip not found", forbidden: "Forbidden" } as const;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Every invite row on a trip. Requires Editor or above; admins everywhere. A non-member is
 * `forbidden` (not `not_found`): this preserves the route's historical 403 for outsiders.
 */
export async function listInvites(db: Db, user: AuthUser, tripId: string): Promise<Invite[]> {
  const role = await getMembership(db, user, tripId);
  if (role === null || !hasRole(role, "Editor")) throw new ServiceError("forbidden", MESSAGES.forbidden);
  return db.select().from(invites).where(eq(invites.tripId, tripId));
}

/** Create a pending invite. Requires Owner. Records `invite.create` with the row as `after`. */
export async function createInvite(db: Db, actor: Actor, tripId: string, input: CreateInvite): Promise<Invite> {
  await requireTripRole(db, actor, tripId, "Owner", MESSAGES);
  const trip = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip.length) throw new ServiceError("not_found", MESSAGES.notFound);

  const now = new Date();
  const row: Invite = {
    id: crypto.randomUUID(),
    tripId,
    participantId: input.participantId ?? null,
    email: null,
    name: input.name || null,
    role: "Viewer",
    token: crypto.randomUUID(),
    status: "pending",
    invitedBy: actor.id,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  };
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "invite",
    entityId: row.id,
    action: "create",
    after: row,
  });
  if (!audit) throw new Error("auditInsert returned null for invite.create");

  await db.batch([db.insert(invites).values(row), audit]);
  return row;
}

/** Revoke an invite. Requires Owner. Records `invite.delete` with the row as `before`. */
export async function deleteInvite(db: Db, actor: Actor, tripId: string, inviteId: string): Promise<void> {
  await requireTripRole(db, actor, tripId, "Owner", MESSAGES);
  const rows = await db
    .select()
    .from(invites)
    .where(and(eq(invites.id, inviteId), eq(invites.tripId, tripId)))
    .limit(1);
  if (!rows.length) throw new ServiceError("not_found", "Invite not found");
  const before = rows[0];

  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "invite",
    entityId: inviteId,
    action: "delete",
    before,
  });
  if (!audit) throw new Error("auditInsert returned null for invite.delete");

  await db.batch([db.delete(invites).where(eq(invites.id, inviteId)), audit]);
}

export interface AcceptInviteResult {
  /** The participant row for the accepting user on the trip: inserted now, or the one already there. */
  participant: Participant;
  /** True when the user was already a participant (by user id or any linked email); nothing was inserted. */
  alreadyParticipant: boolean;
  /** The name the user ends up with: the invite's name when set, otherwise the user's current name. */
  resolvedName: string;
}

/**
 * Accept a pending invite as `actor` (the accepting user; the caller has already resolved or
 * created it and checked the invite is pending and unexpired).
 *
 * One `db.batch` holds, in order: `users.name` update (only when the invite names the user
 * differently), participant insert (only when not already a participant), `invites.status`
 * update, then the matching events: `user.update`, `participant.create`, `invite.accept`
 * (`metadata: { participantId, alreadyParticipant }`). Exactly one event per write.
 */
export async function acceptInvite(db: Db, actor: Actor, invite: Invite): Promise<AcceptInviteResult> {
  if (invite.status !== "pending") throw new ServiceError("not_found", "Invite not found");

  const [userRows, existingPart, userEmailRows] = await Promise.all([
    db.select().from(users).where(eq(users.id, actor.id)).limit(1),
    db.select().from(participants).where(eq(participants.tripId, invite.tripId)),
    db.select({ email: userEmails.email }).from(userEmails).where(eq(userEmails.userId, actor.id)),
  ]);
  if (!userRows.length) throw new ServiceError("not_found", "User not found");
  const userBefore = userRows[0];

  const userEmailSet = new Set(userEmailRows.map((e) => e.email));
  const alreadyIn = existingPart.find((p) => p.userId === actor.id || (p.email && userEmailSet.has(p.email)));

  // If the invite has a name, prefer it over the auto-derived name from the email.
  const resolvedName = invite.name || userBefore.name;
  const now = new Date().toISOString();

  const statements: Statement[] = [];
  const events: Statement[] = [];

  if (invite.name && invite.name !== userBefore.name) {
    const userAfter = { ...userBefore, name: resolvedName, updatedAt: now };
    const stmt = db.update(users).set({ name: resolvedName, updatedAt: now }).where(eq(users.id, actor.id));
    const event = auditInsert(db, {
      actor,
      tripId: null,
      entityType: "user",
      entityId: actor.id,
      action: "update",
      before: userBefore,
      after: userAfter,
    });
    statements.push(stmt);
    if (event) events.push(event);
  }

  let participant: Participant;
  if (alreadyIn) {
    participant = alreadyIn;
  } else {
    participant = {
      id: crypto.randomUUID(),
      tripId: invite.tripId,
      userId: actor.id,
      email: actor.email,
      name: resolvedName,
      role: invite.role,
      traveling: false,
      createdAt: now,
      updatedAt: now,
    };
    const event = auditInsert(db, {
      actor,
      tripId: invite.tripId,
      entityType: "participant",
      entityId: participant.id,
      action: "create",
      after: participant,
    });
    if (!event) throw new Error("auditInsert returned null for participant.create");
    statements.push(db.insert(participants).values(participant));
    events.push(event);
  }

  const inviteAfter: Invite = { ...invite, status: "accepted" };
  const acceptEvent = auditInsert(db, {
    actor,
    tripId: invite.tripId,
    entityType: "invite",
    entityId: invite.id,
    action: "accept",
    before: invite,
    after: inviteAfter,
    metadata: { participantId: participant.id, alreadyParticipant: Boolean(alreadyIn) },
  });
  if (!acceptEvent) throw new Error("auditInsert returned null for invite.accept");
  statements.push(db.update(invites).set({ status: "accepted" }).where(eq(invites.id, invite.id)));
  events.push(acceptEvent);

  const batch = [...statements, ...events];
  await db.batch(batch as [Statement, ...Statement[]]);

  return { participant, alreadyParticipant: Boolean(alreadyIn), resolvedName };
}
