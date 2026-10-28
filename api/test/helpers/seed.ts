// Seed helpers. All rows go through Drizzle against the per-file test D1.
// Values are obviously fake; nothing here is a real secret or address.
import { eq } from "drizzle-orm";
import { expenses, itineraries, participants, trips, userEmails, users } from "../../src/db/schema";
import { testDb } from "./db";

export type GlobalRole = "admin" | "editor" | "viewer";
export type TripRole = "Owner" | "Editor" | "Viewer";

const now = () => new Date().toISOString();

export type SeededUser = typeof users.$inferSelect;
export type SeededTrip = typeof trips.$inferSelect;
export type SeededParticipant = typeof participants.$inferSelect;
export type SeededItinerary = typeof itineraries.$inferSelect;
export type SeededExpense = typeof expenses.$inferSelect;

/**
 * Insert a users row plus its primary user_emails row. The auth middleware resolves
 * X-Dev-User-Email through user_emails, and it does NOT auto-create unknown users,
 * so a user must be seeded before asUser(email) can authenticate.
 */
export async function seedUser(
  email: string,
  globalRole: GlobalRole = "viewer",
  opts: { name?: string; id?: string } = {}
): Promise<SeededUser> {
  const db = testDb();
  const ts = now();
  const row = {
    id: opts.id ?? crypto.randomUUID(),
    email,
    name: opts.name ?? email.split("@")[0],
    role: globalRole,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(users).values(row);
  await db.insert(userEmails).values({
    id: crypto.randomUUID(),
    userId: row.id,
    email,
    isPrimary: true,
    createdAt: ts,
  });
  const [created] = await db.select().from(users).where(eq(users.id, row.id));
  return created;
}

/** Link an extra (non-primary) email to an existing user. */
export async function addUserEmail(userId: string, email: string): Promise<void> {
  await testDb().insert(userEmails).values({
    id: crypto.randomUUID(),
    userId,
    email,
    isPrimary: false,
    createdAt: now(),
  });
}

export type SeedTripInput = Partial<Omit<typeof trips.$inferInsert, "createdAt" | "updatedAt">>;

/**
 * Insert a trip. When ownerUserId is given, also inserts an Owner participant row for that
 * user (this is how trips look after invites/the web app; today's POST /trips does not do it).
 * Pass null to create an ownerless trip.
 */
export async function seedTrip(
  ownerUserId: string | null,
  input: SeedTripInput = {}
): Promise<{ trip: SeededTrip; owner: SeededParticipant | null }> {
  const db = testDb();
  const ts = now();
  const row = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name ?? "Test Trip",
    destination: input.destination === undefined ? "Testville" : input.destination,
    startDate: input.startDate === undefined ? "2030-01-10" : input.startDate,
    endDate: input.endDate === undefined ? "2030-01-15" : input.endDate,
    description: input.description ?? null,
    splitwiseGroupId: input.splitwiseGroupId ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(trips).values(row);
  const [trip] = await db.select().from(trips).where(eq(trips.id, row.id));
  const owner = ownerUserId ? await addParticipant(trip.id, ownerUserId, "Owner") : null;
  return { trip, owner };
}

/**
 * Add a participant. Pass userId=null for a non-user traveler (name only).
 * Name/email default from the users row when userId is given.
 */
export async function addParticipant(
  tripId: string,
  userId: string | null,
  role: TripRole,
  opts: { name?: string; email?: string | null; traveling?: boolean; id?: string } = {}
): Promise<SeededParticipant> {
  const db = testDb();
  let name = opts.name;
  let email = opts.email;
  if (userId && (name === undefined || email === undefined)) {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new Error(`addParticipant: no user ${userId}`);
    name ??= u.name;
    email = email === undefined ? u.email : email;
  }
  const ts = now();
  const row = {
    id: opts.id ?? crypto.randomUUID(),
    tripId,
    userId,
    email: email ?? null,
    name: name ?? "Guest Traveler",
    role,
    traveling: opts.traveling ?? true,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(participants).values(row);
  const [p] = await db.select().from(participants).where(eq(participants.id, row.id));
  return p;
}

/** A normalized (post-0009) one-leg flight content with sensitive fields populated. */
export function flightContent(travelerParticipantId: string, overrides: Record<string, unknown> = {}) {
  return {
    travelers: [{ participantId: travelerParticipantId, name: "Test Traveler", ticketNumber: "TKT-FAKE-0001" }],
    legs: [
      {
        airline: "Test Air",
        flightNumber: "TA100",
        departureAirport: "AAA",
        departureTime: "2030-01-10T09:00",
        departureTimeTz: "America/Los_Angeles",
        arrivalAirport: "BBB",
        arrivalTime: "2030-01-10T17:00",
        arrivalTimeTz: "America/New_York",
        seatAssignments: [{ participantId: travelerParticipantId, seatNumber: "12A" }],
      },
    ],
    ...overrides,
  };
}

export type SeedItineraryInput = Partial<Omit<typeof itineraries.$inferInsert, "tripId" | "createdAt" | "updatedAt">>;

/**
 * Insert an itinerary. Defaults to an Activity. `content` is stored as-is (no
 * validation or flight normalization), so callers can seed legacy shapes too.
 */
export async function seedItinerary(tripId: string, input: SeedItineraryInput = {}): Promise<SeededItinerary> {
  const db = testDb();
  const ts = now();
  const row = {
    id: input.id ?? crypto.randomUUID(),
    tripId,
    type: input.type ?? "Activity",
    status: input.status ?? "Confirmed",
    schemaVersion: input.schemaVersion ?? 1,
    content: input.content ?? { name: "Test Activity", startTime: "2030-01-11T10:00" },
    confirmationNumber: input.confirmationNumber === undefined ? "CONF-FAKE-0001" : input.confirmationNumber,
    totalCost: input.totalCost ?? null,
    currency: input.currency ?? null,
    notes: input.notes ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(itineraries).values(row);
  const [it] = await db.select().from(itineraries).where(eq(itineraries.id, row.id));
  return it;
}

export type SeedExpenseInput = Partial<Omit<typeof expenses.$inferInsert, "tripId" | "createdAt" | "updatedAt">>;

export async function seedExpense(tripId: string, input: SeedExpenseInput = {}): Promise<SeededExpense> {
  const db = testDb();
  const ts = now();
  const row = {
    id: input.id ?? crypto.randomUUID(),
    tripId,
    description: input.description ?? "Test Expense",
    amount: input.amount ?? 42.5,
    currency: input.currency ?? "USD",
    category: input.category ?? "Food",
    payerId: input.payerId ?? null,
    splitType: input.splitType ?? "EQUAL",
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(expenses).values(row);
  const [e] = await db.select().from(expenses).where(eq(expenses.id, row.id));
  return e;
}
