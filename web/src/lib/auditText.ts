// Pure rendering helpers for audit events (specs/AUDIT_TDD.md section 9.2).
// Everything here returns plain strings; callers render them as React text nodes.
import type {
  AuditAction,
  AuditChannel,
  AuditEntityType,
  AuditEvent,
  AuditSnapshot,
} from "./types";
import { formatDateTime } from "./format";

export interface AuditDetail {
  label: string;
  from?: unknown;
  to?: unknown;
  /** added: no `from`; removed: no `to`; changed: both sides present (a `to` of null is a change to "(none)"). */
  kind: "added" | "removed" | "changed";
}

export interface EventDescription {
  headline: string;
  /** Client name for agent or service edits ("via Claude"); null for web, dev and backfill. */
  via: string | null;
  details: AuditDetail[];
}

export interface SnapshotRow {
  label: string;
  value: string;
}

const VERBS: Record<AuditAction, string> = {
  create: "created",
  update: "changed",
  delete: "deleted",
  accept: "accepted",
  merge: "merged",
  link: "linked",
  unlink: "unlinked",
  set_primary: "made primary",
  revoke: "revoked",
};

const NOUNS: Record<AuditEntityType, string> = {
  trip: "trip",
  itinerary: "item",
  expense: "expense",
  participant: "participant",
  document: "document",
  invite: "invite",
  user: "user",
  user_email: "email",
  service_identity: "service identity",
  oauth_grant: "connected app",
  oauth_client: "OAuth client",
};

const CHANNEL_LABELS: Record<AuditChannel, string> = {
  web: "Web",
  service_token: "Service token",
  mcp_stage1: "MCP (service token)",
  mcp_oauth: "MCP (OAuth)",
  dev: "Dev",
  backfill: "Backfill",
};

/** Channels where the edit was made by an app or agent rather than a person in the browser. */
const CLIENT_CHANNELS: ReadonlySet<AuditChannel> = new Set(["mcp_oauth", "mcp_stage1", "service_token"]);

/** Human label for a channel value; unknown values are shown as-is. */
export function channelLabel(channel: string): string {
  return (CHANNEL_LABELS as Record<string, string>)[channel] ?? channel;
}

/**
 * Labels for leaf field names, keyed by the last path segment with any `content.` prefix
 * and array indices removed. Covers trip, itinerary content (all types), expense,
 * participant, document, invite, user, email, service identity and OAuth snapshots.
 */
