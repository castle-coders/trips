/**
 * Users service (specs/AUDIT_TDD.md 7.3, "Administration").
 *
 * Every write here records exactly one audit event in the same `db.batch` as its data
 * statement(s). All events carry `tripId: null`. The `user` allow-list drops `passwordHash`
 * (and anything else not opted in), and nothing here puts it in `metadata` either.
 *
 * Status codes and messages are the ones the admin and auth routes have always returned,
 * expressed as `ServiceError`s that the shared `onError` maps back to HTTP.
 */
import { and, eq } from "drizzle-orm";
import type { Actor } from "../db";
import { serviceIdentities, userEmails, users } from "../db/schema";
import type { Db } from "./access";
import { auditInsert } from "./audit";
import { ServiceError } from "./errors";

export type User = typeof users.$inferSelect;
export type UserEmail = typeof userEmails.$inferSelect;
export type ServiceIdentity = typeof serviceIdentities.$inferSelect;

export type GlobalRole = "admin" | "editor" | "viewer";

const MESSAGES = {
  userNotFound: "User not found",
  emailExists: "Email already exists",
  emailNotFound: "Email not found",
  removePrimary: "Cannot remove primary email",
  removeOnly: "Cannot remove only email",
  identityNotFound: "Not found",
  subjectMapped: "Subject already mapped",
} as const;

// --- Reads shared by the routes ---

/** The stored user row, or `not_found` ("User not found"). */
export async function getUser(db: Db, userId: string): Promise<User> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!rows.length) throw new ServiceError("not_found", MESSAGES.userNotFound);
  return rows[0];
}

/** Every user_emails row for a user, in table order. */
export async function listUserEmails(db: Db, userId: string): Promise<UserEmail[]> {
  return db.select().from(userEmails).where(eq(userEmails.userId, userId));
}

// --- Users ---

export interface NewUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  /** ISO timestamp used for createdAt / updatedAt on both rows. */
  now: string;
}

/**
 * Insert a users row plus its primary user_emails row and record `user.create` (after = the
 * user row) in one batch. No existence check: the caller decides who the actor is and whether
 * the email is free. Used by `createUser` (admin) and by `createUserWithEmail` in the auth
 * middleware (first-time sign-in through invite or link, where the new user is its own actor).
 */
export async function insertUserWithPrimaryEmail(db: Db, actor: Actor, input: NewUserRow): Promise<User> {
  const row: User = {
    id: input.id,
    email: input.email,
    name: input.name,
    passwordHash: null,
    googleId: null,
    avatarUrl: null,
    role: input.role,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "user",
    entityId: row.id,
    action: "create",
    after: row,
  });
  if (!audit) throw new Error("auditInsert returned null for user.create");

  await db.batch([
    db.insert(users).values({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    db.insert(userEmails).values({
      id: crypto.randomUUID(),
      userId: row.id,
      email: row.email,
      isPrimary: true,
      createdAt: input.now,
    }),
    audit,
  ]);
  return row;
}

/** Body of `POST /admin/users` after validation. */
export interface CreateUser {
  email: string;
  name: string;
  role: GlobalRole;
}

/**
 * `POST /admin/users`. `conflict` ("Email already exists") when any user_emails row has the
 * email. Batch: insert users, insert user_emails, `user.create`.
 */
export async function createUser(db: Db, actor: Actor, input: CreateUser): Promise<User> {
  const existing = await db
    .select({ id: userEmails.id })
    .from(userEmails)
    .where(eq(userEmails.email, input.email))
    .limit(1);
  if (existing.length) throw new ServiceError("conflict", MESSAGES.emailExists);

  return insertUserWithPrimaryEmail(db, actor, {
    id: crypto.randomUUID(),
    email: input.email,
    name: input.name,
    role: input.role,
    now: new Date().toISOString(),
  });
}

/** Body of `PUT /admin/users/{userId}` after validation. */
export interface UpdateUser {
  name?: string;
  role?: GlobalRole;
}

/**
 * `PUT /admin/users/{userId}`: `user.update`. Both patchable columns are allow-listed, so an
 * empty diff means nothing changed: nothing is written (updatedAt untouched) and the stored row
 * is returned (TDD 7.1 / 12).
 */
export async function updateUser(db: Db, actor: Actor, userId: string, patch: UpdateUser): Promise<User> {
  const before = await getUser(db, userId);
  return applyUserUpdate(db, actor, before, patch);
}

/** Body of `PUT /me` after validation. */
export interface UpdateProfile {
  name: string;
}

/** `PUT /me`: `user.update` on the actor's own row. Same no-op rule as `updateUser`. */
export async function updateProfile(db: Db, actor: Actor, patch: UpdateProfile): Promise<User> {
  const before = await getUser(db, actor.id);
  return applyUserUpdate(db, actor, before, patch);
}

async function applyUserUpdate(db: Db, actor: Actor, before: User, patch: UpdateUser): Promise<User> {
  const fields: Partial<Pick<User, "name" | "role">> = {};
  if (patch.name !== undefined) fields.name = patch.name;
  if (patch.role !== undefined) fields.role = patch.role;

  const now = new Date().toISOString();
  const after: User = { ...before, ...fields, updatedAt: now };
  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "user",
    entityId: before.id,
    action: "update",
    before,
    after,
  });
  if (!audit) return before;

  await db.batch([
    db
      .update(users)
      .set({ ...fields, updatedAt: now })
      .where(eq(users.id, before.id)),
    audit,
  ]);
  return after;
}

