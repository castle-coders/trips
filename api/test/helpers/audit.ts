// Seed and read helpers for audit_events tests. Test-only; production code never reads this.
// Values are obviously fake. Nothing here updates or deletes audit rows (append-only, TDD 10).
import { asc } from "drizzle-orm";
import type { Actor } from "../../src/db";
import { auditEvents } from "../../src/db/schema";
import { auditInsert, recordEvent, type EventInput } from "../../src/services/audit";
import { testDb } from "./db";

export type AuditRow = typeof auditEvents.$inferSelect;

/** Actor as the auth middleware would build it for a web request. Overrides set channel/clientId/requestId. */
export function toActor(
  u: { id: string; email: string; name: string; role: string },
  overrides: Partial<Pick<Actor, "channel" | "clientId" | "requestId">> = {}
): Actor {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    channel: "web",
    clientId: null,
    requestId: "ray-test",
    ...overrides,
  };
}

/** Every audit row, oldest first (ascending `seq`). */
export async function auditRows(): Promise<AuditRow[]> {
  return testDb().select().from(auditEvents).orderBy(asc(auditEvents.seq));
}

export type SeedEventInput = Partial<Omit<EventInput, "actor">> & { actor: Actor };

/**
 * Record one event through the real `recordEvent`. Defaults to a `trip.create` with a
 * minimal `after` snapshot, so callers only name what the test is about.
 */
export async function seedEvent(input: SeedEventInput): Promise<void> {
  const entityId = input.entityId ?? crypto.randomUUID();
  await recordEvent(testDb(), {
    actor: input.actor,
    tripId: input.tripId === undefined ? null : input.tripId,
    entityType: input.entityType ?? "trip",
    entityId,
    action: input.action ?? "create",
    before: input.before,
    after: input.after === undefined ? { id: entityId, name: `Seeded ${entityId.slice(0, 8)}` } : input.after,
    metadata: input.metadata,
  });
}

/**
 * Record `count` events for one trip in batches of `auditInsert` statements (much faster
 * than `count` round trips). Returns the entity ids in insertion order.
 */
export async function seedManyEvents(actor: Actor, tripId: string, count: number, chunk = 50): Promise<string[]> {
  const db = testDb();
  const ids: string[] = [];
  for (let start = 0; start < count; start += chunk) {
    const stmts = [];
    for (let i = start; i < Math.min(count, start + chunk); i++) {
      const entityId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      ids.push(entityId);
      const stmt = auditInsert(db, {
        actor,
        tripId,
        entityType: "expense",
        entityId,
        action: "create",
        after: { id: entityId, tripId, description: `Expense ${i}` },
      });
      if (stmt === null) throw new Error("auditInsert returned null for a create");
      stmts.push(stmt);
    }
    await db.batch(stmts as unknown as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  }
  return ids;
}

/**
 * Insert a raw audit row with full control over every column (notably `createdAt`, which
 * `auditInsert` always sets to now). Used by the `since` / `until` filter tests.
 */
export async function seedRawEvent(
  actor: Actor,
  overrides: Partial<typeof auditEvents.$inferInsert> = {}
): Promise<void> {
  const entityId = overrides.entityId ?? crypto.randomUUID();
  await testDb()
    .insert(auditEvents)
    .values({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      actorUserId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
      channel: actor.channel,
      clientId: actor.clientId,
      requestId: actor.requestId,
      tripId: null,
      entityType: "trip",
      entityId,
      entityLabel: "Raw Event",
      action: "create",
      before: null,
      after: { id: entityId, name: "Raw Event" },
      changes: null,
      metadata: null,
      ...overrides,
    });
}