const LEAF_LABELS: Record<string, string> = {
  // common
  id: "ID",
  tripId: "trip",
  type: "type",
  status: "status",
  notes: "notes",
  name: "name",
  email: "email",
  role: "role",
  description: "description",
  createdAt: "created",
  updatedAt: "updated",
  schemaVersion: "schema version",
  // trip
  destination: "destination",
  startDate: "start date",
  endDate: "end date",
  splitwiseGroupId: "Splitwise group",
  // itinerary row
  confirmationNumber: "confirmation number",
  totalCost: "total cost",
  currency: "currency",
  content: "details",
  // flight legs
  legs: "legs",
  airline: "airline",
  flightNumber: "flight number",
  departureAirport: "departure airport",
  departureTime: "departure time",
  departureTimeTz: "departure time zone",
  arrivalAirport: "arrival airport",
  arrivalTime: "arrival time",
  arrivalTimeTz: "arrival time zone",
  fareClass: "fare class",
  baggageAllowance: "baggage allowance",
  seatAssignments: "seat assignments",
  seatNumber: "seat number",
  carriageNumber: "carriage number",
  travelers: "travelers",
  participantId: "participant",
  ticketNumber: "ticket number",
  // lodging
  propertyName: "property",
  address: "address",
  checkIn: "check-in",
  checkInDate: "check-in date",
  checkInTime: "check-in time",
  checkInTimeTz: "check-in time zone",
  checkOut: "check-out",
  checkOutDate: "check-out date",
  checkOutTime: "check-out time",
  checkOutTimeTz: "check-out time zone",
  arrivalDateTime: "arrival time",
  arrivalDateTimeTz: "arrival time zone",
  departureDateTime: "departure time",
  departureDateTimeTz: "departure time zone",
  roomType: "room type",
  boardBasis: "board basis",
  numberOfGuests: "guests",
  // rail
  trainOperator: "operator",
  trainNumber: "train number",
  departureStation: "departure station",
  arrivalStation: "arrival station",
  // car
  rentalCompany: "rental company",
  pickUpLocation: "pick-up location",
  pickUpTime: "pick-up time",
  pickUpTimeTz: "pick-up time zone",
  dropOffLocation: "drop-off location",
  dropOffTime: "drop-off time",
  dropOffTimeTz: "drop-off time zone",
  vehicleType: "vehicle type",
  transmissionType: "transmission",
  mileagePolicy: "mileage policy",
  drivers: "drivers",
  // restaurant
  restaurantName: "restaurant",
  reservationTime: "reservation time",
  reservationTimeTz: "reservation time zone",
  partySize: "party size",
  // transport
  transportType: "transport type",
  operator: "operator",
  departureLocation: "departure location",
  arrivalLocation: "arrival location",
  // activity
  location: "location",
  startTime: "start time",
  startTimeTz: "start time zone",
  endTime: "end time",
  endTimeTz: "end time zone",
  // expense
  amount: "amount",
  category: "category",
  payerId: "payer",
  payerName: "payer",
  splitType: "split type",
  // participant
  userId: "user",
  traveling: "traveling",
  // document
  reservationId: "reservation",
  fileUrl: "file",
  documentType: "document type",
  // invite
  invitedBy: "invited by",
  expiresAt: "expires",
  // user
  avatarUrl: "avatar",
  googleId: "Google ID",
  isPrimary: "primary",
  // service identity
  cfAccessSubject: "CF Access subject",
  commonName: "common name",
  // oauth
  grantId: "grant",
  clientId: "client ID",
  clientName: "client name",
  scopes: "scopes",
  redirectUris: "redirect URIs",
  tokenEndpointAuthMethod: "token auth method",
};

/** Singular word for an array segment, e.g. `legs[0]` becomes "leg 1". */
const ARRAY_SEGMENTS: Record<string, string> = {
  legs: "leg",
  travelers: "traveler",
  seatAssignments: "seat",
  drivers: "driver",
  scopes: "scope",
  redirectUris: "redirect URI",
};

export interface FieldLabelRule {
  pattern: RegExp;
  label: string | ((match: RegExpMatchArray) => string);
}

function leafLabel(name: string): string {
  return LEAF_LABELS[name] ?? humanizeWord(name);
}

/**
 * Pattern table mapping change paths to words, tried in order; the first match wins.
 * Paths are dotted with bracketed array indices, e.g. `content.legs[0].departureTime`.
 */
export const FIELD_LABELS: readonly FieldLabelRule[] = [
  // whole array element added or removed: content.legs[1], content.travelers[2]
  {
    pattern: /^(?:content\.)?(\w+)\[(\d+)\]$/,
    label: (m) => `${ARRAY_SEGMENTS[m[1]] ?? humanizeWord(m[1])} ${Number(m[2]) + 1}`,
  },
  // nested array element: content.legs[0].seatAssignments[1] or ...seatAssignments[1].seatNumber
  {
    pattern: /^(?:content\.)?(\w+)\[(\d+)\]\.(\w+)\[(\d+)\](?:\.(\w+))?$/,
    label: (m) => {
      const outer = `${ARRAY_SEGMENTS[m[1]] ?? humanizeWord(m[1])} ${Number(m[2]) + 1}`;
      const inner = `${ARRAY_SEGMENTS[m[3]] ?? humanizeWord(m[3])} ${Number(m[4]) + 1}`;
      return m[5] ? `${outer} ${inner} ${leafLabel(m[5])}` : `${outer} ${inner}`;
    },
  },
  // field of an array element: content.legs[0].departureTime, content.travelers[1].name
  {
    pattern: /^(?:content\.)?(\w+)\[(\d+)\]\.(\w+)$/,
    label: (m) => `${ARRAY_SEGMENTS[m[1]] ?? humanizeWord(m[1])} ${Number(m[2]) + 1} ${leafLabel(m[3])}`,
  },
  // plain field, with or without the content prefix: status, content.propertyName
  { pattern: /^(?:content\.)?(\w+)$/, label: (m) => leafLabel(m[1]) },
];

