import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "@hono/zod-openapi";
import type { McpRequestContext } from "../context";
import { withTool, ok } from "./withTool";
import { ServiceError } from "../../services/errors";
import {
  ITINERARY_TYPES,
  contentSchemaByType,
  CreateItinerarySchema,
  UpdateItinerarySchema,
} from "../../schemas/itinerary";
import { createItinerary, searchItinerariesWithMeta, updateItinerary } from "../../services/itineraries";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// --- content description, derived from contentSchemaByType so it cannot drift ---

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
};

/** Compact one-line rendering of a JSON schema: {key: string, opt?: number, list: [{...}]}. */
function render(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join("|");
  if (s.anyOf) return s.anyOf.map(render).join("|");
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if (t === "array") return `[${s.items ? render(s.items) : "any"}]`;
  if (t === "object" && s.properties) {
    const req = new Set(s.required ?? []);
    return `{${Object.entries(s.properties)
      .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${render(v)}`)
      .join(", ")}}`;
  }
  if (t === "integer") return "integer";
  return t ?? "any";
}

function contentFieldsDescription(): string {
  return ITINERARY_TYPES.map((type) => {
    const js = z.toJSONSchema(contentSchemaByType[type], { io: "input", unrepresentable: "any" }) as JsonSchema;
    return `${type}: ${render(js)}`;
  }).join("; ");
}

const CONTENT_DESCRIPTION =
  "Type-specific details as a JSON object, validated against `type`. A trailing ? marks an optional field. " +
  "Times are wall-clock ISO strings without offset (e.g. 2026-05-01T14:30) with an optional IANA zone in the matching *Tz field. " +
  "participantId values come from get_trip. Fields per type (generated from the server schemas): " +
  contentFieldsDescription();

// --- field schemas, derived from the REST schemas so MCP and REST validation cannot drift ---

const C = CreateItinerarySchema.shape;
const U = UpdateItinerarySchema.shape;

const tripIdField = z.string().uuid().describe("Trip id (UUID). Get it from list_trips.");
const statusField = z.enum(["Confirmed", "Pending", "Cancelled"]);

const createInput = z.object({ tripId: tripIdField }).extend({
  type: C.type.describe("Itinerary type; determines the shape of `content`."),
  status: C.status.describe("Booking status; defaults to Pending."),
  content: C.content.describe(CONTENT_DESCRIPTION),
  confirmationNumber: C.confirmationNumber.describe("Booking confirmation number."),
  totalCost: C.totalCost.describe("Total cost in `currency`."),
  currency: C.currency.describe("ISO 4217 currency code, e.g. USD."),
  notes: C.notes.describe("Free-form notes."),
});

const updateInput = z.object({ tripId: tripIdField }).extend({
  itineraryId: z.string().uuid().describe("Itinerary item id (UUID)."),
  type: U.type.describe("New type. If changed, also pass matching `content`."),
  status: U.status.describe("New booking status."),
  content: U.content.describe("Complete replacement content. " + CONTENT_DESCRIPTION),
  confirmationNumber: U.confirmationNumber.describe("New confirmation number, or null to clear."),
  totalCost: U.totalCost.describe("New total cost, or null to clear."),
  currency: U.currency.describe("New ISO 4217 currency code, or null to clear."),
  notes: U.notes.describe("New notes, or null to clear."),
});

/** Safe, short summary of zod-flattened field errors, so the model can self-correct. */
function validationHint(details: unknown): string {
  const d = details as { formErrors?: unknown; fieldErrors?: Record<string, unknown> } | undefined;
  if (!d || typeof d !== "object") return "";
  const parts: string[] = [];
  for (const m of Array.isArray(d.formErrors) ? d.formErrors : []) if (typeof m === "string") parts.push(m);
  for (const [k, v] of Object.entries(d.fieldErrors ?? {})) {
    if (Array.isArray(v) && v.length) parts.push(`${k}: ${v.filter((x) => typeof x === "string").join("; ")}`);
  }
  const text = parts.join(" | ").slice(0, 600);
  return text ? ` (${text})` : "";
}

async function withHint<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "validation" && e.details !== undefined) {
      throw new ServiceError("validation", `${e.message}${validationHint(e.details)}`);
    }
    throw e;
  }
}

// --- output schemas (accurate for full and Viewer-projected rows) ---

const itineraryOut = z.object({
  id: z.string(),
  tripId: z.string(),
  type: z.enum(ITINERARY_TYPES),
  status: statusField,
  schemaVersion: z.number(),
  content: z.record(z.string(), z.unknown()).describe("Type-specific details; shape depends on `type`."),
  confirmationNumber: z
    .string()
    .nullable()
    .optional()
    .describe("Absent for Viewers (hidden by trip role)."),
  totalCost: z.number().nullable(),
  currency: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function registerItineraryTools(server: McpServer, rc: McpRequestContext): void {
  server.registerTool(
    "search_itineraries",
    {
      title: "Search itineraries",
      description:
        "Search itineraries (flights, lodging, rail, car, restaurant, transport, activity) across the trips you belong to, or within one trip. " +
        "All filters are optional and combined with AND. Results are ordered by earliest scheduled time, unscheduled last, and capped by `limit`. " +
        "Very broad searches are also capped server-side (1000 rows); narrow with tripId, types or dates. " +
        "Viewers of a trip do not see confirmation or ticket numbers. Requires scope trips:read; works for any trip role (Viewer or higher).",
      inputSchema: z.object({
        tripId: tripIdField.optional().describe("Restrict to one trip (UUID). Omit to search all your trips."),
        types: z.array(z.enum(ITINERARY_TYPES)).optional().describe("Only these types. Omit for all types."),
        from: z
          .string()
          .optional()
          .describe("Inclusive start date, YYYY-MM-DD. Matches items whose dates overlap [from, to]; undated items are excluded when set."),
        to: z.string().optional().describe("Inclusive end date, YYYY-MM-DD."),
        text: z
          .string()
          .max(40)
          .optional()
          .describe("Case-insensitive substring to match in itinerary details and notes. Max 40 characters; use a short distinctive word or phrase (e.g. a hotel name or flight number)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Max items to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
      }),
      outputSchema: z.object({
        itineraries: z.array(itineraryOut),
        returned: z.number(),
        total: z
          .number()
          .describe(
            "Number of matches found before `limit` was applied; when the server's 1000-row search cap is reached this is a lower bound and `truncated` is true.",
          ),
        truncated: z.boolean().describe("True when more matches exist than were returned (limit or server cap); narrow the filters or raise limit."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withTool(rc, "search_itineraries", "trips:read", async (args) => {
      const { limit, ...filter } = args;
      const { items, truncated: capped } = await searchItinerariesWithMeta(rc.db, rc.user, filter);
      const itineraries = items.slice(0, limit ?? DEFAULT_LIMIT);
      return ok({
        itineraries,
        returned: itineraries.length,
        total: items.length,
        truncated: capped || items.length > itineraries.length,
      });
    }),
  );

  server.registerTool(
    "create_itinerary",
    {
      title: "Create itinerary item",
      description:
        "Add an itinerary item (flight, lodging, rail, car, restaurant, transport or activity) to a trip. " +
        "Needs the trip id, a type and a matching content object. Each call creates a new item, so do not retry blindly. " +
        "Requires scope trips:write and Editor or Owner role on the trip.",
      inputSchema: createInput,
      outputSchema: z.object({ itinerary: itineraryOut }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withTool(rc, "create_itinerary", "trips:write", async (args) => {
      const { tripId, ...input } = args;
      const itinerary = await withHint(() => createItinerary(rc.db, rc.user, tripId, input as never));
      return ok({ itinerary });
    }),
  );

  server.registerTool(
    "update_itinerary",
    {
      title: "Update itinerary item",
      description:
        "Partially update an itinerary item: only the fields you pass change; others keep their value. " +
        "If you pass `content` it replaces the whole content object (send the complete object, not a diff) and is validated against the type. " +
        "Pass null for confirmationNumber, totalCost, currency or notes to clear them. " +
        "Needs the trip id and itinerary id (from search_itineraries or get_trip). Repeating the same update gives the same result. " +
        "Requires scope trips:write and Editor or Owner role on the trip.",
      inputSchema: updateInput,
      outputSchema: z.object({ itinerary: itineraryOut }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withTool(rc, "update_itinerary", "trips:write", async (args) => {
      const { tripId, itineraryId, ...patch } = args;
      const itinerary = await withHint(() => updateItinerary(rc.db, rc.user, tripId, itineraryId, patch as never));
      return ok({ itinerary });
    }),
  );
}
