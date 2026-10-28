// Shared helpers for the REST parity-baseline tests (test/trips*, itineraries*, expenses*).
// Domain-neutral: each domain test file builds its own data on top of seedRoleWorld().
import { asUser, type TestFetch } from "./http";
import { addParticipant, seedTrip, seedUser, type SeededParticipant, type SeededTrip, type SeededUser } from "./seed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Server-generated timestamps (new Date().toISOString()). Content times like "2030-01-10T09:00" do not match. */
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Make a response body snapshot-stable:
 * - strings equal to a key of `labels` become `<label>`
 * - any other UUID becomes `<uuid:N>` (numbered by first appearance, so relationships stay visible)
 * - server ISO timestamps become `<timestamp>`
 * Note: vitest's snapshot serializer sorts object keys, so snapshots do not pin JSON key order.
 */
export function normalize<T = unknown>(value: unknown, labels: Record<string, string> = {}): T {
  const unknownIds = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (labels[v]) return `<${labels[v]}>`;
      if (UUID_RE.test(v)) {
        if (!unknownIds.has(v)) unknownIds.set(v, `<uuid:${unknownIds.size + 1}>`);
        return unknownIds.get(v);
      }
      if (ISO_TS_RE.test(v)) return "<timestamp>";
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/** Sort an array of rows by id (list endpoints have no ORDER BY, so parity should not depend on row order). */
export function byId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

/** Read status + parsed body (JSON when possible, else text, else null for empty bodies). */
export async function read(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Collect every key name appearing anywhere in a JSON value. */
export function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

export const ACTORS = ["admin", "owner", "editor", "viewer", "outsider"] as const;
export type Actor = (typeof ACTORS)[number];

/** Fixed ids so snapshots are readable and stable. All values are obviously fake. */
export const IDS = {
  admin: "00000000-0000-4000-8000-00000000a001",
  owner: "00000000-0000-4000-8000-00000000a002",
  editor: "00000000-0000-4000-8000-00000000a003",
  viewer: "00000000-0000-4000-8000-00000000a004",
  outsider: "00000000-0000-4000-8000-00000000a005",
  trip: "00000000-0000-4000-8000-00000000b001",
  otherTrip: "00000000-0000-4000-8000-00000000b002",
  ownerP: "00000000-0000-4000-8000-00000000c002",
  editorP: "00000000-0000-4000-8000-00000000c003",
  viewerP: "00000000-0000-4000-8000-00000000c004",
  guestP: "00000000-0000-4000-8000-00000000c009",
  outsiderP: "00000000-0000-4000-8000-00000000c005",
  missing: "00000000-0000-4000-8000-00000000dead",
} as const;

export interface RoleWorld {
  users: Record<Actor, SeededUser>;
  /** The trip under test. owner=Owner, editor=Editor, viewer=Viewer participants, plus a non-user guest. admin is NOT a participant. */
  trip: SeededTrip;
  /** A second trip owned by `outsider`; nobody else is a participant. */
  otherTrip: SeededTrip;
  participants: { owner: SeededParticipant; editor: SeededParticipant; viewer: SeededParticipant; guest: SeededParticipant; outsider: SeededParticipant };
  as: Record<Actor, TestFetch>;
  /** id -> label map for normalize(). */
  labels: Record<string, string>;
}

/**
 * Seed the five-actor world used by every parity test:
 * - admin    global admin, not a participant of any trip
 * - owner    global editor, Owner of `trip`
 * - editor   global editor, Editor of `trip`
 * - viewer   global viewer, Viewer of `trip`
 * - outsider global editor, not a participant of `trip`; Owner of `otherTrip`
 */
export async function seedRoleWorld(): Promise<RoleWorld> {
  const admin = await seedUser("admin@example.test", "admin", { id: IDS.admin, name: "Admin User" });
  const owner = await seedUser("owner@example.test", "editor", { id: IDS.owner, name: "Owner User" });
  const editor = await seedUser("editor@example.test", "editor", { id: IDS.editor, name: "Editor User" });
  const viewer = await seedUser("viewer@example.test", "viewer", { id: IDS.viewer, name: "Viewer User" });
  const outsider = await seedUser("outsider@example.test", "editor", { id: IDS.outsider, name: "Outsider User" });

  const { trip } = await seedTrip(null, {
    id: IDS.trip,
    name: "Parity Trip",
    destination: "Testville",
    startDate: "2090-03-01",
    endDate: "2090-03-08",
    description: "Fake trip for parity tests",
  });
  const ownerP = await addParticipant(trip.id, owner.id, "Owner", { id: IDS.ownerP });
  const editorP = await addParticipant(trip.id, editor.id, "Editor", { id: IDS.editorP });
  const viewerP = await addParticipant(trip.id, viewer.id, "Viewer", { id: IDS.viewerP, traveling: false });
  const guestP = await addParticipant(trip.id, null, "Viewer", { id: IDS.guestP, name: "Guest Traveler", email: null });

  const { trip: otherTrip } = await seedTrip(null, {
    id: IDS.otherTrip,
    name: "Other Trip",
    destination: "Elsewhere",
    startDate: "2091-05-01",
    endDate: "2091-05-03",
  });
  const outsiderP = await addParticipant(otherTrip.id, outsider.id, "Owner", { id: IDS.outsiderP });

  const users = { admin, owner, editor, viewer, outsider };
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(IDS)) labels[v] = k;

  return {
    users,
    trip,
    otherTrip,
    participants: { owner: ownerP, editor: editorP, viewer: viewerP, guest: guestP, outsider: outsiderP },
    as: Object.fromEntries(ACTORS.map((a) => [a, asUser(users[a].email)])) as Record<Actor, TestFetch>,
    labels,
  };
}
