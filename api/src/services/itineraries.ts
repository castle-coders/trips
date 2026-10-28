import type { z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "../db";
import { itineraries, participants, trips } from "../db/schema";
import {
  ItineraryViewSchema,
  contentSchemaByType,
  viewContentSchemaByType,
  type CreateItinerarySchema,
  type ItinerarySchema,
  type ItineraryType,
  type UpdateItinerarySchema,
} from "../schemas/itinerary";
import { isAdmin, isTripRole, requireTripRole, type Db, type TripRole } from "./access";
import { ServiceError } from "./errors";

const CURRENT_SCHEMA_VERSION = 1;

export type Itinerary = z.infer<typeof ItinerarySchema>;
export type ItineraryView = z.infer<typeof ItineraryViewSchema>;
export type CreateItineraryInput = z.infer<typeof CreateItinerarySchema>;
export type UpdateItineraryInput = z.infer<typeof UpdateItinerarySchema>;
/** A row as returned to a caller: full for Editor/Owner, viewer-projected for Viewer. */
export type ProjectedItinerary = Itinerary | ItineraryView;

/** Message for a non-member reading a trip's itinerary list (same as other "trip missing" errors). */
const TRIP_NOT_FOUND = "Trip not found";
/** Message for a missing itinerary, and for a non-member addressing a single itinerary. */
const ITEM_NOT_FOUND = "Not found";

/**
 * Normalize legacy flight content that stored per-leg fields at the top level.
 * Moves them into the legs array so all code can assume the new format.
 * Safe to remove once all data has been migrated (0009_flight_legs_normalize.sql).
 */
export function normalizeFlightContent(row: Record<string, unknown>): Record<string, unknown> {
  if (row.type !== "Flight") return row;
  const content = row.content as Record<string, unknown> | undefined;
  if (!content) return row;
  // Old format has airline/flightNumber at the top level; new format does not
  if (!content.airline) return row;

  // Old format: top-level airline/flightNumber/etc, optional legs[] for extra legs
  const leg0: Record<string, unknown> = {
    airline: content.airline,
    flightNumber: content.flightNumber,
    departureAirport: content.departureAirport,
    departureTime: content.departureTime,
    departureTimeTz: content.departureTimeTz,
    arrivalAirport: content.arrivalAirport,
    arrivalTime: content.arrivalTime,
    arrivalTimeTz: content.arrivalTimeTz,
    fareClass: content.fareClass,
    baggageAllowance: content.baggageAllowance,
    seatAssignments: content.seatAssignments,
  };

  // Rename cabinClass→fareClass in any existing extra legs
  const oldLegs = (content.legs as Array<Record<string, unknown>>) || [];
  const extraLegs = oldLegs.map((l) => ({
    ...l,
    fareClass: l.fareClass ?? l.cabinClass,
    cabinClass: undefined,
  }));

  return {
    ...row,
    content: {
      travelers: content.travelers,
      legs: [leg0, ...extraLegs],
    },
  };
}

export function validateContent(type: ItineraryType, content: unknown) {
  const schema = contentSchemaByType[type];
  const result = schema.safeParse(content);
  if (!result.success) {
    return { ok: false as const, error: result.error.flatten() };
  }
  return { ok: true as const, data: result.data };
}

/** Project an itinerary row through the viewer schemas, stripping sensitive fields. */
export function toViewerResponse(row: Record<string, unknown>) {
  const type = row.type as ItineraryType;
  const viewContentSchema = viewContentSchemaByType[type];
  // Parse content through the view schema to strip sensitive fields
  const content = viewContentSchema
    ? viewContentSchema.parse(row.content)
    : row.content;
  // Parse the itinerary envelope through the view schema (drops confirmationNumber)
  const envelope = ItineraryViewSchema.parse({ ...row, content });
  return envelope;
}

/**
 * Normalize a stored row and project it for `role`.
 * A viewer projection failure (stored content that does not fit the view schema) is rethrown as a
 * plain Error, never a ServiceError: REST answers 500 as before, MCP reports a generic error, and
 * no zod issue detail is attached to the message.
 */
function project(row: Record<string, unknown>, role: TripRole): ProjectedItinerary {
  const normalized = normalizeFlightContent(row);
  if (role !== "Viewer") return normalized as Itinerary;
  try {
    return toViewerResponse(normalized);
  } catch (cause) {
    throw new Error("Itinerary content does not match the viewer schema", { cause });
  }
}

async function findItinerary(db: Db, tripId: string, itineraryId: string) {
  const rows = await db
    .select()
    .from(itineraries)
    .where(and(eq(itineraries.id, itineraryId), eq(itineraries.tripId, tripId)));
  return rows[0];
}

/**
 * List a trip's itineraries, projected by the caller's role.
 * Viewer+. Non-member: not_found "Trip not found". Admin on a nonexistent trip: [].
 * Row order is the database's (no ORDER BY), as today.
 */
export async function listItineraries(db: Db, user: AuthUser, tripId: string): Promise<ProjectedItinerary[]> {
  const role = await requireTripRole(db, user, tripId, "Viewer", { notFound: TRIP_NOT_FOUND });
  const rows = await db.select().from(itineraries).where(eq(itineraries.tripId, tripId));
  return rows.map((r) => project(r as Record<string, unknown>, role));
}

/**
 * One itinerary, projected by the caller's role.
 * Viewer+. Non-member and missing itinerary both: not_found "Not found".
 */
export async function getItinerary(
  db: Db,
  user: AuthUser,
  tripId: string,
  itineraryId: string
): Promise<ProjectedItinerary> {
  const role = await requireTripRole(db, user, tripId, "Viewer", { notFound: ITEM_NOT_FOUND });
  const row = await findItinerary(db, tripId, itineraryId);
  if (!row) throw new ServiceError("not_found", ITEM_NOT_FOUND);
  return project(row as Record<string, unknown>, role);
}

/**
 * Create an itinerary. Editor+. Non-member: not_found "Trip not found"; Viewer: forbidden "Forbidden";
 * missing trip (reachable by admins): not_found "Trip not found";
 * invalid content: validation "Invalid content for type" with flattened zod details.
 * Returns the full row (no projection; only Editor+ get here).
 */
export async function createItinerary(
  db: Db,
  user: AuthUser,
  tripId: string,
  input: CreateItineraryInput
): Promise<Itinerary> {
  await requireTripRole(db, user, tripId, "Editor", { notFound: TRIP_NOT_FOUND });

  const trip = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId));
  if (!trip.length) throw new ServiceError("not_found", TRIP_NOT_FOUND);

  // Validate content against type-specific schema
  const validation = validateContent(input.type as ItineraryType, input.content);
  if (!validation.ok) throw new ServiceError("validation", "Invalid content for type", validation.error);

  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    tripId,
    type: input.type,
    status: input.status ?? "Pending",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    content: validation.data as Record<string, unknown>,
    confirmationNumber: input.confirmationNumber ?? null,
    totalCost: input.totalCost ?? null,
    currency: input.currency ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(itineraries).values(row);
  return row;
}

