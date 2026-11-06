// MCP support for the Parking itinerary type (issue #40): advertised in tools/list, creatable
// via create_itinerary, and split into entry/exit timeline entries by get_trip.
import { describe, expect, it } from "vitest";
import { seedTrip, seedUser } from "./helpers";
import { authFor, mcpDirect } from "./helpers/mcp";

describe("MCP Parking itineraries", () => {
  it("create_itinerary and search_itineraries advertise Parking and its content fields", async () => {
    const u = await seedUser("parker@example.test", "editor");
    const tools: any[] = await mcpDirect(authFor(u.id)).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const create = byName.create_itinerary.inputSchema.properties;
    expect(create.type.enum).toContain("Parking");
    expect(create.content.description).toContain(
      "Parking: {facilityName: string, address?: string, entryTime: string, entryTimeTz?: string, exitTime: string, exitTimeTz?: string",
    );
    expect(byName.update_itinerary.inputSchema.properties.type.enum).toContain("Parking");
    expect(byName.search_itineraries.inputSchema.properties.types.items.enum).toContain("Parking");
  });

  it("creates a Parking item and get_trip shows entry and exit on their own days", async () => {
    const u = await seedUser("parker@example.test", "editor");
    const { trip } = await seedTrip(u.id, { name: "Parking Trip" });
    const c = mcpDirect(authFor(u.id));

    const created = await c.call("create_itinerary", {
      tripId: trip.id,
      type: "Parking",
      status: "Confirmed",
      content: {
        facilityName: "SFO Long Term",
        entryTime: "2090-07-01T06:00",
        entryTimeTz: "America/Los_Angeles",
        exitTime: "2090-07-05T21:30",
        exitTimeTz: "America/Los_Angeles",
        licensePlate: "8ABC123",
      },
    });
    expect(created.isError, created.text).toBe(false);
    const id = created.structured.itinerary.id;
    expect(created.structured.itinerary.type).toBe("Parking");

    const r = await c.call("get_trip", { tripId: trip.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.days).toEqual([
      { date: "2090-07-01", entries: [{ itineraryId: id, kind: "Parking-entry", time: "2090-07-01T06:00", timeZone: "America/Los_Angeles" }] },
      { date: "2090-07-05", entries: [{ itineraryId: id, kind: "Parking-exit", time: "2090-07-05T21:30", timeZone: "America/Los_Angeles" }] },
    ]);

    // A date filter on a day strictly between entry and exit still finds the stay.
    const s = await c.call("search_itineraries", { tripId: trip.id, from: "2090-07-03", to: "2090-07-03" });
    expect(s.isError, s.text).toBe(false);
    expect(s.structured.itineraries.map((i: any) => i.id)).toEqual([id]);
  });

  it("rejects Parking content missing exitTime with a field hint", async () => {
    const u = await seedUser("parker@example.test", "editor");
    const { trip } = await seedTrip(u.id, { name: "Parking Trip" });
    const r = await mcpDirect(authFor(u.id)).call("create_itinerary", {
      tripId: trip.id,
      type: "Parking",
      content: { facilityName: "Garage", entryTime: "2090-07-01T06:00" },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/exitTime/);
  });
});
