import type {
  Trip,
  Participant,
  Itinerary,
  OAuthGrant,
  AdminOAuthGrant,
  OAuthClient,
  CreatedOAuthClient,
  CreateOAuthClientInput,
} from "./types";

const BASE = "/api";

export const DEV_EMAIL_KEY = "dev_user_email";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const devEmail = import.meta.env.DEV ? localStorage.getItem(DEV_EMAIL_KEY) : null;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(devEmail ? { "X-Dev-User-Email": devEmail } : {}),
      ...init?.headers,
    },
  });
  // CF Access redirects to its login page when session expires;
  // with redirect: "manual" this shows as an opaque redirect instead of a CORS error
  if (res.type === "opaqueredirect" || res.status === 0) {
    throw new Error("Unauthorized");
  }
  if (res.status === 204) return undefined as T;
  if (res.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Trips
export const trips = {
  list: () => request<Trip[]>("/trips"),
  get: (id: string) => request<Trip>(`/trips/${id}`),
  create: (data: Partial<Trip>) =>
    request<Trip>("/trips", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Trip>) =>
    request<Trip>(`/trips/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/trips/${id}`, { method: "DELETE" }),
};

// Participants
export const participants = {
  list: (tripId: string) => request<Participant[]>(`/trips/${tripId}/participants`),
  create: (tripId: string, data: Partial<Participant>) =>
    request<Participant>(`/trips/${tripId}/participants`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (tripId: string, participantId: string, data: Partial<Participant>) =>
    request<Participant>(`/trips/${tripId}/participants/${participantId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  remove: (tripId: string, participantId: string) =>
    request<void>(`/trips/${tripId}/participants/${participantId}`, { method: "DELETE" }),
};

// Itineraries
export const itineraries = {
  list: (tripId: string) => request<Itinerary[]>(`/trips/${tripId}/itineraries`),
  get: (tripId: string, id: string) => request<Itinerary>(`/trips/${tripId}/itineraries/${id}`),
  create: (tripId: string, data: Partial<Itinerary>) =>
    request<Itinerary>(`/trips/${tripId}/itineraries`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (tripId: string, id: string, data: Partial<Itinerary>) =>
    request<Itinerary>(`/trips/${tripId}/itineraries/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  delete: (tripId: string, id: string) =>
    request<void>(`/trips/${tripId}/itineraries/${id}`, { method: "DELETE" }),
};

// Account self-service
export interface EmailEntry {
  id: string;
  email: string;
  isPrimary: boolean;
}

export interface MeResponse {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  emails: EmailEntry[];
}

export const LINK_TOKEN_KEY = "account_link_token";
export const LINK_TOKEN_EXPIRES_KEY = "account_link_token_expires";

export interface LinkPreview {
  destinationAccount: { name: string; email: string };
  isSelf: boolean;
}

export const account = {
  getMe: () => request<MeResponse>("/auth/me"),
  updateProfile: (data: { name: string }) =>
    request<MeResponse>("/auth/me", { method: "PUT", body: JSON.stringify(data) }),
  generateLinkToken: () =>
    request<{ token: string; expiresAt: string }>("/auth/me/link-token", { method: "POST" }),
  previewLinkToken: (token: string) =>
    request<LinkPreview>("/auth/me/link-preview", { method: "POST", body: JSON.stringify({ token }) }),
  consumeLinkToken: (token: string) =>
    request<MeResponse>("/auth/me/link", { method: "POST", body: JSON.stringify({ token }) }),
  removeEmail: (emailId: string) =>
    request<EmailEntry[]>(`/auth/me/emails/${emailId}`, { method: "DELETE" }),
  setPrimaryEmail: (emailId: string) =>
    request<EmailEntry[]>(`/auth/me/emails/${emailId}/primary`, { method: "PUT" }),

  // Connected apps (OAuth grants). Empty list when OAuth is not configured.
  listGrants: () => request<OAuthGrant[]>("/auth/me/grants"),
  revokeGrant: (grantId: string) =>
    request<void>(`/auth/me/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" }),
};

// Users (authenticated, for pickers)
export interface UserSummary {
  id: string;
  email: string;
  name: string;
}

export const usersApi = {
  list: () => request<UserSummary[]>("/auth/users"),
};

// Invites
export interface Invite {
  id: string;
  tripId: string;
  participantId: string | null;
  name: string | null;
  role: string;
  token: string;
  status: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

export interface InviteInfo {
  tripName: string;
  inviterName: string;
  role: string;
  expiresAt: string;
}

export const invitesApi = {
  list: (tripId: string) => request<Invite[]>(`/trips/${tripId}/invites`),
  create: (tripId: string, data: { name?: string; participantId?: string }) =>
    request<Invite>(`/trips/${tripId}/invites`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  revoke: (tripId: string, inviteId: string) =>
    request<void>(`/trips/${tripId}/invites/${inviteId}`, { method: "DELETE" }),
  getInfo: (token: string) => request<InviteInfo>(`/auth/invite/${token}`),
  accept: (token: string) =>
    request<{ user: { id: string; email: string; name: string; role: string } }>(
      `/auth/invite/${token}/accept`,
      { method: "POST" }
    ),
};

// Admin
export interface AppUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceIdentity {
  id: string;
  cfAccessSubject: string;
  commonName: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  createdAt: string;
}

export const admin = {
  listUsers: () => request<AppUser[]>("/admin/users"),
  createUser: (data: { email: string; name: string; role?: string }) =>
    request<AppUser>("/admin/users", { method: "POST", body: JSON.stringify(data) }),
  updateUser: (id: string, data: { name?: string; role?: string }) =>
    request<AppUser>(`/admin/users/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteUser: (id: string) => request<void>(`/admin/users/${id}`, { method: "DELETE" }),
  mergeUsers: (keepUserId: string, mergeUserId: string) =>
    request<AppUser & { emails: EmailEntry[] }>("/admin/users/merge", {
      method: "POST",
      body: JSON.stringify({ keepUserId, mergeUserId }),
    }),

  listServiceIdentities: () => request<ServiceIdentity[]>("/admin/service-identities"),
  createServiceIdentity: (data: { cfAccessSubject: string; commonName: string; userId: string }) =>
    request<ServiceIdentity>("/admin/service-identities", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteServiceIdentity: (id: string) =>
    request<void>(`/admin/service-identities/${id}`, { method: "DELETE" }),

  // OAuth grants and clients. Lists are empty when OAuth is not configured;
  // mutations then fail with OAUTH_NOT_CONFIGURED (see oauthErrorMessage).
  listGrants: () => request<AdminOAuthGrant[]>("/admin/grants"),
  revokeGrant: (userId: string, grantId: string) =>
    request<void>(
      `/admin/grants/${encodeURIComponent(userId)}/${encodeURIComponent(grantId)}`,
      { method: "DELETE" }
    ),
  listOAuthClients: () => request<OAuthClient[]>("/admin/oauth-clients"),
  createOAuthClient: (data: CreateOAuthClientInput) =>
    request<CreatedOAuthClient>("/admin/oauth-clients", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteOAuthClient: (clientId: string) =>
    request<void>(`/admin/oauth-clients/${encodeURIComponent(clientId)}`, { method: "DELETE" }),
};

// OAuth display helpers
/** Error string the API returns (503) when OAuth (Stage 2) is not configured. */
export const OAUTH_NOT_CONFIGURED = "OAuth is not configured";

/** Maps an OAuth API error to a user-facing message. */
export function oauthErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message === OAUTH_NOT_CONFIGURED) return "OAuth is not configured on this server.";
  return message || "Something went wrong";
}

const OAUTH_SCOPE_LABELS: Record<string, string> = {
  "trips:read": "View",
  "trips:write": "Create & edit",
  offline_access: "Stay connected",
};

/** Plain-language label for an OAuth scope; unknown scopes are shown as-is. */
export function oauthScopeLabel(scope: string): string {
  return OAUTH_SCOPE_LABELS[scope] ?? scope;
}

/** Display name for an OAuth client, falling back to its client id. */
export function oauthAppName(item: { clientName: string | null; clientId: string }): string {
  return item.clientName?.trim() || item.clientId;
}

/** Short date for an ISO timestamp, e.g. "Oct 27, 2026". */
export function formatOAuthDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
