import { z } from "@hono/zod-openapi";

// --- Traveler references (shared across types) ---
const TravelerRef = z.object({
  participantId: z.string().uuid(),
  name: z.string(),
  ticketNumber: z.string().optional(),
});

const SeatAssignment = z.object({
  participantId: z.string().uuid(),
  seatNumber: z.string(),
});

// --- Type-specific content schemas ---

const FlightLeg = z.object({
  airline: z.string(),
  flightNumber: z.string(),
  departureAirport: z.string(),
  departureTime: z.string(),
  departureTimeTz: z.string().optional(),
  arrivalAirport: z.string(),
  arrivalTime: z.string(),
  arrivalTimeTz: z.string().optional(),
  fareClass: z.string().optional(),
  baggageAllowance: z.string().optional(),
  seatAssignments: z.array(SeatAssignment).optional(),
});

const FlightContent = z
  .object({
    travelers: z.array(TravelerRef).optional(),
    legs: z.array(FlightLeg).min(1),
  })
  .openapi("FlightContent");

const LodgingContent = z
  .object({
    propertyName: z.string(),
    address: z.string().optional(),
    checkInDate: z.string().optional(),
    checkInTime: z.string(),
    checkInTimeTz: z.string().optional(),
    checkOutDate: z.string().optional(),
    checkOutTime: z.string(),
    checkOutTimeTz: z.string().optional(),
    arrivalDateTime: z.string().optional(),
    arrivalDateTimeTz: z.string().optional(),
    departureDateTime: z.string().optional(),
    departureDateTimeTz: z.string().optional(),
    roomType: z.string().optional(),
    boardBasis: z.string().optional(),
    numberOfGuests: z.number().int().positive().optional(),
    travelers: z.array(TravelerRef.omit({ ticketNumber: true })).optional(),
  })
  .openapi("LodgingContent");

const RailContent = z
  .object({
    trainOperator: z.string(),
    trainNumber: z.string(),
    departureStation: z.string(),
    departureTime: z.string(),
    departureTimeTz: z.string().optional(),
    arrivalStation: z.string(),
    arrivalTime: z.string(),
    arrivalTimeTz: z.string().optional(),
    travelers: z.array(TravelerRef).optional(),
    seatAssignments: z
      .array(SeatAssignment.extend({ carriageNumber: z.string().optional() }))
      .optional(),
  })
  .openapi("RailContent");

const CarContent = z
  .object({
    rentalCompany: z.string(),
    pickUpLocation: z.string(),
    pickUpTime: z.string(),
    pickUpTimeTz: z.string().optional(),
    dropOffLocation: z.string(),
    dropOffTime: z.string(),
    dropOffTimeTz: z.string().optional(),
    vehicleType: z.string().optional(),
    transmissionType: z.enum(["Automatic", "Manual"]).optional(),
    mileagePolicy: z.string().optional(),
    travelers: z
      .array(
        z.object({
          participantId: z.string().uuid(),
          name: z.string(),
          driverRole: z
            .enum(["Primary Driver", "Additional Driver", "Passenger"])
            .optional(),
        })
      )
      .optional(),
  })
  .openapi("CarContent");

const RestaurantContent = z
  .object({
    restaurantName: z.string(),
    address: z.string().optional(),
    reservationTime: z.string(),
    reservationTimeTz: z.string().optional(),
    partySize: z.number().int().positive(),
    travelers: z.array(TravelerRef.omit({ ticketNumber: true })).optional(),
  })
  .openapi("RestaurantContent");

const TransportContent = z
  .object({
    transportType: z.string(), // Bus, Ferry, etc.
    operator: z.string(),
    departureLocation: z.string(),
    departureTime: z.string(),
    departureTimeTz: z.string().optional(),
    arrivalLocation: z.string(),
    arrivalTime: z.string(),
    arrivalTimeTz: z.string().optional(),
    travelers: z.array(TravelerRef).optional(),
    seatAssignments: z.array(SeatAssignment).optional(),
  })
  .openapi("TransportContent");

const ActivityContent = z
  .object({
    name: z.string(),
    location: z.string().optional(),
    startTime: z.string(),
    startTimeTz: z.string().optional(),
    endTime: z.string().optional(),
    endTimeTz: z.string().optional(),
    travelers: z.array(TravelerRef.omit({ ticketNumber: true })).optional(),
  })
  .openapi("ActivityContent");

