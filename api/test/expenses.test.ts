// REST parity baseline: /trips/:tripId/expenses (list, create, update, delete; there is no GET by id).
// Encodes TODAY's behavior. The Phase 1 expenses extractor must keep every test here green and
// every snapshot unchanged. No deliberate behavior change is planned for expenses.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTORS,
  IDS,
  addParticipant,
  asUser,
  byId,
  normalize,
  read,
  seedExpense,
  seedRoleWorld,
  seedUser,
  type Actor,
  type RoleWorld,
} from "./helpers";

const EX = {
  dinner: "00000000-0000-4000-8000-00000000f001",
  taxi: "00000000-0000-4000-8000-00000000f002",
  other: "00000000-0000-4000-8000-00000000f003",
} as const;

let w: RoleWorld;
let labels: Record<string, string>;
beforeEach(async () => {
  w = await seedRoleWorld();
  labels = { ...w.labels, ...Object.fromEntries(Object.entries(EX).map(([k, v]) => [v, `ex:${k}`])) };
  await seedExpense(IDS.trip, { id: EX.dinner, description: "Dinner", amount: 88.4, currency: "EUR", category: "Food", payerId: IDS.ownerP, splitType: "EQUAL" });
  await seedExpense(IDS.trip, { id: EX.taxi, description: "Taxi", amount: 12, currency: "USD", category: "Transport", payerId: null, splitType: "EXACT" });
  await seedExpense(IDS.otherTrip, { id: EX.other, description: "Elsewhere snack", payerId: IDS.outsiderP });
});

const base = `/api/trips/${IDS.trip}/expenses`;
const dbRow = (id: string) => env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first<Record<string, unknown>>();
const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM expenses").first<{ n: number }>())!.n;