/**
 * Patch an itinerary. Editor+. Non-member and missing itinerary: not_found "Not found";
 * Viewer: forbidden "Forbidden"; invalid content: validation as in createItinerary.
 * Content (when present) is validated against the patched type, else the stored type.
 * Changing type without content does not revalidate stored content.
 * Returns the merged row without flight normalization (as today).
 */
export async function updateItinerary(
  db: Db,
  user: AuthUser,
  tripId: string,
  itineraryId: string,
  patch: UpdateItineraryInput
): Promise<Itinerary> {
  await requireTripRole(db, user, tripId, "Editor", { notFound: ITEM_NOT_FOUND });
  const existing = await findItinerary(db, tripId, itineraryId);
  if (!existing) throw new ServiceError("not_found", ITEM_NOT_FOUND);

  const body = { ...patch };
  const effectiveType = (body.type ?? existing.type) as ItineraryType;

  // If content is being updated, validate against the (possibly new) type
  if (body.content) {
    const validation = validateContent(effectiveType, body.content);
    if (!validation.ok) throw new ServiceError("validation", "Invalid content for type", validation.error);
    body.content = validation.data as Record<string, unknown>;
  }

  const updated = {
    ...existing,
    ...body,
    updatedAt: new Date().toISOString(),
  };
  await db.update(itineraries).set(updated).where(eq(itineraries.id, itineraryId));
  return updated as Itinerary;
}

