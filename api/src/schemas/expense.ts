import { z } from "@hono/zod-openapi";

export const ExpenseSchema = z
  .object({
    id: z.string().uuid(),
    tripId: z.string().uuid(),
    description: z.string(),
    amount: z.number(),
    currency: z.string().length(3),
    category: z.enum([
      "Food",
      "Transport",
      "Accommodation",
      "Entertainment",
      "Shopping",
      "Other",
    ]),
    payerId: z.string().uuid().nullable(),
    splitType: z.enum(["EQUAL", "EXACT", "PERCENTAGE"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Expense");

export const CreateExpenseSchema = z
  .object({
    description: z.string().min(1),
    amount: z.number().positive(),
    currency: z.string().length(3),
    category: z.enum([
      "Food",
      "Transport",
      "Accommodation",
      "Entertainment",
      "Shopping",
      "Other",
    ]),
    payerId: z.string().uuid().optional(),
    splitType: z.enum(["EQUAL", "EXACT", "PERCENTAGE"]),
  })
  .openapi("CreateExpense");

export const UpdateExpenseSchema = z
  .object({
    description: z.string().min(1).optional(),
    amount: z.number().positive().optional(),
    currency: z.string().length(3).optional(),
    category: z
      .enum([
        "Food",
        "Transport",
        "Accommodation",
        "Entertainment",
        "Shopping",
        "Other",
      ])
      .optional(),
    payerId: z.string().uuid().nullable().optional(),
    splitType: z.enum(["EQUAL", "EXACT", "PERCENTAGE"]).optional(),
  })
  .openapi("UpdateExpense");
