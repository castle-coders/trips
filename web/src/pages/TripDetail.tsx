import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  trips as tripsApi,
  participants as participantsApi,
  itineraries as itinerariesApi,
  invitesApi,
  usersApi,
  type Invite,
  type UserSummary,
} from "../lib/api";
import type { Trip, Participant, Itinerary } from "../lib/types";
import { formatDateRange } from "../lib/format";
import { useAuth } from "../lib/auth";
import { ItineraryTimeline } from "../components/ItineraryTimeline";
import { EditTripModal } from "../components/EditTripModal";
import { ItineraryForm } from "../components/ItineraryForm";

export function TripDetail() {
  const { tripId } = useParams<{ tripId: string }>();
  const { user } = useAuth();

  const [trip, setTrip] = useState<Trip | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [items, setItems] = useState<Itinerary[]>([]);
  const [pendingInvites, setPendingInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTrip, setEditingTrip] = useState(false);
  const [editingItem, setEditingItem] = useState<Itinerary | null>(null);
  const [addingItem, setAddingItem] = useState(false);

  // Invite form state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("Viewer");
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [inviteSending, setInviteSending] = useState(false);
  const [allUsers, setAllUsers] = useState<UserSummary[]>([]);
  const [inviteMode, setInviteMode] = useState<"user" | "email">("user");

  const load = useCallback(async () => {
    if (!tripId) return;
    const [t, p, i, inv] = await Promise.all([
      tripsApi.get(tripId),
      participantsApi.list(tripId),
      itinerariesApi.list(tripId),
      invitesApi.list(tripId).catch(() => [] as Invite[]),
    ]);
    setTrip(t);
    setParticipants(p);
    setItems(i);
    setPendingInvites(inv.filter((x) => x.status === "pending"));
    setLoading(false);
  }, [tripId]);

  useEffect(() => {
    load();
  }, [load]);

  // Determine role from participant record, falling back to global role
  const myParticipant = participants.find((p) => p.userId === user?.id);
  const tripRole = myParticipant?.role;
  const canEdit =
    user?.role === "admin" ||
    tripRole === "Owner" ||
    tripRole === "Editor";
  const canManageParticipants =
    user?.role === "admin" ||
    tripRole === "Owner";

  if (loading) {
    return <p className="py-20 text-center text-gray-400">Loading...</p>;
  }
  if (!trip) {
    return <p className="py-20 text-center text-gray-400">Trip not found.</p>;
  }

  const handleSaveTrip = async (data: Partial<Trip>) => {
    const updated = await tripsApi.update(trip.id, data);
    setTrip(updated);
  };

  const handleSaveItem = async (data: Parameters<typeof itinerariesApi.create>[1]) => {
    if (editingItem) {
      const updated = await itinerariesApi.update(trip.id, editingItem.id, data);
      setItems(items.map((i) => (i.id === updated.id ? updated : i)));
    } else {
      const created = await itinerariesApi.create(trip.id, data);
      setItems([...items, created]);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors"
        >
          &larr; Back to Trips
        </Link>
        <img src="/favicon.png" alt="Clawdbot Logo" className="h-10 w-10 opacity-80" />
      </div>

      {/* Hero Header */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 sm:mb-8 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{trip.name}</h1>
            {trip.destination && (
              <p className="mt-1 text-lg text-gray-600">{trip.destination}</p>
            )}
            <p className="mt-2 text-sm text-gray-400">
              {formatDateRange(trip.startDate, trip.endDate)}
            </p>
            {trip.description && (
              <p className="mt-3 text-sm text-gray-600">{trip.description}</p>
            )}
          </div>
          {canEdit && (
            <button
              onClick={() => setEditingTrip(true)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:w-auto"
            >
              Edit Trip
            </button>
          )}
        </div>
      </div>

      {/* Participants */}
      <div className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Participants
          </h2>
          {canManageParticipants && (
            <button
              onClick={() => {
                const opening = !showInvite;
                setShowInvite(opening);
                if (opening && allUsers.length === 0) {
                  usersApi.list().then(setAllUsers).catch(() => {});
                }
              }}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              + Add
            </button>
          )}
        </div>

        {canManageParticipants && showInvite && (() => {
          const participantEmails = new Set(participants.map((p) => p.email));
          const participantUserIds = new Set(participants.map((p) => p.userId));
          const invitedEmails = new Set(pendingInvites.map((i) => i.email));
          const availableUsers = allUsers.filter(
            (u) =>
              !participantEmails.has(u.email) &&
              !participantUserIds.has(u.id) &&
              !invitedEmails.has(u.email)
          );

          return (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!tripId || !inviteEmail) return;
              setInviteError("");
              setInviteSuccess("");
              setInviteSending(true);
              try {
                const selectedName = inviteMode === "user"
                  ? allUsers.find((u) => u.email === inviteEmail)?.name
                  : inviteName || undefined;
                const inv = await invitesApi.create(tripId, {
                  email: inviteEmail,
                  name: selectedName,
                  role: inviteRole,
                });
                const link = `${window.location.origin}/invite/${inv.token}`;
                setInviteSuccess(link);
                setPendingInvites([...pendingInvites, inv]);
                setInviteEmail("");
                setInviteName("");
              } catch (err: any) {
                setInviteError(err.message);
              } finally {
                setInviteSending(false);
              }
            }}
            className="mb-4 rounded-lg border border-gray-200 bg-white p-4"
          >
            {/* Mode toggle */}
            <div className="mb-3 flex gap-1 rounded-lg bg-gray-100 p-0.5 text-sm">
              <button
                type="button"
                onClick={() => { setInviteMode("user"); setInviteEmail(""); setInviteName(""); setInviteSuccess(""); setInviteError(""); }}
                className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                  inviteMode === "user"
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                Existing user
              </button>
              <button
                type="button"
                onClick={() => { setInviteMode("email"); setInviteEmail(""); setInviteName(""); setInviteSuccess(""); setInviteError(""); }}
                className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                  inviteMode === "email"
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                New email
              </button>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              {inviteMode === "user" ? (
                <select
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                >
                  <option value="">Select a user...</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.email}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                    type="text"
                    placeholder="Name"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                  />
                  <input
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                    type="email"
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    required
                  />
                </>
              )}
              <select
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
              >
                <option value="Viewer">Viewer</option>
                <option value="Editor">Editor</option>
                <option value="Owner">Owner</option>
              </select>
              <button
                type="submit"
                disabled={inviteSending}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {inviteSending ? "..." : "Send"}
              </button>
            </div>
            {inviteError && (
              <p className="mt-2 text-sm text-red-600">{inviteError}</p>
            )}
            {inviteSuccess && (
              <div className="mt-3">
                <p className="mb-1 text-sm text-green-600">
                  Invite created! Share this link:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-600"
                    value={inviteSuccess}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(inviteSuccess);
                    }}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </form>
          );
        })()}

        {/* Confirmed participants */}
        {participants.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {participants.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5"
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-light text-xs font-bold text-accent">
                  {p.name[0]}
                </div>
                <span className="text-sm text-gray-700">{p.name}</span>
                <span className="text-xs text-gray-400">{p.role}</span>
              </div>
            ))}
          </div>
        )}

        {/* Pending invites */}
        {pendingInvites.length > 0 && (
          <div className={`space-y-2${participants.length > 0 ? " mt-3" : ""}`}>
            {pendingInvites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-400">
                    {inv.name ? inv.name[0] : "?"}
                  </div>
                  <span className="text-sm text-gray-500">{inv.name || inv.email}</span>
                  {inv.name && <span className="text-xs text-gray-400">{inv.email}</span>}
                  <span className="text-xs text-gray-400">{inv.role}</span>
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                    Pending
                  </span>
                </div>
                {canManageParticipants && (
                  <button
                    onClick={async () => {
                      if (!tripId) return;
                      await invitesApi.revoke(tripId, inv.id);
                      setPendingInvites(
                        pendingInvites.filter((x) => x.id !== inv.id)
                      );
                    }}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Itinerary Timeline */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Itinerary
        </h2>
        {canEdit && (
          <button
            onClick={() => setAddingItem(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            + Add Item
          </button>
        )}
      </div>
      <ItineraryTimeline
        items={items}
        onEdit={canEdit ? (item) => setEditingItem(item) : undefined}
        onDelete={canEdit ? async (item) => {
          await itinerariesApi.delete(trip.id, item.id);
          setItems(items.filter((i) => i.id !== item.id));
        } : undefined}
      />

      {/* Modals */}
      {editingTrip && (
        <EditTripModal
          trip={trip}
          onSave={handleSaveTrip}
          onClose={() => setEditingTrip(false)}
        />
      )}
      {(addingItem || editingItem) && (
        <ItineraryForm
          initial={editingItem || undefined}
          participants={participants}
          onSave={handleSaveItem}
          onClose={() => {
            setAddingItem(false);
            setEditingItem(null);
          }}
        />
      )}
    </div>
  );
}