/**
 * Delete an itinerary. Editor+. Non-member and missing itinerary: not_found "Not found";
 * Viewer: forbidden "Forbidden".
 */
export async function deleteItinerary(db: Db, user: AuthUser, tripId: string, itineraryId: string): Promise<void> {
  await requireTripRole(db, user, tripId, "Editor", { notFound: ITEM_NOT_FOUND });
  const existing = await findItinerary(db, tripId, itineraryId);
  if (!existing) throw new ServiceError("not_found", ITEM_NOT_FOUND);
  await db.delete(itineraries).where(eq(itineraries.id, itineraryId));
}

// ---------------------------------------------------------------------------
// Timeline entries and grouping by local date (mirrors web/src/components/ItineraryTimeline.tsx)
// ---------------------------------------------------------------------------

/** Timeline entry kinds, matching the web timeline's displayType values. */
export type TimelineEntryKind = ItineraryType | "Lodging-arrival" | "Lodging-departure";

export interface TimelineEntry<T> {
  itinerary: T;
  kind: TimelineEntryKind;
  /** Flight leg index; set only for Flight entries that come from a leg. */
  legIndex?: number;
  /** The stored wall-clock time string the entry is placed by, or null when unscheduled. */
  time: string | null;
  /** The stored IANA timezone for that time, when present. */
  timeZone: string | null;
}

