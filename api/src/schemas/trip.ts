import { z } from "@hono/zod-openapi";

export const TripSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    destination: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    description: z.string().nullable(),
    splitwiseGroupId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Trip");

export const CreateTripSchema = z
  .object({
    name: z.string().min(1),
    destination: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    description: z.string().optional(),
    splitwiseGroupId: z.string().optional(),
  })
  .openapi("CreateTrip");

export const UpdateTripSchema = z
  .object({
    name: z.string().min(1).optional(),
    destination: z.string().nullable().optional(),
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    splitwiseGroupId: z.string().nullable().optional(),
  })
  .openapi("UpdateTrip");
