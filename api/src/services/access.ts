import { and, eq } from "drizzle-orm";
import type { AuthUser } from "../db";
import { getDb } from "../db";
import { participants } from "../db/schema";
import { ServiceError } from "./errors";

export type Db = ReturnType<typeof getDb>;

export type TripRole = "Owner" | "Editor" | "Viewer";

export const ROLE_RANK: Record<TripRole, number> = { Viewer: 0, Editor: 1, Owner: 2 };

export function isTripRole(value: unknown): value is TripRole {
  return value === "Owner" || value === "Editor" || value === "Viewer";
}

/** True when `role` is at least `min`. */
export function hasRole(role: TripRole, min: TripRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function isAdmin(user: AuthUser): boolean {
  return user.role === "admin";
}

/**
 * The caller's role on a trip without throwing.
 * Admins are Owner everywhere (no trip-existence check). Non-members get null.
 * An unrecognised stored participant role is treated as Viewer (least privilege).
 */
export async function getMembership(db: Db, user: AuthUser, tripId: string): Promise<TripRole | null> {
  if (isAdmin(user)) return "Owner";
  const rows = await db
    .select({ role: participants.role })
    .from(participants)
    .where(and(eq(participants.tripId, tripId), eq(participants.userId, user.id)))
    .limit(1);
  if (!rows.length) return null;
  return isTripRole(rows[0].role) ? rows[0].role : "Viewer";
}

export interface TripRoleMessages {
  /** Body message for non-members. Default "Trip not found". */
  notFound?: string;
  /** Body message for members below `min`. Default "Forbidden". */
  forbidden?: string;
}

/**
 * Resolve the caller's role on a trip and require at least `min`.
 * - admin: Owner everywhere, no trip-existence check
 * - non-member: ServiceError("not_found")
 * - member below `min`: ServiceError("forbidden")
 */
export async function requireTripRole(
  db: Db,
  user: AuthUser,
  tripId: string,
  min: TripRole,
  messages: TripRoleMessages = {}
): Promise<TripRole> {
  const role = await getMembership(db, user, tripId);
  if (role === null) throw new ServiceError("not_found", messages.notFound ?? "Trip not found");
  if (!hasRole(role, min)) throw new ServiceError("forbidden", messages.forbidden ?? "Forbidden");
  return role;
}