/**
 * `DELETE /admin/users/{userId}`: `user.delete` (before = the row). The route checks the user
 * exists with `getUser`, revokes OAuth grants (KV, cannot share the batch), then calls this
 * with the count for `metadata: { revokedGrants }`. The row is read again here so the snapshot
 * is the one actually deleted. Children (emails, participants, identities, tokens) cascade and
 * get no events of their own.
 */
export async function deleteUser(
  db: Db,
  actor: Actor,
  userId: string,
  opts: { revokedGrants: number }
): Promise<void> {
  const before = await getUser(db, userId);
  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "user",
    entityId: userId,
    action: "delete",
    before,
    metadata: { revokedGrants: opts.revokedGrants },
  });
  if (!audit) throw new Error("auditInsert returned null for user.delete");

  await db.batch([db.delete(users).where(eq(users.id, userId)), audit]);
}

// --- Linked emails ---

/**
 * Attach an extra (non-primary) email to a user: `user_email.link` (after = the row).
 * `not_found` when the user is missing, `conflict` ("Email already exists") when the address
 * is already linked anywhere. Today's link routes merge whole accounts (see `lib/merge.ts`)
 * rather than inserting a single address, so this is the hook for any path that does.
 */
export async function linkEmail(db: Db, actor: Actor, userId: string, email: string): Promise<UserEmail> {
  await getUser(db, userId);
  const existing = await db
    .select({ id: userEmails.id })
    .from(userEmails)
    .where(eq(userEmails.email, email))
    .limit(1);
  if (existing.length) throw new ServiceError("conflict", MESSAGES.emailExists);

  const row: UserEmail = {
    id: crypto.randomUUID(),
    userId,
    email,
    isPrimary: false,
    createdAt: new Date().toISOString(),
  };
  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "user_email",
    entityId: row.id,
    action: "link",
    after: row,
  });
  if (!audit) throw new Error("auditInsert returned null for user_email.link");

  await db.batch([db.insert(userEmails).values(row), audit]);
  return row;
}

/**
 * `DELETE /me/emails/{emailId}`: `user_email.unlink` (before = the row). Only the actor's own
 * emails are visible (`not_found` otherwise); the primary (`validation`, "Cannot remove
 * primary email") and the last one (`validation`, "Cannot remove only email") stay.
 */
export async function unlinkEmail(db: Db, actor: Actor, emailId: string): Promise<void> {
  const rows = await db
    .select()
    .from(userEmails)
    .where(and(eq(userEmails.id, emailId), eq(userEmails.userId, actor.id)));
  if (!rows.length) throw new ServiceError("not_found", MESSAGES.emailNotFound);
  const before = rows[0];
  if (before.isPrimary) throw new ServiceError("validation", MESSAGES.removePrimary);

  const all = await listUserEmails(db, actor.id);
  if (all.length <= 1) throw new ServiceError("validation", MESSAGES.removeOnly);

  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "user_email",
    entityId: emailId,
    action: "unlink",
    before,
  });
  if (!audit) throw new Error("auditInsert returned null for user_email.unlink");

  await db.batch([db.delete(userEmails).where(eq(userEmails.id, emailId)), audit]);
}

