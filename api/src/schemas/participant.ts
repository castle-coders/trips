import { z } from "@hono/zod-openapi";

export const ParticipantSchema = z
  .object({
    id: z.string().uuid(),
    tripId: z.string().uuid(),
    userId: z.string().nullable(),
    email: z.string().nullable(),
    name: z.string().min(1),
    role: z.enum(["Owner", "Editor", "Viewer"]),
    traveling: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Participant");

export const CreateParticipantSchema = z
  .object({
    userId: z.string().optional(),
    email: z.string().email().optional(),
    name: z.string().min(1),
    role: z.enum(["Owner", "Editor", "Viewer"]),
    traveling: z.boolean().optional(),
  })
  .openapi("CreateParticipant");

export const UpdateParticipantSchema = z
  .object({
    userId: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    name: z.string().min(1).optional(),
    role: z.enum(["Owner", "Editor", "Viewer"]).optional(),
    traveling: z.boolean().optional(),
  })
  .openapi("UpdateParticipant");
