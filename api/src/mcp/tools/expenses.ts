import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpRequestContext } from "../context";
import { createExpense, listExpenses } from "../../services/expenses";
import { ExpenseSchema, CreateExpenseSchema } from "../../schemas/expense";
import { withTool, ok } from "./withTool";

const tripIdField = z.string().uuid().describe("Trip id (UUID). Get it from list_trips.");

// Derived from api/src/schemas/expense.ts so REST and MCP validation cannot drift.
// .describe() returns a copy that keeps the original constraints (enum, min, length, uuid).
const E = ExpenseSchema.shape;
const C = CreateExpenseSchema.shape;

const expenseOutput = ExpenseSchema.extend({
  id: E.id.describe("Expense id (UUID)."),
  tripId: E.tripId.describe("Trip id (UUID)."),
  description: E.description.describe("What the expense was for."),
  amount: E.amount.describe("Amount in major units of `currency` (e.g. 12.5 means 12.50)."),
  currency: E.currency.describe("3-letter currency code, e.g. USD."),
  category: E.category.describe("Expense category."),
  payerId: E.payerId.describe("Participant id of the payer, or null when no payer is recorded."),
  splitType: E.splitType.describe("How the expense is split among participants."),
  createdAt: E.createdAt.describe("ISO 8601 creation timestamp."),
  updatedAt: E.updatedAt.describe("ISO 8601 last-update timestamp."),
});

const expenseWithPayerOutput = expenseOutput.extend({
  payerName: z
    .string()
    .nullable()
    .describe("Name of the payer, or null when there is no payer or the payer is not a participant of this trip."),
});

const addExpenseInput = z.object({ tripId: tripIdField }).extend({
  description: C.description.describe("What the expense was for, e.g. 'Dinner at Ramen Ya'. Must not be empty."),
  amount: C.amount.describe("Amount in major units of the currency (e.g. 12.5 for 12.50). Must be greater than 0."),
  currency: C.currency.describe("3-letter ISO 4217 currency code, e.g. USD, EUR, JPY."),
  category: C.category.describe("Expense category."),
  payerId: C.payerId.describe(
    "Participant id (UUID) of who paid. Must be a participant of this trip; get_trip returns participants. Omit if unknown.",
  ),
  splitType: C.splitType.describe(
    "How to split the cost: EQUAL (evenly among participants), EXACT (fixed amounts per participant), PERCENTAGE (percent per participant).",
  ),
});

export function registerExpenseTools(server: McpServer, rc: McpRequestContext): void {
  server.registerTool(
    "list_expenses",
    {
      title: "List trip expenses",
      description:
        "Lists all expenses for a trip, each with amount, currency, category, split type, and the payer (payerId and payerName). " +
        "Needs a tripId (from list_trips). Requires the trips:read scope and at least Viewer access to the trip.",
      inputSchema: z.object({ tripId: tripIdField }),
      outputSchema: z.object({ expenses: z.array(expenseWithPayerOutput) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withTool(rc, "list_expenses", "trips:read", async (args: { tripId: string }) => {
      const expenses = await listExpenses(rc.db, rc.user, args.tripId);
      return ok({ expenses });
    }),
  );

  server.registerTool(
    "add_expense",
    {
      title: "Add an expense",
      description:
        "Adds an expense to a trip and returns the created expense. Not idempotent: calling twice creates two expenses. " +
        "Needs a tripId (from list_trips) and, optionally, a payerId, which must be a participant id of this trip (get_trip returns participants). " +
        "Requires the trips:write scope and at least Editor access to the trip.",
      inputSchema: addExpenseInput,
      outputSchema: z.object({ expense: expenseOutput }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withTool(rc, "add_expense", "trips:write", async (args: z.infer<typeof addExpenseInput>) => {
      const { tripId, ...input } = args;
      const expense = await createExpense(rc.db, rc.user, tripId, input);
      return ok({ expense });
    }),
  );
}
