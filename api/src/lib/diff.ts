/**
 * Structural diff of two entity snapshots for the audit log.
 *
 * Rules (see specs/AUDIT_TDD.md section 5):
 * 1. Both sides plain objects: recurse over the union of keys, segment `.key`
 *    (root keys have no leading dot).
 * 2. Both sides arrays: recurse by index over the longer length, segment `[i]`.
 *    An index present on one side only yields `{ from }` or `{ to }` with the
 *    whole element.
 * 3. Otherwise (primitives, null, type mismatch): compare with `deepEqual`; if
 *    different, emit `{ from, to }` at the current path, omitting whichever
 *    side is `undefined`.
 * 4. `IGNORED_PATHS` are skipped at the root only.
 */

export type Snapshot = Record<string, unknown>;

/**
 * `{ "<path>": { from?, to? } }`. A missing `from` means the path did not
 * exist before; a missing `to` means it was removed. Keys are omitted rather
 * than set to `null` so "became null" and "was removed" stay distinguishable.
 */
export type Changes = Record<string, { from?: unknown; to?: unknown }>;

/** Root-level keys never reported as changes. */
export const IGNORED_PATHS: ReadonlySet<string> = new Set(["createdAt", "updatedAt"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Structural equality: primitives by `===` (NaN equals NaN), arrays by index, plain objects by key set regardless of order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function leaf(out: Changes, path: string, from: unknown, to: unknown): void {
  if (deepEqual(from, to)) return;
  const entry: { from?: unknown; to?: unknown } = {};
  if (from !== undefined) entry.from = from;
  if (to !== undefined) entry.to = to;
  out[path] = entry;
}

function walk(out: Changes, path: string, before: unknown, after: unknown): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (path === "" && IGNORED_PATHS.has(key)) continue;
      walk(out, path === "" ? key : `${path}.${key}`, before[key], after[key]);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= before.length) {
        out[childPath] = { to: after[i] };
      } else if (i >= after.length) {
        out[childPath] = { from: before[i] };
      } else {
        walk(out, childPath, before[i], after[i]);
      }
    }
    return;
  }
  leaf(out, path, before, after);
}

/**
 * Diff two snapshots of the same entity. Returns `{}` when either side is
 * null; create and delete events store whole snapshots and do not use a diff.
 */
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): Changes {
  const out: Changes = {};
  if (before === null || after === null) return out;
  walk(out, "", before, after);
  return out;
}
