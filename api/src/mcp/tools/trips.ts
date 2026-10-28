import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CreateTripSchema } from "../../schemas/trip";
import { createTrip, getTrip, listTrips } from "../../services/trips";
import { groupItinerariesByLocalDate, listItineraries } from "../../services/itineraries";
import type { McpRequestContext } from "../context";
import { ok, withTool } from "./withTool";

const roleOut = z.enum(["Owner", "Editor", "Viewer"]).describe("The caller's role on the trip");

const tripOut = z.object({
  id: z.string(),
  name: z.string(),
  destination: z.string().nullable(),
  startDate: z.string().nullable().describe("YYYY-MM-DD or null"),
  endDate: z.string().nullable().describe("YYYY-MM-DD or null"),
  description: z.string().nullable(),
  splitwiseGroupId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const participantOut = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  role: roleOut,
  traveling: z.boolean(),
});

const entryOut = z.object({
  itineraryId: z.string().describe("Id of an item in the itineraries array"),
  kind: z.string().describe("Timeline kind, e.g. Flight, Lodging-arrival, Lodging-departure, Activity"),
  legIndex: z.number().optional().describe("Flight leg index, for Flight entries that come from a leg"),
  time: z.string().nullable().describe("Stored local wall-clock time the entry is placed by, or null"),
  timeZone: z.string().nullable().describe("IANA timezone of that time, or null"),
});

export function registerTripTools(server: McpServer, rc: McpRequestContext): void {
  server.registerTool(
    "get_me",
    {
      title: "Get current user",
      description:
        "Returns the authenticated user (id, email, name, global role). Takes no arguments. Requires the trips:read scope.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        id: z.string(),
        email: z.string(),
        name: z.string(),
        role: z.string().describe("Global role of the user"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withTool(rc, "get_me", "trips:read", async () => {
      const { id, email, name, role } = rc.user;
      return ok({ id, email, name, role });
    }),
  );

  server.registerTool(
    "list_trips",
    {
      title: "List trips",
      description:
        "Lists every trip the caller can see, each with the caller's role on it (Owner, Editor or Viewer). Takes no arguments. Requires the trips:read scope; trip access is determined by membership.",
      inputSchema: z.object({}),
      outputSchema: z.object({ trips: z.array(tripOut.extend({ role: roleOut })) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withTool(rc, "list_trips", "trips:read", async () => {
      const rows = await listTrips(rc.db, rc.user);
      return ok({ trips: rows });
    }),
  );

  server.registerTool(
    "get_trip",
    {
      title: "Get trip",
      description:
        "Returns one trip with the caller's role, its participants, and its itineraries (flights, lodging, activities, ...) grouped by local calendar date. Each itinerary appears once in `itineraries`; `days` lists timeline entries referencing them by itineraryId, with a final date=null group for unscheduled items. Needs a tripId (from list_trips). Requires the trips:read scope and at least Viewer access to the trip; Viewers do not see confirmation or ticket numbers.",
      inputSchema: z.object({
        tripId: z.string().uuid().describe("Id of the trip, as returned by list_trips"),
      }),
      outputSchema: z.object({
        trip: tripOut,
        role: roleOut,
        participants: z.array(participantOut),
        itineraries: z
          .array(z.record(z.string(), z.unknown()))
          .describe("All itineraries of the trip, each once; fields vary by type and by the caller's role"),
        days: z
          .array(
            z.object({
              date: z.string().nullable().describe("Local date YYYY-MM-DD, or null for unscheduled entries"),
              entries: z.array(entryOut),
            }),
          )
          .describe("Timeline ordered by date then time"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withTool(rc, "get_trip", "trips:read", async ({ tripId }: { tripId: string }) => {
      const { trip, role, participants } = await getTrip(rc.db, rc.user, tripId);
      const items = await listItineraries(rc.db, rc.user, tripId);
      const days = groupItinerariesByLocalDate(items).map((g) => ({
        date: g.date,
        entries: g.entries.map((e) => ({
          itineraryId: (e.itinerary as { id: string }).id,
          kind: e.kind,
          ...(e.legIndex !== undefined ? { legIndex: e.legIndex } : {}),
          time: e.time,
          timeZone: e.timeZone,
        })),
      }));
      return ok({ trip, role, participants, itineraries: items as Record<string, unknown>[], days });
    }),
  );

  const c = CreateTripSchema.shape;
  server.registerTool(
    "create_trip",
    {
      title: "Create trip",
      description:
        "Creates a new trip and makes the caller its Owner. Needs a name; all other fields are optional. Requires the trips:write scope and a global role that can edit (global Viewers are refused).",
      inputSchema: z.object({
        name: c.name.describe("Trip name, e.g. 'Japan 2027'"),
        destination: c.destination.describe("Main destination, e.g. 'Tokyo, Japan'"),
        startDate: c.startDate.describe("Start date, YYYY-MM-DD"),
        endDate: c.endDate.describe("End date, YYYY-MM-DD"),
        description: c.description.describe("Free-text description or notes"),
        splitwiseGroupId: c.splitwiseGroupId.describe("Splitwise group id to link expenses to"),
      }),
      outputSchema: z.object({ trip: tripOut, role: roleOut }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withTool(rc, "create_trip", "trips:write", async (args: z.infer<typeof CreateTripSchema>) => {
      const trip = await createTrip(rc.db, rc.user, args);
      return ok({ trip, role: "Owner" });
    }),
  );
}
