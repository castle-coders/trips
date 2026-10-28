// Hardening: output-schema mismatches become a fixed "Internal error" (L5); internal-error logs are clipped (L6).
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedItinerary } from "./helpers";
import { IDS, seedMcpWorld } from "./helpers/mcp";
import { withTool } from "../src/mcp/tools/withTool";

afterEach(() => vi.restoreAllMocks());

function captureLogs() {
  const logs: string[] = [];
  const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  return logs;
}

describe("output validation guard (L5)", () => {
  it("a stored status outside the enum yields 'Internal error' with no schema path, and an err=output log", async () => {
    const w = await seedMcpWorld();
    await seedItinerary(IDS.trip, { status: "Legacy-Weird-Status" as never, content: { name: "Odd", startTime: "2030-01-12T10:00" } });
    const logs = captureLogs();

    // get_trip's itineraries are an open record, so it is unaffected; search_itineraries has a status enum.
    const g = await w.mcp.owner.call("get_trip", { tripId: IDS.trip });
    expect(g.isError, g.text).toBe(false);

    for (const [tool, args] of [["search_itineraries", { tripId: IDS.trip }]] as const) {
      const r = await w.mcp.owner.call(tool, args);
      expect(r.isError, `${tool}: ${r.text}`).toBe(true);
      expect(r.text).toBe("Internal error");
      expect(r.structured).toBeUndefined();
      expect(r.reply.raw).not.toMatch(/Output validation error|itineraries\[|status|Legacy-Weird-Status/);
      expect(logs.some((l) => new RegExp(`^\\[mcp\\] tool=${tool} .* ok=false err=output paths=\\S*status`).test(l)), logs.join("\n")).toBe(true);
    }

    for (const l of logs) expect(l).not.toContain("Legacy-Weird-Status");
  });

  it("a normal call still returns structuredContent", async () => {
    const w = await seedMcpWorld();
    const logs = captureLogs();
    const r = await w.mcp.owner.call("get_trip", { tripId: IDS.trip });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.trip.id).toBe(IDS.trip);
    expect(logs.some((l) => /err=output/.test(l))).toBe(false);
  });
});

describe("internal error log (L6)", () => {
  it("logs the error name and a clipped, single-line message", async () => {
    const logs = captureLogs();
    const rc = { user: { id: "u1" }, scopes: ["trips:read"] } as never;
    const msg = "boom\nforged=1 " + "x".repeat(500);
    const r = await withTool(rc, "t", "trips:read", async () => {
      throw new TypeError(msg);
    })({});
    expect(r).toEqual({ isError: true, content: [{ type: "text", text: "Internal error" }] });
    const l = logs.find((x) => x.includes("internal error:"))!;
    expect(l).toContain("TypeError");
    expect(l).not.toContain("\n");
    expect(l.length).toBeLessThan(300);
    expect(l).not.toContain("x".repeat(250));
  });
});