// --- Viewer-safe schemas (no sensitive fields) ---

const TravelerRefView = TravelerRef.omit({ ticketNumber: true });

const FlightLegView = FlightLeg.omit({ seatAssignments: true }).extend({
  seatAssignments: z.array(SeatAssignment).optional(),
});

const FlightContentView = z
  .object({
    travelers: z.array(TravelerRefView).optional(),
    legs: z.array(FlightLegView).min(1),
  })
  .openapi("FlightContentView");

const LodgingContentView = LodgingContent; // already has no ticketNumber

const RailContentView = z
  .object({
    trainOperator: z.string(),
    trainNumber: z.string(),
    departureStation: z.string(),
    departureTime: z.string(),
    departureTimeTz: z.string().optional(),
    arrivalStation: z.string(),
    arrivalTime: z.string(),
    arrivalTimeTz: z.string().optional(),
    travelers: z.array(TravelerRefView).optional(),
    seatAssignments: z
      .array(SeatAssignment.extend({ carriageNumber: z.string().optional() }))
      .optional(),
  })
  .openapi("RailContentView");

const CarContentView = CarContent; // no ticketNumber in Car travelers

const RestaurantContentView = RestaurantContent; // already has no ticketNumber

const TransportContentView = z
  .object({
    transportType: z.string(),
    operator: z.string(),
    departureLocation: z.string(),
    departureTime: z.string(),
    departureTimeTz: z.string().optional(),
    arrivalLocation: z.string(),
    arrivalTime: z.string(),
    arrivalTimeTz: z.string().optional(),
    travelers: z.array(TravelerRefView).optional(),
    seatAssignments: z.array(SeatAssignment).optional(),
  })
  .openapi("TransportContentView");

const ActivityContentView = ActivityContent; // already has no ticketNumber

// --- Map type discriminator to content schema ---
export const ITINERARY_TYPES = [
  "Flight",
  "Lodging",
  "Rail",
  "Car",
  "Restaurant",
  "Transport",
  "Activity",
] as const;

export type ItineraryType = (typeof ITINERARY_TYPES)[number];

export const contentSchemaByType: Record<ItineraryType, z.ZodType> = {
  Flight: FlightContent,
  Lodging: LodgingContent,
  Rail: RailContent,
  Car: CarContent,
  Restaurant: RestaurantContent,
  Transport: TransportContent,
  Activity: ActivityContent,
};

export const viewContentSchemaByType: Record<ItineraryType, z.ZodType> = {
  Flight: FlightContentView,
  Lodging: LodgingContentView,
  Rail: RailContentView,
  Car: CarContentView,
  Restaurant: RestaurantContentView,
  Transport: TransportContentView,
  Activity: ActivityContentView,
};

const STATUSES = ["Confirmed", "Pending", "Cancelled"] as const;

// --- Full itinerary schemas ---
export const ItinerarySchema = z
  .object({
    id: z.string().uuid(),
    tripId: z.string().uuid(),
    type: z.enum(ITINERARY_TYPES),
    status: z.enum(STATUSES),
    schemaVersion: z.number().int(),
    content: z.record(z.string(), z.unknown()),
    confirmationNumber: z.string().nullable(),
    totalCost: z.number().nullable(),
    currency: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Itinerary");

export const ItineraryViewSchema = z
  .object({
    id: z.string().uuid(),
    tripId: z.string().uuid(),
    type: z.enum(ITINERARY_TYPES),
    status: z.enum(STATUSES),
    schemaVersion: z.number().int(),
    content: z.record(z.string(), z.unknown()),
    totalCost: z.number().nullable(),
    currency: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ItineraryView");

export const CreateItinerarySchema = z
  .object({
    type: z.enum(ITINERARY_TYPES),
    status: z.enum(STATUSES).default("Pending"),
    content: z.record(z.string(), z.unknown()),
    confirmationNumber: z.string().optional(),
    totalCost: z.number().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().optional(),
  })
  .openapi("CreateItinerary");

export const UpdateItinerarySchema = z
  .object({
    type: z.enum(ITINERARY_TYPES).optional(),
    status: z.enum(STATUSES).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    confirmationNumber: z.string().nullable().optional(),
    totalCost: z.number().nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .openapi("UpdateItinerary");
