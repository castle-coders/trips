// services/documents.ts: listDocuments, createDocument, updateDocument, deleteDocument.
// Called directly (no requireTripEditor middleware in front), as the MCP tools call them.
// Every write records exactly one audit event in the same batch (AUDIT_TDD 7.1, 7.2).
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor as AuditActor } from "../src/db";
import { documents } from "../src/db/schema";
import {
  createDocument,
  deleteDocument,
  listDocuments,
  updateDocument,
  type CreateDocument,
  type Document,
} from "../src/services/documents";
import { IDS, expectServiceError, seedRoleWorld, testDb, toAuth, type Actor, type RoleWorld } from "./helpers";
import { auditRows, toActor } from "./helpers/audit";

let w: RoleWorld;
const auth = (a: Actor) => toAuth(w.users[a]);
const actor = (a: Actor, overrides: Partial<Pick<AuditActor, "channel" | "clientId" | "requestId">> = {}): AuditActor =>
  toActor(w.users[a], overrides);

const DOC = {
  ticket: "00000000-0000-4000-8000-0000000d0001",
  receipt: "00000000-0000-4000-8000-0000000d0002",
  otherTrip: "00000000-0000-4000-8000-0000000d0003",
  missing: "00000000-0000-4000-8000-0000000d0dead",
} as const;

const input: CreateDocument = {
  fileUrl: "https://files.example.test/fake-ticket.pdf",
  documentType: "PDF_TICKET",
  name: "Fake ticket",
};

