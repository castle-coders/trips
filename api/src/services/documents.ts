/**
 * Documents service (AUDIT_TDD 7.2 "documents.*"). Writes require Editor on the trip, the
 * same rule `requireTripEditor` applied in front of the old route, made explicit here so MCP
 * and REST share it. Every write runs its data statement and its audit event in one
 * `db.batch`; an update whose allow-listed diff is empty writes nothing and returns the
 * stored row (TDD 7.1, 12).
 */
import type { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Actor, AuthUser } from "../db";
import { documents, trips } from "../db/schema";
import type { CreateDocumentSchema, UpdateDocumentSchema } from "../schemas/document";
import { requireTripRole, type Db } from "./access";
import { auditInsert } from "./audit";
import { ServiceError } from "./errors";

export type Document = typeof documents.$inferSelect;
export type CreateDocument = z.infer<typeof CreateDocumentSchema>;
export type UpdateDocument = z.infer<typeof UpdateDocumentSchema>;

/** Documents of a trip. Requires Viewer (admins everywhere; non-members get `not_found`). */
export async function listDocuments(db: Db, user: AuthUser, tripId: string): Promise<Document[]> {
  await requireTripRole(db, user, tripId, "Viewer");
  return db.select().from(documents).where(eq(documents.tripId, tripId));
}

async function findDocument(db: Db, tripId: string, documentId: string): Promise<Document> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.tripId, tripId)));
  if (!rows.length) throw new ServiceError("not_found", "Document not found");
  return rows[0];
}

/** Create a document. Requires Editor; the trip must exist. Records `document.create`. */
export async function createDocument(db: Db, actor: Actor, tripId: string, input: CreateDocument): Promise<Document> {
  await requireTripRole(db, actor, tripId, "Editor");
  const trip = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId));
  if (!trip.length) throw new ServiceError("not_found", "Trip not found");
  const now = new Date().toISOString();
  const row: Document = {
    id: crypto.randomUUID(),
    tripId,
    reservationId: input.reservationId ?? null,
    fileUrl: input.fileUrl,
    documentType: input.documentType,
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "document",
    entityId: row.id,
    action: "create",
    after: row,
  });
  if (!audit) throw new Error("auditInsert returned null for a create");
  await db.batch([db.insert(documents).values(row), audit]);
  return row;
}

/**
 * Patch a document. Requires Editor. Records `document.update` with the column diff; when
 * the diff is empty nothing is written (`updatedAt` untouched) and the stored row is returned.
 */
export async function updateDocument(
  db: Db,
  actor: Actor,
  tripId: string,
  documentId: string,
  patch: UpdateDocument
): Promise<Document> {
  await requireTripRole(db, actor, tripId, "Editor");
  const before = await findDocument(db, tripId, documentId);
  const updated: Document = { ...before, ...patch, updatedAt: new Date().toISOString() };
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "document",
    entityId: documentId,
    action: "update",
    before,
    after: updated,
  });
  if (!audit) return before;
  await db.batch([db.update(documents).set(updated).where(eq(documents.id, documentId)), audit]);
  return updated;
}

/** Delete a document. Requires Editor. Records `document.delete` with the row as `before`. */
export async function deleteDocument(db: Db, actor: Actor, tripId: string, documentId: string): Promise<void> {
  await requireTripRole(db, actor, tripId, "Editor");
  const before = await findDocument(db, tripId, documentId);
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "document",
    entityId: documentId,
    action: "delete",
    before,
  });
  if (!audit) throw new Error("auditInsert returned null for a delete");
  await db.batch([db.delete(documents).where(eq(documents.id, documentId)), audit]);
}
