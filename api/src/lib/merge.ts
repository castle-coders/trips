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

type DbOrTx = ReturnType<typeof getDb> | Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Merge logic that runs on a db handle or transaction handle.
 * Use this when you're already inside a transaction (to avoid nested transactions on D1).
 */
export async function mergeAccountsTx(
  tx: DbOrTx,
  keepUserId: string,
  mergeUserId: string,
  options: MergeOptions = {}
): Promise<void> {
  const { promoteRole = true } = options;

  if (keepUserId === mergeUserId) return;

  // Validate both users exist
  console.log("[merge] Validating users:", keepUserId, mergeUserId);
  const [keepRows, mergeRows] = await Promise.all([
    tx.select().from(users).where(eq(users.id, keepUserId)).limit(1),
    tx.select().from(users).where(eq(users.id, mergeUserId)).limit(1),
  ]);
  if (!keepRows.length) throw new Error("Keep user not found");
  if (!mergeRows.length) throw new Error("Merge user not found");

  const keepUser = keepRows[0];
  const mergeUser = mergeRows[0];
  console.log("[merge] Keep:", keepUser.email, "Merge:", mergeUser.email);

  // 1. Move emails from merge user to keep user (mark as non-primary)
  console.log("[merge] Step 1: Moving emails");
  await tx
    .update(userEmails)
    .set({ userId: keepUserId, isPrimary: false })
    .where(eq(userEmails.userId, mergeUserId));

  // 2. Deduplicate participants on shared trips, then move the rest
  console.log("[merge] Step 2: Deduplicating participants");
  const [keepParts, mergeParts] = await Promise.all([
    tx.select().from(participants).where(eq(participants.userId, keepUserId)),
    tx.select().from(participants).where(eq(participants.userId, mergeUserId)),
  ]);
  console.log("[merge] Keep parts:", keepParts.length, "Merge parts:", mergeParts.length);

  const keepTripMap = new Map(keepParts.map((p) => [p.tripId, p]));

  for (const mp of mergeParts) {
    const kp = keepTripMap.get(mp.tripId);
    if (kp) {
      console.log("[merge] Dedup trip:", mp.tripId);
      // Both users are participants on the same trip — keep the higher role
      const keepRank = TRIP_ROLE_RANK[kp.role] ?? 0;
      const mergeRank = TRIP_ROLE_RANK[mp.role] ?? 0;
      if (mergeRank > keepRank) {
        await tx
          .update(participants)
          .set({ role: mp.role })
          .where(eq(participants.id, kp.id));
      }
      // Reassign any expenses from the losing participant to the winning one
      await tx
        .update(expenses)
        .set({ payerId: kp.id })
        .where(eq(expenses.payerId, mp.id));
      // Delete the duplicate participant
      await tx.delete(participants).where(eq(participants.id, mp.id));
    } else {
      console.log("[merge] Transfer trip:", mp.tripId);
      // Only the merge user is on this trip — transfer ownership
      await tx
        .update(participants)
        .set({ userId: keepUserId, email: keepUser.email })
        .where(eq(participants.id, mp.id));
    }
  }

  // 3. Move invites authored by the merge user
  console.log("[merge] Step 3: Moving invites");
  await tx
    .update(invites)
    .set({ invitedBy: keepUserId })
    .where(eq(invites.invitedBy, mergeUserId));

  // 4. Move service identities
  console.log("[merge] Step 4: Moving service identities");
  await tx
    .update(serviceIdentities)
    .set({ userId: keepUserId })
    .where(eq(serviceIdentities.userId, mergeUserId));

  // 5. Optionally promote role if merge user had a higher global role
  if (promoteRole) {
    const keepRank = ROLE_RANK[keepUser.role] ?? 0;
    const mergeRank = ROLE_RANK[mergeUser.role] ?? 0;
    if (mergeRank > keepRank) {
      console.log("[merge] Step 5: Promoting role");
      await tx
        .update(users)
        .set({ role: mergeUser.role, updatedAt: new Date().toISOString() })
        .where(eq(users.id, keepUserId));
    }
  }

  // 6. Delete merge user
  console.log("[merge] Step 6: Deleting merge user");
  await tx.delete(users).where(eq(users.id, mergeUserId));
  console.log("[merge] Done");
}

/**
 * Merge `mergeUserId` into `keepUserId`, wrapped in its own transaction.
 * Use this when calling from outside a transaction (e.g. admin merge endpoint).
 */
export async function mergeAccounts(
  db: ReturnType<typeof getDb>,
  keepUserId: string,
  mergeUserId: string,
  options: MergeOptions = {}
): Promise<void> {
  if (keepUserId === mergeUserId) return;
  await db.transaction(async (tx) => {
    await mergeAccountsTx(tx, keepUserId, mergeUserId, options);
  });
}
