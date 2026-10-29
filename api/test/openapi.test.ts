// OpenAPI parity: GET /openapi.json through the real Worker must stay byte-identical (after
// pretty-printing) to the committed snapshot. MCP_TDD 4.4: "OpenAPI output must not change."
// If this fails during Phase 1, the refactor changed the documented REST contract. Do not run
// `vitest -u` to accept it without the orchestrator's sign-off.
import { describe, expect, it } from "vitest";
import { anonymous } from "./helpers";

describe("OpenAPI document", () => {
  it.each(["/openapi.json", "/api/openapi.json"])("GET %s is public and matches the committed snapshot", async (path) => {
    const res = await anonymous().get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const doc = await res.json();
    await expect(JSON.stringify(doc, null, 2) + "\n").toMatchFileSnapshot("./__snapshots__/openapi.json");
  });
});
