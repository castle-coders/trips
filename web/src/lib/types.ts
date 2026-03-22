export interface Trip {
  id: string;
  name: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Participant {
  id: string;
  tripId: string;
  userId: string | null;
  email: string | null;
  name: string;
  role: "Owner" | "Editor" | "Viewer";
  createdAt: string;
  updatedAt: string;
}

export type ItineraryType =
  | "Flight"
  | "Lodging"
  | "Rail"
  | "Car"
  | "Restaurant"
  | "Transport"
  | "Activity";

export interface Itinerary {
  id: string;
  tripId: string;
  type: ItineraryType;
  status: "Confirmed" | "Pending" | "Cancelled";
  schemaVersion: number;
  content: Record<string, unknown>;
  confirmationNumber: string | null;
  totalCost: number | null;
  currency: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