/** camelCase or snake_case identifier to lowercase words; "Tz" becomes "time zone". */
function humanizeWord(name: string): string {
  return name
    .replace(/Tz$/, " time zone")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

/** Human label for a change path; unknown shapes fall back to a humanized version of the raw path. */
export function labelForPath(path: string): string {
  for (const rule of FIELD_LABELS) {
    const m = path.match(rule.pattern);
    if (m) return typeof rule.label === "string" ? rule.label : rule.label(m);
  }
  return path
    .replace(/^content\./, "")
    .split(".")
    .map((seg) => {
      const arr = seg.match(/^(\w+)\[(\d+)\]$/);
      if (arr) return `${ARRAY_SEGMENTS[arr[1]] ?? humanizeWord(arr[1])} ${Number(arr[2]) + 1}`;
      return leafLabel(seg);
    })
    .join(" ");
}

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function formatDateOnly(value: string): string {
  return new Date(value + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Wall-clock itinerary times carry no zone; format the stored digits as-is (same approach as ItineraryTimeline). */
function formatWallClock(value: string): string {
  const d = new Date(value + "Z");
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function formatMoney(amount: number, currency: string | undefined): string {
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount);
    } catch {
      /* unknown currency code; fall through */
    }
  }
  const n = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${n} ${currency}` : n;
}

const MONEY_LABELS = new Set(["amount", "total cost"]);

function looksLikeDateLabel(label: string): boolean {
  if (label.endsWith("time zone")) return false;
  return /\b(time|date|expires|created|updated|check-in|check-out)\b/.test(label);
}

/**
 * Formats a value for display. Dates and times are formatted when the label implies them,
 * money when the label is an amount (with `currency` from the snapshot when known),
 * objects as JSON, and undefined or null as "(none)".
 */
export function formatValue(label: string, value: unknown, currency?: string): string {
  if (value === undefined || value === null) return "(none)";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    return MONEY_LABELS.has(label) ? formatMoney(value, currency) : String(value);
  }
  if (typeof value === "string") {
    if (value === "") return "(empty)";
    if (looksLikeDateLabel(label)) {
      if (DATE_ONLY.test(value)) return formatDateOnly(value);
      if (WALL_CLOCK.test(value)) return formatWallClock(value);
      if (ISO_INSTANT.test(value)) return formatDateTime(value);
    }
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function snapshotString(snapshot: AuditSnapshot | null, key: string): string | undefined {
  const v = snapshot?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Currency recorded on the entity, used to format amounts. */
function eventCurrency(e: AuditEvent): string | undefined {
  return snapshotString(e.after, "currency") ?? snapshotString(e.before, "currency");
}

/** Noun for the entity: "Flight", "Lodging" etc. for itineraries (from the snapshot type), else per entity type. */
export function entityNoun(e: AuditEvent): string {
  if (e.entityType === "itinerary") {
    return snapshotString(e.after, "type") ?? snapshotString(e.before, "type") ?? NOUNS.itinerary;
  }
  return (NOUNS as Record<string, string>)[e.entityType] ?? e.entityType.replace(/_/g, " ");
}

function actorDisplay(e: AuditEvent): string {
  return e.actorName?.trim() || e.actorEmail?.trim() || "Someone";
}

/**
 * Client name shown as "via X" for agent and service edits; null for web, dev and backfill.
 * Prefers the registered client name ("Claude"), then the client id (a service identity's common
 * name, or an opaque OAuth id for clients registered without a name), then a generic label.
 */
export function viaLabel(e: AuditEvent): string | null {
  if (!CLIENT_CHANNELS.has(e.channel)) return null;
  return e.clientName?.trim() || e.clientId?.trim() || "an app";
}

function detailKind(change: { from?: unknown; to?: unknown }): AuditDetail["kind"] {
  if (!("from" in change)) return "added";
  if (!("to" in change)) return "removed";
  return "changed";
}

/**
 * One detail row per `changes` key, in the order the API returned them. When the payer
 * changed, the API records both `payerId` and the joined `payerName`; only the name is shown.
 */
export function describeChanges(e: AuditEvent): AuditDetail[] {
  if (!e.changes) return [];
  const hidePayerId = "payerName" in e.changes;
  return Object.entries(e.changes)
    .filter(([path]) => !(hidePayerId && path === "payerId"))
    // Defensive: a non-object change value would make the `in` checks throw during render.
    .filter((entry): entry is [string, { from?: unknown; to?: unknown }] => typeof entry[1] === "object" && entry[1] !== null)
    .map(([path, change]) => ({
    label: labelForPath(path),
    ...("from" in change ? { from: change.from } : {}),
    ...("to" in change ? { to: change.to } : {}),
    kind: detailKind(change),
  }));
}

/** Headline sentence, the "via" client, and the field-level details for an event. */
export function describeEvent(e: AuditEvent): EventDescription {
  const actor = actorDisplay(e);
  const noun = entityNoun(e);
  const subject = e.entityLabel ? `${noun} ${e.entityLabel}` : noun;
  const details = describeChanges(e);
  const via = viaLabel(e);
  const currency = eventCurrency(e);

  if (e.action === "update" && details.length === 1) {
    const d = details[0];
    const field = `${subject} ${d.label}`;
    if (d.kind === "added") {
      return { headline: `${actor} set ${field} to ${formatValue(d.label, d.to, currency)}`, via, details };
    }
    if (d.kind === "removed") {
      return { headline: `${actor} removed ${field}`, via, details };
    }
    if (d.to === null || d.to === undefined) {
      return { headline: `${actor} cleared ${field}`, via, details };
    }
    const from = formatValue(d.label, d.from, currency);
    const to = formatValue(d.label, d.to, currency);
    return { headline: `${actor} changed ${field} from ${from} to ${to}`, via, details };
  }

  let headline = `${actor} ${VERBS[e.action] ?? e.action} ${subject}`;
  if (e.action === "create" && e.entityType === "expense" && typeof e.after?.amount === "number") {
    headline += `, ${formatMoney(e.after.amount, currency)}`;
  }
  return { headline, via, details };
}

/** Keys that add nothing for a reader; the label and noun already identify the entity. */
const SNAPSHOT_SKIP = new Set(["id", "tripId", "schemaVersion"]);

function flattenInto(rows: SnapshotRow[], prefix: string, value: unknown, depth: number, currency?: string): void {
  const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (depth < 4 && (isPlainObject || Array.isArray(value))) {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [`${prefix}[${i}]`, v] as const)
      : Object.entries(value as Record<string, unknown>).map(([k, v]) => [prefix ? `${prefix}.${k}` : k, v] as const);
    if (entries.length === 0) {
      rows.push({ label: labelForPath(prefix), value: "(none)" });
      return;
    }
    for (const [path, v] of entries) flattenInto(rows, path, v, depth + 1, currency);
    return;
  }
  const label = labelForPath(prefix);
  rows.push({ label, value: formatValue(label, value, currency) });
}

/**
 * The entity as a key/value list, for create (from `after`) and delete (from `before`) rows.
 * Nested itinerary content is flattened so labels match the change rows ("leg 1 departure time").
 */
export function describeSnapshot(e: AuditEvent): SnapshotRow[] {
  const snapshot = e.action === "delete" ? (e.before ?? e.after) : (e.after ?? e.before);
  if (!snapshot) return [];
  const rows: SnapshotRow[] = [];
  const currency = eventCurrency(e);
  const hidePayerId = "payerName" in snapshot;
  for (const [key, value] of Object.entries(snapshot)) {
    if (SNAPSHOT_SKIP.has(key)) continue;
    if (hidePayerId && key === "payerId") continue;
    flattenInto(rows, key, value, 0, currency);
  }
  return rows;
}

/** Event timestamp with the year, for feeds that may span years. */
export function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
