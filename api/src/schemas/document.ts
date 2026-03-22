import { z } from "@hono/zod-openapi";

export const DocumentSchema = z
  .object({
    id: z.string().uuid(),
    tripId: z.string().uuid(),
    reservationId: z.string().uuid().nullable(),
    fileUrl: z.string().url(),
    documentType: z.enum(["PDF_TICKET", "IMAGE_RECEIPT", "BOARDING_PASS", "OTHER"]),
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Document");

export const CreateDocumentSchema = z
  .object({
    reservationId: z.string().uuid().optional(),
    fileUrl: z.string().url(),
    documentType: z.enum(["PDF_TICKET", "IMAGE_RECEIPT", "BOARDING_PASS", "OTHER"]),
    name: z.string().min(1),
  })
  .openapi("CreateDocument");

export const UpdateDocumentSchema = z
  .object({
    reservationId: z.string().uuid().nullable().optional(),
    fileUrl: z.string().url().optional(),
    documentType: z
      .enum(["PDF_TICKET", "IMAGE_RECEIPT", "BOARDING_PASS", "OTHER"])
      .optional(),
    name: z.string().min(1).optional(),
  })
  .openapi("UpdateDocument");