async function seedDocument(tripId: string, overrides: Partial<Document> = {}): Promise<Document> {
  const ts = new Date().toISOString();
  const row: Document = {
    id: crypto.randomUUID(),
    tripId,
    reservationId: null,
    fileUrl: "https://files.example.test/seeded.pdf",
    documentType: "OTHER",
    name: "Seeded document",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
  await testDb().insert(documents).values(row);
  const [stored] = await testDb().select().from(documents).where(eq(documents.id, row.id));
  return stored;
}

const storedDocs = () => testDb().select().from(documents);

beforeEach(async () => {
  w = await seedRoleWorld();
  await seedDocument(IDS.trip, { id: DOC.ticket, name: "Ticket", documentType: "PDF_TICKET" });
  await seedDocument(IDS.trip, { id: DOC.receipt, name: "Receipt", documentType: "IMAGE_RECEIPT" });
  await seedDocument(IDS.otherTrip, { id: DOC.otherTrip, name: "Elsewhere" });
});

describe("listDocuments", () => {
  it("returns the trip's documents only", async () => {
    const rows = await listDocuments(testDb(), auth("owner"), IDS.trip);
    expect(rows.map((r) => r.id).sort()).toEqual([DOC.ticket, DOC.receipt].sort());
  });

  it("every member role and admin can read; same rows", async () => {
    const owner = await listDocuments(testDb(), auth("owner"), IDS.trip);
    for (const a of ["editor", "viewer", "admin"] as const) {
      const rows = await listDocuments(testDb(), auth(a), IDS.trip);
      expect(rows.sort((x, y) => x.id.localeCompare(y.id)), a).toEqual(owner.sort((x, y) => x.id.localeCompare(y.id)));
    }
  });

  it("non-member is not_found; admin on a missing trip gets []", async () => {
    await expectServiceError(listDocuments(testDb(), auth("outsider"), IDS.trip), "not_found", "Trip not found");
    await expectServiceError(listDocuments(testDb(), auth("viewer"), IDS.missing), "not_found", "Trip not found");
    expect(await listDocuments(testDb(), auth("admin"), IDS.missing)).toEqual([]);
  });

  it("reads record no audit event", async () => {
    await listDocuments(testDb(), auth("owner"), IDS.trip);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("createDocument", () => {
  it("Editor, Owner and admin can create; the row is stored as returned", async () => {
    for (const a of ["editor", "owner", "admin"] as const) {
      const row = await createDocument(testDb(), actor(a), IDS.trip, { ...input, reservationId: IDS.ownerP });
      expect(row).toMatchObject({ ...input, reservationId: IDS.ownerP, tripId: IDS.trip });
      const [stored] = await testDb().select().from(documents).where(eq(documents.id, row.id));
      expect(stored).toEqual(row);
    }
  });

  it("reservationId defaults to null", async () => {
    const row = await createDocument(testDb(), actor("editor"), IDS.trip, input);
    expect(row.reservationId).toBeNull();
  });

  it("records exactly one document.create event with the allow-listed after snapshot", async () => {
    const row = await createDocument(testDb(), actor("editor", { channel: "mcp_oauth", clientId: "fake-client" }), IDS.trip, input);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: IDS.editor,
      actorName: "Editor User",
      actorEmail: "editor@example.test",
      actorRole: "editor",
      channel: "mcp_oauth",
      clientId: "fake-client",
      requestId: "ray-test",
      tripId: IDS.trip,
      entityType: "document",
      entityId: row.id,
      entityLabel: "Fake ticket",
      action: "create",
      before: null,
      changes: null,
      metadata: null,
    });
    expect(rows[0].after).toEqual({
      id: row.id,
      tripId: IDS.trip,
      reservationId: null,
      fileUrl: input.fileUrl,
      documentType: "PDF_TICKET",
      name: "Fake ticket",
    });
  });

  it("Viewer is forbidden, non-member is not_found; nothing written, no event", async () => {
    await expectServiceError(createDocument(testDb(), actor("viewer"), IDS.trip, input), "forbidden", "Forbidden");
    await expectServiceError(createDocument(testDb(), actor("outsider"), IDS.trip, input), "not_found", "Trip not found");
    expect(await storedDocs()).toHaveLength(3);
    expect(await auditRows()).toHaveLength(0);
  });

  it("admin on a missing trip is not_found (trip existence is checked); no event", async () => {
    await expectServiceError(createDocument(testDb(), actor("admin"), IDS.missing, input), "not_found", "Trip not found");
    expect(await storedDocs()).toHaveLength(3);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("updateDocument", () => {
  it("Editor, Owner and admin can patch; merged row returned and stored, updatedAt bumped", async () => {
    let previous = (await storedDocs()).find((d) => d.id === DOC.ticket)!;
    for (const a of ["editor", "owner", "admin"] as const) {
      await new Promise((r) => setTimeout(r, 2));
      const row = await updateDocument(testDb(), actor(a), IDS.trip, DOC.ticket, { name: `Renamed by ${a}` });
      expect(row).toMatchObject({ ...previous, name: `Renamed by ${a}`, updatedAt: expect.any(String) });
      expect(row.updatedAt > previous.updatedAt).toBe(true);
      const [stored] = await testDb().select().from(documents).where(eq(documents.id, DOC.ticket));
      expect(stored).toEqual(row);
      previous = stored;
    }
    expect(await auditRows()).toHaveLength(3);
  });

  it("records exactly one document.update event with before, after and changes", async () => {
    const before = (await storedDocs()).find((d) => d.id === DOC.ticket)!;
    const row = await updateDocument(testDb(), actor("owner"), IDS.trip, DOC.ticket, {
      name: "Boarding pass",
      documentType: "BOARDING_PASS",
      reservationId: IDS.editorP,
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: IDS.owner,
      tripId: IDS.trip,
      entityType: "document",
      entityId: DOC.ticket,
      entityLabel: "Boarding pass",
      action: "update",
      metadata: null,
    });
    expect(rows[0].before).toEqual({
      id: DOC.ticket,
      tripId: IDS.trip,
      reservationId: null,
      fileUrl: before.fileUrl,
      documentType: "PDF_TICKET",
      name: "Ticket",
    });
    expect(rows[0].after).toEqual({
      id: DOC.ticket,
      tripId: IDS.trip,
      reservationId: IDS.editorP,
      fileUrl: row.fileUrl,
      documentType: "BOARDING_PASS",
      name: "Boarding pass",
    });
    expect(rows[0].changes).toEqual({
      name: { from: "Ticket", to: "Boarding pass" },
      documentType: { from: "PDF_TICKET", to: "BOARDING_PASS" },
      reservationId: { from: null, to: IDS.editorP },
    });
  });

  it("no-op patch (same values or empty body) writes nothing: updatedAt untouched, stored row returned, no event", async () => {
    const before = (await storedDocs()).find((d) => d.id === DOC.ticket)!;
    await new Promise((r) => setTimeout(r, 2));
    const same = await updateDocument(testDb(), actor("editor"), IDS.trip, DOC.ticket, {
      name: before.name,
      fileUrl: before.fileUrl,
      documentType: "PDF_TICKET",
      reservationId: null,
    });
    expect(same).toEqual(before);
    const empty = await updateDocument(testDb(), actor("editor"), IDS.trip, DOC.ticket, {});
    expect(empty).toEqual(before);
    const [stored] = await testDb().select().from(documents).where(eq(documents.id, DOC.ticket));
    expect(stored).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });

  it("a partial patch that re-sends identical values alongside one change records only that change", async () => {
    const before = (await storedDocs()).find((d) => d.id === DOC.receipt)!;
    await updateDocument(testDb(), actor("editor"), IDS.trip, DOC.receipt, { name: before.name, fileUrl: before.fileUrl, documentType: "OTHER" });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].changes).toEqual({ documentType: { from: "IMAGE_RECEIPT", to: "OTHER" } });
    expect(rows[0].entityLabel).toBe("Receipt");
  });

  it("a partial patch that only re-sends one identical value is a no-op: no event, updatedAt untouched", async () => {
    const before = (await storedDocs()).find((d) => d.id === DOC.receipt)!;
    await new Promise((r) => setTimeout(r, 2));
    expect(await updateDocument(testDb(), actor("owner"), IDS.trip, DOC.receipt, { name: before.name })).toEqual(before);
    const [stored] = await testDb().select().from(documents).where(eq(documents.id, DOC.receipt));
    expect(stored.updatedAt).toBe(before.updatedAt);
    expect(await auditRows()).toHaveLength(0);
  });

  it("update snapshots never carry createdAt or updatedAt", async () => {
    await updateDocument(testDb(), actor("editor"), IDS.trip, DOC.ticket, { name: "Stamped" });
    const [e] = await auditRows();
    for (const snap of [e.before, e.after]) {
      expect(Object.keys(snap as object).sort()).toEqual(["documentType", "fileUrl", "id", "name", "reservationId", "tripId"]);
    }
  });

  it("Viewer is forbidden, non-member is not_found; nothing written, no event", async () => {
    const before = await storedDocs();
    await expectServiceError(updateDocument(testDb(), actor("viewer"), IDS.trip, DOC.ticket, { name: "x" }), "forbidden", "Forbidden");
    await expectServiceError(updateDocument(testDb(), actor("outsider"), IDS.trip, DOC.ticket, { name: "x" }), "not_found", "Trip not found");
    expect(await storedDocs()).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });

  it("a document on another trip, or a missing one, is not_found (Document not found)", async () => {
    await expectServiceError(updateDocument(testDb(), actor("owner"), IDS.trip, DOC.otherTrip, { name: "x" }), "not_found", "Document not found");
    await expectServiceError(updateDocument(testDb(), actor("admin"), IDS.trip, DOC.missing, { name: "x" }), "not_found", "Document not found");
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("deleteDocument", () => {
  it("Editor, Owner and admin can delete; one document.delete event each with before", async () => {
    const targets = { editor: DOC.ticket, owner: DOC.receipt } as const;
    for (const [a, id] of Object.entries(targets) as Array<[Actor, string]>) {
      const [before] = await testDb().select().from(documents).where(eq(documents.id, id));
      await deleteDocument(testDb(), actor(a), IDS.trip, id);
      expect(await testDb().select().from(documents).where(eq(documents.id, id))).toHaveLength(0);
      const event = (await auditRows()).at(-1)!;
      expect(event).toMatchObject({
        actorUserId: w.users[a].id,
        tripId: IDS.trip,
        entityType: "document",
        entityId: id,
        entityLabel: before.name,
        action: "delete",
        after: null,
        changes: null,
        metadata: null,
      });
      expect(event.before).toEqual({
        id,
        tripId: IDS.trip,
        reservationId: null,
        fileUrl: before.fileUrl,
        documentType: before.documentType,
        name: before.name,
      });
    }
    const extra = await seedDocument(IDS.trip, { name: "Admin target" });
    await deleteDocument(testDb(), actor("admin"), IDS.trip, extra.id);
    const rows = await auditRows();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ actorUserId: IDS.admin, entityId: extra.id, action: "delete" });
  });

  it("Viewer is forbidden, non-member is not_found; row stays, no event", async () => {
    await expectServiceError(deleteDocument(testDb(), actor("viewer"), IDS.trip, DOC.ticket), "forbidden", "Forbidden");
    await expectServiceError(deleteDocument(testDb(), actor("outsider"), IDS.trip, DOC.ticket), "not_found", "Trip not found");
    expect(await storedDocs()).toHaveLength(3);
    expect(await auditRows()).toHaveLength(0);
  });

  it("a document on another trip, or a missing one, is not_found (Document not found); other trip's row survives", async () => {
    await expectServiceError(deleteDocument(testDb(), actor("owner"), IDS.trip, DOC.otherTrip), "not_found", "Document not found");
    await expectServiceError(deleteDocument(testDb(), actor("admin"), IDS.trip, DOC.missing), "not_found", "Document not found");
    expect(await storedDocs()).toHaveLength(3);
    expect(await auditRows()).toHaveLength(0);
  });
});