/**
 * `PUT /me/emails/{emailId}/primary`: the existing three statements (clear the actor's
 * primaries, set this one, copy the address onto users.email) plus `user_email.set_primary`.
 * `before` / `after` are the email row; `metadata: { previousPrimaryEmailId }` (null when no
 * row was primary). Always one event, even when the row was already primary.
 */
export async function setPrimaryEmail(db: Db, actor: Actor, emailId: string): Promise<UserEmail> {
  const all = await listUserEmails(db, actor.id);
  const before = all.find((e) => e.id === emailId);
  if (!before) throw new ServiceError("not_found", MESSAGES.emailNotFound);
  // Already primary: nothing changes, so nothing is written and no event is recorded (PRD 6.4).
  if (before.isPrimary) return before;
  const previousPrimary = all.find((e) => e.isPrimary) ?? null;

  const after: UserEmail = { ...before, isPrimary: true };
  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "user_email",
    entityId: emailId,
    action: "set_primary",
    before,
    after,
    metadata: { previousPrimaryEmailId: previousPrimary ? previousPrimary.id : null },
  });
  if (!audit) throw new Error("auditInsert returned null for user_email.set_primary");

  await db.batch([
    db.update(userEmails).set({ isPrimary: false }).where(eq(userEmails.userId, actor.id)),
    db.update(userEmails).set({ isPrimary: true }).where(eq(userEmails.id, emailId)),
    db.update(users).set({ email: before.email, updatedAt: new Date().toISOString() }).where(eq(users.id, actor.id)),
    audit,
  ]);
  return after;
}

// --- Service identities ---

/** Body of `POST /admin/service-identities` after validation. */
export interface CreateServiceIdentity {
  cfAccessSubject: string;
  commonName: string;
  userId: string;
}

/** The identity row plus the owning user's display fields, as the admin route returns it. */
export type ServiceIdentityWithUser = ServiceIdentity & { userName: string; userEmail: string };

/**
 * `POST /admin/service-identities`: `service_identity.create` (after = the row). `not_found`
 * ("User not found") for a missing user, `conflict` ("Subject already mapped") for a reused
 * Access subject.
 */
export async function createServiceIdentity(
  db: Db,
  actor: Actor,
  input: CreateServiceIdentity
): Promise<ServiceIdentityWithUser> {
  const user = await getUser(db, input.userId);
  const existing = await db
    .select({ id: serviceIdentities.id })
    .from(serviceIdentities)
    .where(eq(serviceIdentities.cfAccessSubject, input.cfAccessSubject))
    .limit(1);
  if (existing.length) throw new ServiceError("conflict", MESSAGES.subjectMapped);

  const row: ServiceIdentity = {
    id: crypto.randomUUID(),
    cfAccessSubject: input.cfAccessSubject,
    commonName: input.commonName,
    userId: input.userId,
    createdAt: new Date().toISOString(),
  };
  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "service_identity",
    entityId: row.id,
    action: "create",
    after: row,
  });
  if (!audit) throw new Error("auditInsert returned null for service_identity.create");

  await db.batch([db.insert(serviceIdentities).values(row), audit]);
  return { ...row, userName: user.name, userEmail: user.email };
}

/** `DELETE /admin/service-identities/{identityId}`: `service_identity.delete` (before = the row). `not_found` ("Not found"). */
export async function deleteServiceIdentity(db: Db, actor: Actor, identityId: string): Promise<void> {
  const rows = await db.select().from(serviceIdentities).where(eq(serviceIdentities.id, identityId)).limit(1);
  if (!rows.length) throw new ServiceError("not_found", MESSAGES.identityNotFound);
  const before = rows[0];

  const audit = auditInsert(db, {
    actor,
    tripId: null,
    entityType: "service_identity",
    entityId: identityId,
    action: "delete",
    before,
  });
  if (!audit) throw new Error("auditInsert returned null for service_identity.delete");

  await db.batch([db.delete(serviceIdentities).where(eq(serviceIdentities.id, identityId)), audit]);
}
