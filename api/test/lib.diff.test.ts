// lib/diff.ts: diffSnapshots, deepEqual, IGNORED_PATHS. Pure module; no D1 seeding needed.
// Rules and worked examples: specs/AUDIT_TDD.md section 5.
import { describe, expect, it } from "vitest";
import { IGNORED_PATHS, deepEqual, diffSnapshots, type Changes, type Snapshot } from "../src/lib/diff";

// A FlightContent-shaped itinerary row, as in the TDD 5 examples.
const leg0 = {
  carrier: "ZZ",
  flightNumber: "ZZ100",
  from: "AAA",
  to: "BBB",
  departureTime: "2026-11-02T08:10",
  arrivalTime: "2026-11-02T11:30",
  fareClass: "Y",
};
const leg1 = {
  carrier: "ZZ",
  flightNumber: "ZZ200",
  from: "BBB",
  to: "CCC",
  departureTime: "2026-11-02T13:00",
  arrivalTime: "2026-11-02T15:20",
};

function itineraryRow(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "itin_fake_1",
    tripId: "trip_fake_1",
    type: "flight",
    status: "Pending",
    notes: "Call ahead",
    content: { legs: [structuredClone(leg0)] },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("diffSnapshots: TDD section 5 worked examples", () => {
  it("status Pending to Confirmed emits `status`", () => {
    const before = itineraryRow();
    const after = itineraryRow({ status: "Confirmed" });
    expect(diffSnapshots(before, after)).toEqual<Changes>({
      status: { from: "Pending", to: "Confirmed" },
    });
  });

  it("leg 0 departure time emits `content.legs[0].departureTime`", () => {
    const before = itineraryRow();
    const after = itineraryRow({
      content: { legs: [{ ...leg0, departureTime: "2026-11-02T09:45" }] },
    });
    expect(diffSnapshots(before, after)).toEqual<Changes>({
      "content.legs[0].departureTime": { from: "2026-11-02T08:10", to: "2026-11-02T09:45" },
    });
  });

  it("second leg added emits `content.legs[1]` with `to` only and the whole leg", () => {
    const before = itineraryRow();
    const after = itineraryRow({ content: { legs: [structuredClone(leg0), structuredClone(leg1)] } });
    const changes = diffSnapshots(before, after);
    expect(changes).toEqual<Changes>({
      "content.legs[1]": { to: leg1 },
    });
    expect("from" in changes["content.legs[1]"]).toBe(false);
  });

  it("notes cleared to null emits `notes` with `to: null` (null, not absent)", () => {
    const before = itineraryRow();
    const after = itineraryRow({ notes: null });
    const changes = diffSnapshots(before, after);
    expect(changes).toEqual<Changes>({
      notes: { from: "Call ahead", to: null },
    });
    expect("to" in changes.notes).toBe(true);
    expect(changes.notes.to).toBeNull();
  });

  it("optional fareClass removed from leg 0 emits `content.legs[0].fareClass` with `from` only", () => {
    const before = itineraryRow();
    const { fareClass: _dropped, ...legWithoutFare } = leg0;
    const after = itineraryRow({ content: { legs: [legWithoutFare] } });
    const changes = diffSnapshots(before, after);
    expect(changes).toEqual<Changes>({
      "content.legs[0].fareClass": { from: "Y" },
    });
    expect("to" in changes["content.legs[0].fareClass"]).toBe(false);
  });
});

describe("diffSnapshots: null vs absent are distinguishable", () => {
  it("value set to null keeps a `to: null` key", () => {
    const changes = diffSnapshots({ a: 1 }, { a: null });
    expect(changes).toEqual({ a: { from: 1, to: null } });
    expect(Object.keys(changes.a)).toEqual(["from", "to"]);
  });

  it("value removed omits `to` entirely", () => {
    const changes = diffSnapshots({ a: 1 }, {});
    expect(changes).toEqual({ a: { from: 1 } });
    expect(Object.keys(changes.a)).toEqual(["from"]);
  });

  it("value explicitly undefined is treated as absent (no `to` key)", () => {
    const changes = diffSnapshots({ a: 1 }, { a: undefined });
    expect(changes).toEqual({ a: { from: 1 } });
    expect("to" in changes.a).toBe(false);
  });

  it("null to a value emits `from: null`", () => {
    expect(diffSnapshots({ a: null }, { a: "x" })).toEqual({ a: { from: null, to: "x" } });
  });

  it("null to null is no change", () => {
    expect(diffSnapshots({ a: null }, { a: null })).toEqual({});
  });
});

describe("diffSnapshots: ignored root paths", () => {
  it("IGNORED_PATHS is exactly createdAt and updatedAt", () => {
    expect([...IGNORED_PATHS].sort()).toEqual(["createdAt", "updatedAt"]);
  });

  it("root createdAt and updatedAt changes are not reported", () => {
    const before = { name: "a", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    const after = { name: "a", createdAt: "2026-02-02T00:00:00Z", updatedAt: "2026-02-02T00:00:00Z" };
    expect(diffSnapshots(before, after)).toEqual({});
  });

  it("only updatedAt differing alongside a real change reports just the real change", () => {
    const before = { name: "a", updatedAt: "2026-01-01T00:00:00Z" };
    const after = { name: "b", updatedAt: "2026-02-02T00:00:00Z" };
    expect(diffSnapshots(before, after)).toEqual({ name: { from: "a", to: "b" } });
  });

  it("nested createdAt/updatedAt are NOT ignored", () => {
    const before = { c: { createdAt: "2026-01-01T00:00:00Z", updatedAt: "x" } };
    const after = { c: { createdAt: "2026-02-02T00:00:00Z", updatedAt: "y" } };
    expect(diffSnapshots(before, after)).toEqual({
      "c.createdAt": { from: "2026-01-01T00:00:00Z", to: "2026-02-02T00:00:00Z" },
      "c.updatedAt": { from: "x", to: "y" },
    });
  });

  it("createdAt inside an array element is NOT ignored", () => {
    const before = { xs: [{ createdAt: "a" }] };
    const after = { xs: [{ createdAt: "b" }] };
    expect(diffSnapshots(before, after)).toEqual({ "xs[0].createdAt": { from: "a", to: "b" } });
  });

  it("ignored root key added or removed is still ignored", () => {
    expect(diffSnapshots({ a: 1 }, { a: 1, createdAt: "x" })).toEqual({});
    expect(diffSnapshots({ a: 1, updatedAt: "x" }, { a: 1 })).toEqual({});
  });
});

describe("diffSnapshots: flat rows", () => {
  it("identical snapshots produce an empty diff", () => {
    const row = itineraryRow();
    expect(diffSnapshots(row, structuredClone(row))).toEqual({});
  });

  it("same object reference produces an empty diff", () => {
    const row = itineraryRow();
    expect(diffSnapshots(row, row)).toEqual({});
  });

  it("key order alone yields {}", () => {
    expect(diffSnapshots({ a: 1, b: 2, c: 3 }, { c: 3, b: 2, a: 1 })).toEqual({});
  });

  it("nested key order alone yields {}", () => {
    expect(diffSnapshots({ o: { a: 1, b: { x: 1, y: 2 } } }, { o: { b: { y: 2, x: 1 }, a: 1 } })).toEqual({});
  });

  it("root key removed emits `from` only", () => {
    const changes = diffSnapshots({ a: 1, b: "gone" }, { a: 1 });
    expect(changes).toEqual({ b: { from: "gone" } });
    expect("to" in changes.b).toBe(false);
  });

  it("root key added emits `to` only", () => {
    const changes = diffSnapshots({ a: 1 }, { a: 1, b: "new" });
    expect(changes).toEqual({ b: { to: "new" } });
    expect("from" in changes.b).toBe(false);
  });

  it("multiple root changes are all reported with no leading dot", () => {
    const changes = diffSnapshots({ a: 1, b: 2, c: 3 }, { a: 10, b: 2, c: 30 });
    expect(changes).toEqual({ a: { from: 1, to: 10 }, c: { from: 3, to: 30 } });
    for (const k of Object.keys(changes)) expect(k.startsWith(".")).toBe(false);
  });

  it("primitive type changes are reported (number to string)", () => {
    expect(diffSnapshots({ n: 1 }, { n: "1" })).toEqual({ n: { from: 1, to: "1" } });
  });

  it("boolean flips are reported", () => {
    expect(diffSnapshots({ b: false }, { b: true })).toEqual({ b: { from: false, to: true } });
  });

  it("0 and false are not conflated", () => {
    expect(diffSnapshots({ v: 0 }, { v: false })).toEqual({ v: { from: 0, to: false } });
  });

  it("empty string and null are not conflated", () => {
    expect(diffSnapshots({ v: "" }, { v: null })).toEqual({ v: { from: "", to: null } });
  });
});

describe("diffSnapshots: type mismatch at a leaf", () => {
  it("object vs string emits both sides at that path (no recursion)", () => {
    const before = { content: { legs: [] } };
    const after = { content: "oops" };
    expect(diffSnapshots(before, after)).toEqual({
      content: { from: { legs: [] }, to: "oops" },
    });
  });

  it("string vs object emits both sides at that path", () => {
    expect(diffSnapshots({ c: "x" }, { c: { a: 1 } })).toEqual({ c: { from: "x", to: { a: 1 } } });
  });

  it("array vs object emits both sides at that path", () => {
    expect(diffSnapshots({ c: [1] }, { c: { 0: 1 } })).toEqual({ c: { from: [1], to: { 0: 1 } } });
  });

  it("object vs null emits both sides at that path", () => {
    expect(diffSnapshots({ c: { a: 1 } }, { c: null })).toEqual({ c: { from: { a: 1 }, to: null } });
  });

  it("nested object vs string emits at the nested path", () => {
    expect(diffSnapshots({ a: { b: { c: 1 } } }, { a: { b: "flat" } })).toEqual({
      "a.b": { from: { c: 1 }, to: "flat" },
    });
  });
});

describe("diffSnapshots: arrays", () => {
  it("shrink [1,2,3] to [1] emits xs[1] and xs[2] with `from` only", () => {
    const changes = diffSnapshots({ xs: [1, 2, 3] }, { xs: [1] });
    expect(changes).toEqual({ "xs[1]": { from: 2 }, "xs[2]": { from: 3 } });
    expect("to" in changes["xs[1]"]).toBe(false);
    expect("to" in changes["xs[2]"]).toBe(false);
  });

  it("growth [1] to [1,2,3] emits xs[1] and xs[2] with `to` only", () => {
    const changes = diffSnapshots({ xs: [1] }, { xs: [1, 2, 3] });
    expect(changes).toEqual({ "xs[1]": { to: 2 }, "xs[2]": { to: 3 } });
    expect("from" in changes["xs[1]"]).toBe(false);
    expect("from" in changes["xs[2]"]).toBe(false);
  });

  it("empty to non-empty emits each new index", () => {
    expect(diffSnapshots({ xs: [] }, { xs: ["a"] })).toEqual({ "xs[0]": { to: "a" } });
  });

  it("non-empty to empty emits each removed index", () => {
    expect(diffSnapshots({ xs: ["a", "b"] }, { xs: [] })).toEqual({ "xs[0]": { from: "a" }, "xs[1]": { from: "b" } });
  });

  it("element change at an index emits `xs[i]` with both sides", () => {
    expect(diffSnapshots({ xs: [1, 2, 3] }, { xs: [1, 20, 3] })).toEqual({ "xs[1]": { from: 2, to: 20 } });
  });

  it("element change inside an array of objects emits the nested path", () => {
    const before = { legs: [{ from: "AAA", to: "BBB" }, { from: "BBB", to: "CCC" }] };
    const after = { legs: [{ from: "AAA", to: "BBB" }, { from: "BBB", to: "DDD" }] };
    expect(diffSnapshots(before, after)).toEqual({ "legs[1].to": { from: "CCC", to: "DDD" } });
  });

  it("an added element that is itself an array is emitted whole", () => {
    expect(diffSnapshots({ m: [[1]] }, { m: [[1], [2, 3]] })).toEqual({ "m[1]": { to: [2, 3] } });
  });

  it("nested arrays recurse with [i][j] paths", () => {
    expect(diffSnapshots({ m: [[1, 2]] }, { m: [[1, 3]] })).toEqual({ "m[0][1]": { from: 2, to: 3 } });
  });

  it("identical arrays produce no change", () => {
    expect(diffSnapshots({ xs: [1, { a: [2] }] }, { xs: [1, { a: [2] }] })).toEqual({});
  });

  it("insert at front reports every shifted index (documented v1 behavior)", () => {
    const changes = diffSnapshots({ xs: ["b", "c"] }, { xs: ["a", "b", "c"] });
    expect(changes).toEqual({
      "xs[0]": { from: "b", to: "a" },
      "xs[1]": { from: "c", to: "b" },
      "xs[2]": { to: "c" },
    });
  });

  it("array element that is null on one side is a leaf change", () => {
    expect(diffSnapshots({ xs: [null] }, { xs: [{ a: 1 }] })).toEqual({ "xs[0]": { from: null, to: { a: 1 } } });
  });
});

describe("diffSnapshots: null snapshots", () => {
  it("before null returns {}", () => {
    expect(diffSnapshots(null, { a: 1 })).toEqual({});
  });

  it("after null returns {}", () => {
    expect(diffSnapshots({ a: 1 }, null)).toEqual({});
  });

  it("both null returns {}", () => {
    expect(diffSnapshots(null, null)).toEqual({});
  });

  it("two empty snapshots return {}", () => {
    expect(diffSnapshots({}, {})).toEqual({});
  });
});

describe("diffSnapshots: output hygiene", () => {
  it("returns a fresh object each call", () => {
    const a = diffSnapshots({ x: 1 }, { x: 2 });
    const b = diffSnapshots({ x: 1 }, { x: 2 });
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("does not mutate its inputs", () => {
    const before = itineraryRow();
    const after = itineraryRow({ status: "Confirmed", content: { legs: [structuredClone(leg0), structuredClone(leg1)] } });
    const beforeCopy = structuredClone(before);
    const afterCopy = structuredClone(after);
    diffSnapshots(before, after);
    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });

  it("every entry has at least one of from/to and no other keys", () => {
    const changes = diffSnapshots(
      { a: 1, b: [1, 2], c: { d: "x" }, e: "gone" },
      { a: 2, b: [1], c: { d: "y", f: 1 }, g: "new" },
    );
    expect(Object.keys(changes).sort()).toEqual(["a", "b[1]", "c.d", "c.f", "e", "g"]);
    for (const entry of Object.values(changes)) {
      const keys = Object.keys(entry);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(["from", "to"]).toContain(k);
    }
  });
});

describe("deepEqual", () => {
  it("primitives compare by ===", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(0, false)).toBe(false);
    expect(deepEqual("", null)).toBe(false);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(undefined, null)).toBe(false);
  });

  it("NaN equals NaN", () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(Number.NaN, 0)).toBe(false);
  });

  it("nested objects are equal regardless of key order", () => {
    expect(deepEqual({ a: 1, b: { c: 2, d: [3] } }, { b: { d: [3], c: 2 }, a: 1 })).toBe(true);
  });

  it("objects with different key sets are not equal", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it("arrays compare by index and length", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepEqual([[1], [2]], [[1], [2]])).toBe(true);
    expect(deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(deepEqual([{ a: 1 }], [{ a: 2 }])).toBe(false);
  });

  it("array vs object is not equal in either direction", () => {
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({}, [])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });

  it("null vs {} is false in either direction", () => {
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual({}, {})).toBe(true);
  });

  it("null vs [] is false", () => {
    expect(deepEqual(null, [])).toBe(false);
    expect(deepEqual([], null)).toBe(false);
  });
});
