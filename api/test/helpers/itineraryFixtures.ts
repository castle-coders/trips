// Itinerary fixtures shared by test/itineraries*.test.ts. Values are obviously fake.
import { IDS, type RoleWorld } from "./parity";
import { flightContent, seedItinerary } from "./seed";

export const IT = {
  activity: "00000000-0000-4000-8000-00000000e001",
  flight: "00000000-0000-4000-8000-00000000e002",
  oldFlight: "00000000-0000-4000-8000-00000000e003",
  rail: "00000000-0000-4000-8000-00000000e004",
  lodging: "00000000-0000-4000-8000-00000000e005",
  otherTripActivity: "00000000-0000-4000-8000-00000000e006",
} as const;

export const itLabels = (w: RoleWorld) => ({
  ...w.labels,
  ...Object.fromEntries(Object.entries(IT).map(([k, v]) => [v, `it:${k}`])),
});

/** Pre-0009 flight: per-leg fields at the top level, extra legs with cabinClass. */
export const oldFormatFlight = (travelerId: string) => ({
  airline: "Legacy Air",
  flightNumber: "LA1",
  departureAirport: "CCC",
  departureTime: "2090-03-01T08:00",
  departureTimeTz: "Europe/London",
  arrivalAirport: "DDD",
  arrivalTime: "2090-03-01T11:00",
  arrivalTimeTz: "Europe/Paris",
  fareClass: "Economy",
  seatAssignments: [{ participantId: travelerId, seatNumber: "3C" }],
  travelers: [{ participantId: travelerId, name: "Legacy Traveler", ticketNumber: "TKT-FAKE-OLD1" }],
  legs: [
    {
      airline: "Legacy Air",
      flightNumber: "LA2",
      departureAirport: "DDD",
      departureTime: "2090-03-01T13:00",
      arrivalAirport: "EEE",
      arrivalTime: "2090-03-01T15:00",
      cabinClass: "Business",
      seatAssignments: [{ participantId: travelerId, seatNumber: "1A" }],
    },
  ],
});

export const railContent = (travelerId: string) => ({
  trainOperator: "Fake Rail",
  trainNumber: "FR9",
  departureStation: "Alpha",
  departureTime: "2090-03-03T09:00",
  arrivalStation: "Beta",
  arrivalTime: "2090-03-03T12:00",
  travelers: [{ participantId: travelerId, name: "Rail Traveler", ticketNumber: "TKT-FAKE-RAIL" }],
  seatAssignments: [{ participantId: travelerId, seatNumber: "44", carriageNumber: "7" }],
});

/** Seed one itinerary of each interesting shape on w.trip, plus one on w.otherTrip. */
export async function seedItineraries(w: RoleWorld) {
  const p = w.participants.editor.id;
  await seedItinerary(IDS.trip, {
    id: IT.activity,
    type: "Activity",
    status: "Confirmed",
    content: { name: "Museum", location: "Testville", startTime: "2090-03-02T10:00", startTimeTz: "Europe/Paris" },
    confirmationNumber: "CONF-FAKE-ACT",
    totalCost: 25,
    currency: "EUR",
    notes: "Bring ID",
  });
  await seedItinerary(IDS.trip, { id: IT.flight, type: "Flight", content: flightContent(p), confirmationNumber: "CONF-FAKE-FLT" });
  await seedItinerary(IDS.trip, { id: IT.oldFlight, type: "Flight", content: oldFormatFlight(p), confirmationNumber: "CONF-FAKE-OLD" });
  await seedItinerary(IDS.trip, { id: IT.rail, type: "Rail", status: "Pending", content: railContent(p), confirmationNumber: "CONF-FAKE-RAIL" });
  await seedItinerary(IDS.trip, {
    id: IT.lodging,
    type: "Lodging",
    content: { propertyName: "Fake Inn", checkInTime: "15:00", checkOutTime: "11:00", checkInDate: "2090-03-01", checkOutDate: "2090-03-08" },
    confirmationNumber: null,
  });
  await seedItinerary(IDS.otherTrip, { id: IT.otherTripActivity, content: { name: "Elsewhere tour", startTime: "2091-05-02T09:00" } });
}
