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

// Audit history (specs/AUDIT_TDD.md sections 8 and 9.1). Mirrors api/src/schemas/audit.ts.

export type AuditEntityType =
  | "trip"
  | "itinerary"
  | "expense"
  | "participant"
  | "document"
  | "invite"
  | "user"
  | "user_email"
  | "service_identity"
  | "oauth_grant"
  | "oauth_client";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "accept"
  | "merge"
  | "link"
  | "unlink"
  | "set_primary"
  | "revoke";

/** Live channels the auth paths produce. `backfill` is reserved for imported history. */
export type AuditLiveChannel = "web" | "service_token" | "mcp_stage1" | "mcp_oauth" | "dev";
export type AuditChannel = AuditLiveChannel | "backfill";

/**
 * `{ "<path>": { from?, to? } }`. A missing `from` means the path did not exist before
 * (added); a missing `to` means it was removed; `to: null` means it was cleared.
 */
export type AuditChanges = Record<string, { from?: unknown; to?: unknown }>;

export type AuditSnapshot = Record<string, unknown>;

export interface AuditEvent {
  id: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  actorUserId: string | null;
  actorName: string;
  actorEmail: string;
  actorRole: string;
  channel: AuditChannel;
  /** OAuth client id (mcp_oauth) or service identity common name (service_token, mcp_stage1). */
  clientId: string | null;
  /** Registered OAuth client name or service identity common name; null for web, dev and unknown clients. */
  clientName: string | null;
  /** Cloudflare cf-ray. Present only on /admin/audit. */
  requestId?: string | null;
  /** Null for administration events. */
  tripId: string | null;
  entityType: AuditEntityType;
  entityId: string;
  entityLabel: string;
  action: AuditAction;
  /** Allow-listed snapshot before the change; null for create. */
  before: AuditSnapshot | null;
  /** Allow-listed snapshot after the change; null for delete. */
  after: AuditSnapshot | null;
  /** Per-path diff for update; null otherwise. */
  changes: AuditChanges | null;
  metadata: AuditSnapshot | null;
}

export interface AuditPage {
  /** Newest first. */
  events: AuditEvent[];
  /** Opaque; pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/** Query for `GET /trips/{tripId}/audit`. */
export interface AuditQuery {
  cursor?: string | null;
  limit?: number;
  entityType?: AuditEntityType;
  entityId?: string;
  actorUserId?: string;
  action?: AuditAction;
  /** ISO 8601, inclusive on createdAt. */
  since?: string;
  /** ISO 8601, inclusive on createdAt. */
  until?: string;
}

/** Query for `GET /trips/{tripId}/audit/{entityType}/{entityId}`; the path fixes the entity. */
export type AuditEntityQuery = Omit<AuditQuery, "entityType" | "entityId">;

/** Query for `GET /admin/audit`. */
export interface AdminAuditQuery extends AuditQuery {
  tripId?: string;
  channel?: AuditLiveChannel;
  clientId?: string;
}

/** Page loader used by ActivityFeed and HistoryModal. Receives the cursor for the next page, or null for the first. */
export type AuditLoader = (cursor: string | null) => Promise<AuditPage>;
