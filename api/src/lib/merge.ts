import { eq } from "drizzle-orm";
import type { getDb } from "../db";
import {
  users,
  userEmails,
  participants,
  expenses,
  invites,
  serviceIdentities,
} from "../db/schema";

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

type Db = ReturnType<typeof getDb>;

/**
 * Merge `mergeUserId` into `keepUserId` using sequential queries.
 * D1 doesn't support BEGIN/COMMIT transactions — Workers requests are
 * single-threaded so there's no concurrent-request TOCTOU risk within
 * a single invocation.
 */
export async function mergeAccountsD1(
  db: Db,
  keepUserId: string,
  mergeUserId: string,
  options: MergeOptions = {}
): Promise<void> {
  const { promoteRole = true } = options;

  if (keepUserId === mergeUserId) return;

  // Validate both users exist
  console.log("[merge] Validating users:", keepUserId, mergeUserId);
  const [keepRows, mergeRows] = await Promise.all([
    db.select().from(users).where(eq(users.id, keepUserId)).limit(1),
    db.select().from(users).where(eq(users.id, mergeUserId)).limit(1),
  ]);
  if (!keepRows.length) throw new Error("Keep user not found");
  if (!mergeRows.length) throw new Error("Merge user not found");

  const keepUser = keepRows[0];
  const mergeUser = mergeRows[0];
  console.log("[merge] Keep:", keepUser.email, "Merge:", mergeUser.email);

  // 1. Move emails from merge user to keep user (mark as non-primary)
  console.log("[merge] Step 1: Moving emails");
  await db
    .update(userEmails)
    .set({ userId: keepUserId, isPrimary: false })
    .where(eq(userEmails.userId, mergeUserId));

  // 2. Deduplicate participants on shared trips, then move the rest
  console.log("[merge] Step 2: Deduplicating participants");
  const [keepParts, mergeParts] = await Promise.all([
    db.select().from(participants).where(eq(participants.userId, keepUserId)),
    db.select().from(participants).where(eq(participants.userId, mergeUserId)),
  ]);
  console.log("[merge] Keep parts:", keepParts.length, "Merge parts:", mergeParts.length);

  const keepTripMap = new Map(keepParts.map((p) => [p.tripId, p]));

  for (const mp of mergeParts) {
    const kp = keepTripMap.get(mp.tripId);
    if (kp) {
      console.log("[merge] Dedup trip:", mp.tripId);
      const keepRank = TRIP_ROLE_RANK[kp.role] ?? 0;
      const mergeRank = TRIP_ROLE_RANK[mp.role] ?? 0;
      if (mergeRank > keepRank) {
        await db
          .update(participants)
          .set({ role: mp.role })
          .where(eq(participants.id, kp.id));
      }
      await db
        .update(expenses)
        .set({ payerId: kp.id })
        .where(eq(expenses.payerId, mp.id));
      await db.delete(participants).where(eq(participants.id, mp.id));
    } else {
      console.log("[merge] Transfer trip:", mp.tripId);
      await db
        .update(participants)
        .set({ userId: keepUserId, email: keepUser.email })
        .where(eq(participants.id, mp.id));
    }
  }

  // 3. Move invites authored by the merge user
  console.log("[merge] Step 3: Moving invites");
  await db
    .update(invites)
    .set({ invitedBy: keepUserId })
    .where(eq(invites.invitedBy, mergeUserId));

  // 4. Move service identities
  console.log("[merge] Step 4: Moving service identities");
  await db
    .update(serviceIdentities)
    .set({ userId: keepUserId })
    .where(eq(serviceIdentities.userId, mergeUserId));

  // 5. Optionally promote role if merge user had a higher global role
  if (promoteRole) {
    const keepRank = ROLE_RANK[keepUser.role] ?? 0;
    const mergeRank = ROLE_RANK[mergeUser.role] ?? 0;
    if (mergeRank > keepRank) {
      console.log("[merge] Step 5: Promoting role");
      await db
        .update(users)
        .set({ role: mergeUser.role, updatedAt: new Date().toISOString() })
        .where(eq(users.id, keepUserId));
    }
  }

  // 6. Delete merge user
  console.log("[merge] Step 6: Deleting merge user");
  await db.delete(users).where(eq(users.id, mergeUserId));
  console.log("[merge] Done");
}

/** Alias for backward compat with admin route */
export const mergeAccounts = mergeAccountsD1;
