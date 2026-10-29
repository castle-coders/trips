/**
 * Account merge (specs/AUDIT_TDD.md 7.3, "Merge").
 *
 * Read-then-batch: both users, both participant lists and the merged user's emails are read
 * first, every decision is computed, then all updates/deletes and the single `user.merge`
 * event run in one `db.batch`. D1 has no BEGIN/COMMIT, but a batch is atomic, so the merge
 * either fully happens with its audit row or not at all.
 *
 * The end state is the same as the former sequential version: emails move (non-primary),
 * participants on shared trips are deduplicated (keep the higher trip role, repoint expenses,
 * delete the duplicate) and the rest are transferred, authored invites and service identities
 * move, the keep user's global role is optionally promoted, and the merged user is deleted
 * (cascading anything left, e.g. account_link_tokens).
 */
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Actor, getDb } from "../db";
import {
  users,
  userEmails,
  participants,
  expenses,
  invites,
  serviceIdentities,
} from "../db/schema";
import { auditInsert } from "../services/audit";
import { ServiceError } from "../services/errors";

const ROLE_RANK: Record<string, number> = {
  admin: 3,
  editor: 2,
  viewer: 1,
};

const TRIP_ROLE_RANK: Record<string, number> = {
  Owner: 3,
  Editor: 2,
  Viewer: 1,
};

export interface MergeOptions {
  /** Whether to promote the keep user's global role if the merge user has a higher one. Default: true */
  promoteRole?: boolean;
}

/** What the merge did, as stored in the `user.merge` event's metadata. */
export interface MergeResult {
  mergedUserId: string;
  mergedEmail: string;
  /** user_emails rows moved from the merged user to the keep user. */
  movedEmails: number;
  /** Participant rows re-pointed at the keep user (trips the keep user was not on). */
  movedParticipants: number;
  /** Trips both users were on: the merged user's participant row was removed. */
  dedupedTrips: number;
  /** The keep user's new global role, or null when it was not promoted. */
  promotedRole: string | null;
}

type Db = ReturnType<typeof getDb>;
type Statement = BatchItem<"sqlite">;

/**
 * Merge `mergeUserId` into `keepUserId` as `actor` (the admin, or the linking user in the
 * self-service flows). `not_found` ("Keep user not found" / "Merge user not found") when
 * either is missing. Merging a user with themselves is a no-op that records nothing.
 */
export async function mergeAccountsD1(
  db: Db,
  actor: Actor,
  keepUserId: string,
  mergeUserId: string,
  options: MergeOptions = {}
): Promise<MergeResult | null> {
  const { promoteRole = true } = options;

  if (keepUserId === mergeUserId) return null;

  // --- Reads ---
  const [keepRows, mergeRows] = await Promise.all([
    db.select().from(users).where(eq(users.id, keepUserId)).limit(1),
    db.select().from(users).where(eq(users.id, mergeUserId)).limit(1),
  ]);
  if (!keepRows.length) throw new ServiceError("not_found", "Keep user not found");
  if (!mergeRows.length) throw new ServiceError("not_found", "Merge user not found");

  const keepUser = keepRows[0];
  const mergeUser = mergeRows[0];

  const [keepParts, mergeParts, mergeEmails] = await Promise.all([
    db.select().from(participants).where(eq(participants.userId, keepUserId)),
    db.select().from(participants).where(eq(participants.userId, mergeUserId)),
    db.select({ id: userEmails.id }).from(userEmails).where(eq(userEmails.userId, mergeUserId)),
  ]);

  // --- Decisions ---
  const statements: Statement[] = [];

  // 1. Move emails from merge user to keep user (mark as non-primary)
  statements.push(
    db
      .update(userEmails)
      .set({ userId: keepUserId, isPrimary: false })
      .where(eq(userEmails.userId, mergeUserId))
  );

  // 2. Deduplicate participants on shared trips, then move the rest
  const keepTripMap = new Map(keepParts.map((p) => [p.tripId, p]));
  let movedParticipants = 0;
  let dedupedTrips = 0;
  for (const mp of mergeParts) {
    const kp = keepTripMap.get(mp.tripId);
    if (kp) {
      dedupedTrips++;
      const keepRank = TRIP_ROLE_RANK[kp.role] ?? 0;
      const mergeRank = TRIP_ROLE_RANK[mp.role] ?? 0;
      if (mergeRank > keepRank) {
        statements.push(db.update(participants).set({ role: mp.role }).where(eq(participants.id, kp.id)));
      }
      statements.push(db.update(expenses).set({ payerId: kp.id }).where(eq(expenses.payerId, mp.id)));
      statements.push(db.delete(participants).where(eq(participants.id, mp.id)));
    } else {
      movedParticipants++;
      statements.push(
        db
          .update(participants)
          .set({ userId: keepUserId, email: keepUser.email })
          .where(eq(participants.id, mp.id))
      );
    }
  }

  // 3. Move invites authored by the merge user
  statements.push(db.update(invites).set({ invitedBy: keepUserId }).where(eq(invites.invitedBy, mergeUserId)));

  // 4. Move service identities
  statements.push(
    db.update(serviceIdentities).set({ userId: keepUserId }).where(eq(serviceIdentities.userId, mergeUserId))
  );

  // 5. Optionally promote role if merge user had a higher global role
  let keepAfter = keepUser;
  let promotedRole: string | null = null;
  if (promoteRole) {
    const keepRank = ROLE_RANK[keepUser.role] ?? 0;
    const mergeRank = ROLE_RANK[mergeUser.role] ?? 0;
    if (mergeRank > keepRank) {
      promotedRole = mergeUser.role;
      keepAfter = { ...keepUser, role: mergeUser.role, updatedAt: new Date().toISOString() };
      statements.push(
        db
          .update(users)
          .set({ role: keepAfter.role, updatedAt: keepAfter.updatedAt })
          .where(eq(users.id, keepUserId))
      );
    }
  }

  // 6. Delete merge user
  statements.push(db.delete(users).where(eq(users.id, mergeUserId)));

  // --- One event, on the surviving user ---
  const result: MergeResult = {
    mergedUserId: mergeUserId,
    mergedEmail: mergeUser.email,
    movedEmails: mergeEmails.length,
    movedParticipants,
    dedupedTrips,
    promotedRole,
  };
  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "user",
    entityId: keepUserId,
    action: "merge",
    before: keepUser,
    after: keepAfter,
    metadata: { ...result },
  });
  if (!audit) throw new Error("auditInsert returned null for user.merge");
  statements.push(audit);

  await db.batch(statements as [Statement, ...Statement[]]);
  return result;
}

/** Alias for backward compat with admin route */
export const mergeAccounts = mergeAccountsD1;