describe("GET /trips/:tripId/expenses", () => {
  const expected: Record<Actor, number> = { admin: 200, owner: 200, editor: 200, viewer: 200, outsider: 404 };

  it.each(ACTORS)("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].get(base));
    expect(status).toBe(expected[actor]);
    expect(normalize(status === 200 ? byId(body) : body, labels)).toMatchSnapshot();
  });

  it("viewer gets exactly the same rows as the owner (no expense projection; payerId only, no payer name)", async () => {
    const asOwner = await read(await w.as.owner.get(base));
    const asViewer = await read(await w.as.viewer.get(base));
    expect(asViewer.body).toEqual(asOwner.body);
    for (const row of asViewer.body) expect(Object.keys(row).sort()).toEqual(
      ["amount", "category", "createdAt", "currency", "description", "id", "payerId", "splitType", "tripId", "updatedAt"]
    );
  });

  it("non-admin gets 404 'Trip not found' for a trip id that does not exist", async () => {
    const res = await read(await w.as.owner.get(`/api/trips/${IDS.missing}/expenses`));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("CURRENT BEHAVIOR — may change in Phase 1: admin gets 200 [] for a trip id that does not exist", async () => {
    // Stays 200 [] unless requireTripRole checks trip existence for admins (TDD 4.2 does not say).
    const res = await read(await w.as.admin.get(`/api/trips/${IDS.missing}/expenses`));
    expect(res).toEqual({ status: 200, body: [] });
  });

  it("there is no GET by id: /expenses/:expenseId falls through to Hono's 404", async () => {
    const res = await read(await w.as.owner.get(`${base}/${EX.dinner}`));
    expect(res).toEqual({ status: 404, body: "404 Not Found" });
  });
});

describe("POST /trips/:tripId/expenses", () => {
  const input = { description: "Museum tickets", amount: 30, currency: "EUR", category: "Entertainment", payerId: IDS.editorP, splitType: "EQUAL" };
  const expected: Record<Actor, number> = { admin: 201, owner: 201, editor: 201, viewer: 403, outsider: 403 };

  it.each(ACTORS)("%s", async (actor) => {
    const before = await count();
    const { status, body } = await read(await w.as[actor].post(base, input));
    expect(status).toBe(expected[actor]);
    expect(normalize(body, labels)).toMatchSnapshot();
    expect(await count()).toBe(status === 201 ? before + 1 : before);
    if (status === 201) expect(await dbRow(body.id)).toMatchObject({ trip_id: IDS.trip, payer_id: IDS.editorP, amount: 30 });
  });

  it("payerId is optional and stored as null", async () => {
    const { payerId: _omit, ...noPayer } = input;
    const { status, body } = await read(await w.as.owner.post(base, noPayer));
    expect(status).toBe(201);
    expect(body.payerId).toBeNull();
  });

  it("payerId of a participant on ANOTHER trip is accepted (no same-trip check)", async () => {
    const { status, body } = await read(await w.as.owner.post(base, { ...input, payerId: IDS.outsiderP }));
    expect(status).toBe(201);
    expect(body.payerId).toBe(IDS.outsiderP);
  });

  it("invalid body is a 400 zod error and nothing is written", async () => {
    const before = await count();
    const res = await read(await w.as.owner.post(base, { ...input, amount: -1, currency: "EURO" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
    expect(await count()).toBe(before);
  });

  it("admin gets 404 for a missing trip", async () => {
    const res = await read(await w.as.admin.post(`/api/trips/${IDS.missing}/expenses`, { ...input, payerId: undefined }));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("non-admin gets 403 (not 404) for a missing trip", async () => {
    const res = await read(await w.as.owner.post(`/api/trips/${IDS.missing}/expenses`, input));
    expect(res).toEqual({ status: 403, body: { error: "Forbidden" } });
  });

  it("global viewer who is an Editor participant may create (trip role wins over global role)", async () => {
    const gv = await seedUser("globalviewer@example.test", "viewer");
    await addParticipant(IDS.trip, gv.id, "Editor");
    const { payerId: _omit, ...noPayer } = input;
    expect((await asUser(gv.email).post(base, noPayer)).status).toBe(201);
  });
});

describe("PUT /trips/:tripId/expenses/:expenseId", () => {
  const patch = { amount: 99.99, payerId: null, category: "Other" };
  const expected: Record<Actor, number> = { admin: 200, owner: 200, editor: 200, viewer: 403, outsider: 403 };

  it.each(ACTORS)("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].put(`${base}/${EX.dinner}`, patch));
    expect(status).toBe(expected[actor]);
    expect(normalize(body, labels)).toMatchSnapshot();
    const row = await dbRow(EX.dinner);
    if (status === 200) expect(row).toMatchObject({ amount: 99.99, payer_id: null, category: "Other", description: "Dinner" });
    else expect(row).toMatchObject({ amount: 88.4, payer_id: IDS.ownerP, category: "Food" });
  });

  it("missing expense is 404", async () => {
    const res = await read(await w.as.owner.put(`${base}/${IDS.missing}`, patch));
    expect(res).toEqual({ status: 404, body: { error: "Expense not found" } });
  });

  it("expense from another trip is 404 through this trip's path (admin)", async () => {
    const res = await read(await w.as.admin.put(`${base}/${EX.other}`, patch));
    expect(res).toEqual({ status: 404, body: { error: "Expense not found" } });
  });

  it("invalid patch is 400", async () => {
    const res = await read(await w.as.owner.put(`${base}/${EX.dinner}`, { amount: 0 }));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /trips/:tripId/expenses/:expenseId", () => {
  const expected: Record<Actor, number> = { admin: 204, owner: 204, editor: 204, viewer: 403, outsider: 403 };

  it.each(ACTORS)("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].delete(`${base}/${EX.dinner}`));
    expect(status).toBe(expected[actor]);
    expect(body).toMatchSnapshot();
    expect(await dbRow(EX.dinner)).toEqual(status === 204 ? null : expect.objectContaining({ id: EX.dinner }));
  });

  it("missing expense is 404", async () => {
    const res = await read(await w.as.owner.delete(`${base}/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Expense not found" } });
  });
});
