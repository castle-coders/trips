export interface Trip {
  id: string;
  name: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  splitwiseGroupId: string | null;
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
  traveling: boolean;
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

// OAuth (MCP Stage 2): connected apps and stored clients

export type OAuthScope = "trips:read" | "trips:write" | "offline_access";

export interface OAuthGrant {
  id: string;
  clientId: string;
  /** Null for unknown, deleted, or metadata-document (URL) clients. */
  clientName: string | null;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
}

export interface AdminOAuthGrant extends OAuthGrant {
  userId: string;
  userEmail: string;
}

export type OAuthTokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post";

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  confidential: boolean;
  registrationDate: string | null;
}

/** Returned once by client creation. The secret is never retrievable again. */
export interface CreatedOAuthClient extends OAuthClient {
  clientSecret: string;
}

export interface CreateOAuthClientInput {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
}
