// MCP tools/list: the nine v1 tools (PRD 6.1, TDD 6.4) with annotations, schemas and descriptions.
import { describe, expect, it } from "vitest";
import { seedUser } from "./helpers";
import { ALL_TOOLS, READ_TOOLS, WRITE_TOOLS, authFor, mcpDirect, mcpStage1 } from "./helpers/mcp";

describe("MCP tools/list", () => {
  it("lists exactly the nine v1 tools", async () => {
    const u = await seedUser("lister@example.test", "editor");
    const tools = await mcpDirect(authFor(u.id)).listTools();
    expect(tools.map((t: any) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it("read tools are annotated readOnlyHint=true, destructiveHint=false; write tools readOnlyHint=false", async () => {
    const u = await seedUser("lister@example.test", "editor");
    const tools: any[] = await mcpDirect(authFor(u.id)).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of READ_TOOLS) {
      expect(byName[name].annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of WRITE_TOOLS) {
      expect(byName[name].annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    // Idempotency: create_* and add_expense are not idempotent; update is.
    expect(byName.create_trip.annotations.idempotentHint).toBe(false);
    expect(byName.create_itinerary.annotations.idempotentHint).toBe(false);
    expect(byName.add_expense.annotations.idempotentHint).toBe(false);
    expect(byName.update_itinerary.annotations.idempotentHint).toBe(true);
  });

  it("every tool has a title, a description naming its scope, an object inputSchema and an outputSchema", async () => {
    const u = await seedUser("lister@example.test", "editor");
    const tools: any[] = await mcpDirect(authFor(u.id)).listTools();
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(typeof t.description, t.name).toBe("string");
      const scope = (WRITE_TOOLS as readonly string[]).includes(t.name) ? "trips:write" : "trips:read";
      expect(t.description, t.name).toContain(scope);
      expect(t.inputSchema?.type, t.name).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
    }
  });

  it("id inputs are declared as UUID strings and required where needed", async () => {
    const u = await seedUser("lister@example.test", "editor");
    const tools: any[] = await mcpDirect(authFor(u.id)).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["get_trip", "list_expenses", "create_itinerary", "update_itinerary", "add_expense"]) {
      const s = byName[name].inputSchema;
      expect(s.required, name).toContain("tripId");
      expect(s.properties.tripId.type, name).toBe("string");
      expect(s.properties.tripId.format, name).toBe("uuid");
    }
    expect(byName.update_itinerary.inputSchema.required).toContain("itineraryId");
    expect(byName.search_itineraries.inputSchema.required ?? []).not.toContain("tripId");
    expect(byName.search_itineraries.inputSchema.properties.limit).toMatchObject({ maximum: 200, minimum: 1 });
    expect(byName.create_trip.inputSchema.required).toEqual(["name"]);
  });

  it("tools/list is the same over the Stage 1 route", async () => {
    const u = await seedUser("lister@example.test", "editor");
    const direct = (await mcpDirect(authFor(u.id)).listTools()).map((t: any) => t.name).sort();
    const stage1 = (await mcpStage1(u.email).listTools()).map((t: any) => t.name).sort();
    expect(stage1).toEqual(direct);
  });

  it("tools/list still lists every tool for a caller with no scopes (calls are refused, not hidden)", async () => {
    const u = await seedUser("lister@example.test", "editor");
    const tools = await mcpDirect(authFor(u.id, [])).listTools();
    expect(tools).toHaveLength(9);
  });
});