export interface ItineraryDayGroup<T> {
  /** Local calendar date "YYYY-MM-DD", or null for the trailing Unscheduled group. */
  date: string | null;
  /** Entries ordered by time; ties keep input order. */
  entries: TimelineEntry<T>[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Stored times are wall-clock times as entered (no offset). Treat them as UTC so the numeric
 * values are preserved; this is the web timeline's fixed (552308b) behavior.
 */
function wallClockToUTC(time: string): string {
  const hasOffset = /[Z+\-]\d*$/.test(time);
  return hasOffset ? time : time + "Z";
}

function sortTimeOf(time: string | null): number {
  return time ? new Date(wallClockToUTC(time)).getTime() : Infinity;
}

/** "YYYY-MM-DD" of an entry's time, or null when it has none or it does not parse. */
function localDateOf(time: string | null): string | null {
  const t = sortTimeOf(time);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

type TimedEntry<T> = TimelineEntry<T> & { sortTime: number };

function entry<T>(itinerary: T, kind: TimelineEntryKind, time: string | undefined, tz: string | undefined, legIndex?: number): TimedEntry<T> {
  const e: TimedEntry<T> = { itinerary, kind, time: time ?? null, timeZone: tz ?? null, sortTime: sortTimeOf(time ?? null) };
  if (legIndex !== undefined) e.legIndex = legIndex;
  return e;
}

/** Timeline entries for one itinerary, mirroring the web timeline's buildEntries. */
function entriesFor<T extends { type: string; content: unknown }>(item: T): TimedEntry<T>[] {
  const c = (item.content ?? {}) as Record<string, unknown>;

  if (item.type === "Lodging") {
    // Combine a bare time ("15:00") with a separate date field if the time lacks a date component.
    const hasDate = (t: string) => /^\d{4}-\d{2}-\d{2}/.test(t);
    const merge = (date: string | undefined, time: string | undefined) =>
      time ? (date && !hasDate(time) ? `${date}T${time}` : time) : undefined;
    const checkIn = merge(str(c.checkInDate), str(c.checkInTime));
    const checkOut = merge(str(c.checkOutDate), str(c.checkOutTime));
    const arrival = str(c.arrivalDateTime);
    const departure = str(c.departureDateTime);
    const out: TimedEntry<T>[] = [];
    if (arrival || checkIn) {
      out.push(entry(item, "Lodging-arrival", arrival ?? checkIn, arrival ? str(c.arrivalDateTimeTz) : str(c.checkInTimeTz)));
    }
    if (departure || checkOut) {
      out.push(entry(item, "Lodging-departure", departure ?? checkOut, departure ? str(c.departureDateTimeTz) : str(c.checkOutTimeTz)));
    }
    if (!out.length) out.push(entry(item, "Lodging", undefined, undefined));
    return out;
  }

  if (item.type === "Flight") {
    const legs = Array.isArray(c.legs) ? (c.legs as Array<Record<string, unknown>>) : [];
    // The web timeline renders nothing for a flight without legs; keep it visible as Unscheduled.
    if (!legs.length) return [entry(item, "Flight", undefined, undefined)];
    return legs.map((leg, i) => entry(item, "Flight", str(leg?.departureTime), str(leg?.departureTimeTz), i));
  }

  const timeKey = str(c.departureTime)
    ? "departureTime"
    : str(c.pickUpTime)
      ? "pickUpTime"
      : str(c.reservationTime)
        ? "reservationTime"
        : str(c.startTime)
          ? "startTime"
          : "";
  return [
    entry(item, item.type as ItineraryType, timeKey ? str(c[timeKey]) : undefined, timeKey ? str(c[`${timeKey}Tz`]) : undefined),
  ];
}

/**
 * Group itineraries into days the way the web timeline does: each itinerary yields one entry per
 * flight leg (by departure), two for lodging (check-in / check-out, preferring planned
 * arrival/departure times), and one for other types (first of departureTime, pickUpTime,
 * reservationTime, startTime). An entry's day is the calendar date of its stored wall-clock time,
 * i.e. local to its stored timezone. Entries with no parseable time go in a final group with
 * date null. Groups are ordered by date ascending; entries within a group by time, stable.
 * Pass already-projected rows; this function does no access checks.
 */
export function groupItinerariesByLocalDate<T extends { type: string; content: unknown }>(items: T[]): ItineraryDayGroup<T>[] {
  const all = items.flatMap((item) => entriesFor(item));
  // Array.prototype.sort is stable; NaN (unparseable) times are routed to the unscheduled group first.
  const scheduled = all.filter((e) => Number.isFinite(e.sortTime)).sort((a, b) => a.sortTime - b.sortTime);
  const unscheduled = all.filter((e) => !Number.isFinite(e.sortTime));

  const groups: ItineraryDayGroup<T>[] = [];
  for (const e of scheduled) {
    const date = localDateOf(e.time);
    if (!groups.length || groups[groups.length - 1].date !== date) groups.push({ date, entries: [] });
    groups[groups.length - 1].entries.push(strip(e));
  }
  if (unscheduled.length) groups.push({ date: null, entries: unscheduled.map(strip) });
  return groups;
}

function strip<T>({ sortTime: _sortTime, ...e }: TimedEntry<T>): TimelineEntry<T> {
  return e;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface ItinerarySearchFilter {
  /** Restrict to one trip. Non-member: not_found "Trip not found". */
  tripId?: string;
  /** Restrict to these types. Omitted or empty: all types. */
  types?: ItineraryType[];
  /** Inclusive lower bound, "YYYY-MM-DD" (a longer ISO string is truncated to its date). */
  from?: string;
  /** Inclusive upper bound, "YYYY-MM-DD" (a longer ISO string is truncated to its date). */
  to?: string;
  /** Case-insensitive substring match on content (projected for Viewers) or notes. */
  text?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function boundDate(name: "from" | "to", value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!DATE_RE.test(value)) throw new ServiceError("validation", `Invalid ${name} date; expected YYYY-MM-DD`);
  return value.slice(0, 10);
}

/** Escape LIKE wildcards so `text` matches literally (used with ESCAPE '\'). */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Largest LIKE pattern, in UTF-8 bytes, that D1 accepts: the final pattern including the `%`
 * wrappers and the `\` escapes added by likePattern. D1 caps SQLite's LIKE pattern length limit
 * (SQLITE_MAX_LIKE_PATTERN_LENGTH / SQLITE_LIMIT_LIKE_PATTERN_LENGTH; stock SQLite default 50000)
 * far lower; a longer pattern fails with "LIKE or GLOB pattern too complex: SQLITE_ERROR".
 * Measured in the workers test pool: 50 bytes succeeds, 51 fails; multi-byte characters count
 * per byte.
 */
export const SEARCH_TEXT_MAX_PATTERN_BYTES = 50;

const utf8 = new TextEncoder();

/** The LIKE pattern for `text`, or a validation error when D1 would reject it as too long. */
function boundedLikePattern(text: string): string {
  const p = likePattern(text);
  if (utf8.encode(p).length > SEARCH_TEXT_MAX_PATTERN_BYTES) {
    throw new ServiceError("validation", "Search text is too long; use a shorter phrase");
  }
  return p;
}

function textMatches(row: ProjectedItinerary, needle: string): boolean {
  const n = needle.toLowerCase();
  return JSON.stringify(row.content ?? null).toLowerCase().includes(n) || (row.notes ?? "").toLowerCase().includes(n);
}

/**
 * Hard cap on the itinerary rows one search loads from the database, applied in SQL before any
 * JS-side filtering. Bounds the cost of a single call (an admin with no filters would otherwise
 * load the whole table). Callers' own `limit` slicing happens after this.
 */
export const SEARCH_HARD_CAP = 1000;

export interface ItinerarySearchOptions {
  /**
   * Row cap for this call, for tests. Clamped to [1, SEARCH_HARD_CAP]; it can only lower the cap.
   * Default SEARCH_HARD_CAP.
   */
  cap?: number;
}

export interface ItinerarySearchResult {
  items: ProjectedItinerary[];
  /**
   * True when the SQL candidate set exceeded the cap, so `items` may be incomplete. Narrow the
   * filters (tripId, types, text) to see everything. `items` can still be shorter than the cap
   * (date filtering, Viewer text re-check and unprojectable rows run after the cap).
   */
  truncated: boolean;
}

/**
 * The caller's role on each of `tripIds`, in one query. Same rules as access.getMembership:
 * admin is Owner everywhere; a trip without a participant row is absent (non-member); an
 * unrecognised stored role is Viewer.
 */
async function rolesForTrips(db: Db, user: AuthUser, tripIds: Set<string>): Promise<Map<string, TripRole>> {
  const roles = new Map<string, TripRole>();
  if (!tripIds.size) return roles;
  if (isAdmin(user)) {
    for (const id of tripIds) roles.set(id, "Owner");
    return roles;
  }
  // All of the caller's participant rows (bounded by their trip count, and avoids a large IN list
  // against D1's bound-parameter limit). First row per trip wins, like getMembership's LIMIT 1.
  const rows = await db
    .select({ tripId: participants.tripId, role: participants.role })
    .from(participants)
    .where(eq(participants.userId, user.id));
  for (const r of rows) {
    if (!tripIds.has(r.tripId) || roles.has(r.tripId)) continue;
    roles.set(r.tripId, isTripRole(r.role) ? r.role : "Viewer");
  }
  return roles;
}

/**
 * Search itineraries across the caller's trips (admin: all trips), projected row by row by the
 * caller's role on that row's trip.
 *
 * - Non-admins see only trips they are a participant of (semi-join: itineraries.trip_id IN the
 *   caller's participants.trip_id rows). Admins skip the join.
 * - `types`: SQL IN on itineraries.type.
 * - `text`: SQL `LIKE '%text%' ESCAPE '\'` on the stored content JSON or notes (SQLite LIKE is
 *   case-insensitive for ASCII; %, _ and \ in `text` are escaped). For Viewer rows the match is
 *   re-checked against the projected content, so a Viewer cannot probe hidden fields
 *   (ticketNumber) through the filter. Matching is on the JSON text, so key names also match.
 *   An empty `text` is no filter. A `text` whose escaped, %-wrapped pattern exceeds
 *   SEARCH_TEXT_MAX_PATTERN_BYTES (UTF-8) is a `validation` error, thrown before any query.
 * - `from`/`to`: the itinerary table has no date columns; dates come from the same per-type
 *   timeline times as groupItinerariesByLocalDate. A row matches when the span of its entry dates
 *   [earliest, latest] overlaps [from, to] (both inclusive). Rows with no dated entry are excluded
 *   whenever from or to is set.
 * - Order: by earliest entry time, unscheduled last, then id.
 * - Cap: SQL loads at most SEARCH_HARD_CAP rows matching tripId/types/text/membership, ordered by
 *   itineraries.id (SQL cannot compute entry times). When more exist, `truncated` is true and the
 *   candidate set is the first SEARCH_HARD_CAP by id, not by time; the date filter, the Viewer text
 *   re-check and the time sort then run on that subset only. So under truncation a from/to search
 *   can miss in-range rows beyond the cap, and the output is not the globally earliest N.
 */
export async function searchItinerariesWithMeta(
  db: Db,
  user: AuthUser,
  filter: ItinerarySearchFilter = {},
  options: ItinerarySearchOptions = {}
): Promise<ItinerarySearchResult> {
  const cap = Math.max(1, Math.min(SEARCH_HARD_CAP, Math.floor(options.cap ?? SEARCH_HARD_CAP)));
  const from = boundDate("from", filter.from);
  const to = boundDate("to", filter.to);
  // Before any query: an over-long pattern would otherwise surface as a raw D1 error.
  const textPattern = filter.text ? boundedLikePattern(filter.text) : undefined;
  if (filter.tripId !== undefined) {
    await requireTripRole(db, user, filter.tripId, "Viewer", { notFound: TRIP_NOT_FOUND });
  }

  const conds: SQL[] = [];
  if (filter.tripId !== undefined) conds.push(eq(itineraries.tripId, filter.tripId));
  if (filter.types?.length) conds.push(inArray(itineraries.type, filter.types));
  if (textPattern !== undefined) {
    const p = textPattern;
    conds.push(sql`(${itineraries.content} LIKE ${p} ESCAPE '\\' OR ${itineraries.notes} LIKE ${p} ESCAPE '\\')`);
  }
  if (!isAdmin(user)) {
    // Semi-join: a trip with two participant rows for the same user does not duplicate results.
    const memberTrips = db
      .select({ tripId: participants.tripId })
      .from(participants)
      .where(eq(participants.userId, user.id));
    conds.push(inArray(itineraries.tripId, memberTrips));
  }
  const where = conds.length ? and(...conds) : undefined;

  // One extra row tells us whether the cap was hit without a COUNT query.
  const fetched = await db.select().from(itineraries).where(where).orderBy(asc(itineraries.id)).limit(cap + 1);
  const truncated = fetched.length > cap;
  const rows = truncated ? fetched.slice(0, cap) : fetched;

  // One role query for all distinct trips, using the same rules as every other read.
  const roles = await rolesForTrips(db, user, new Set(rows.map((r) => r.tripId)));

  const results: Array<{ row: ProjectedItinerary; first: number; id: string }> = [];
  for (const raw of rows) {
    const role = roles.get(raw.tripId);
    if (!role) continue;
    // One unprojectable row (stored content that no longer fits its type's view schema) must not
    // fail the whole cross-trip search. Fail closed: skip the row, never return it unprojected.
    // Log the id only; content and zod issues may carry hidden fields.
    let row: ProjectedItinerary;
    try {
      row = project(raw as Record<string, unknown>, role);
    } catch {
      console.error(`searchItineraries: skipped itinerary ${raw.id}: content does not match the viewer schema`);
      continue;
    }
    if (filter.text && role === "Viewer" && !textMatches(row, filter.text)) continue;

    const entries = entriesFor(row);
    const dates = entries.map((e) => localDateOf(e.time)).filter((d): d is string => d !== null).sort();
    if (from !== undefined || to !== undefined) {
      if (!dates.length) continue;
      if (from !== undefined && dates[dates.length - 1] < from) continue;
      if (to !== undefined && dates[0] > to) continue;
    }
    const times = entries.map((e) => e.sortTime).filter((t) => Number.isFinite(t));
    results.push({ row, first: times.length ? Math.min(...times) : Infinity, id: raw.id });
  }

  results.sort((a, b) => (a.first === b.first ? a.id.localeCompare(b.id) : a.first < b.first ? -1 : 1));
  return { items: results.map((r) => r.row), truncated };
}

/** searchItinerariesWithMeta without the truncation flag. Same filter, order and cap. */
export async function searchItineraries(
  db: Db,
  user: AuthUser,
  filter: ItinerarySearchFilter = {},
  options: ItinerarySearchOptions = {}
): Promise<ProjectedItinerary[]> {
  return (await searchItinerariesWithMeta(db, user, filter, options)).items;
}
