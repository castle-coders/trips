import { useEffect, useState, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
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
  const navigate = useNavigate();

  const [trip, setTrip] = useState<Trip | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [items, setItems] = useState<Itinerary[]>([]);
  const [pendingInvites, setPendingInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingTrip, setEditingTrip] = useState(false);
  const [editingItem, setEditingItem] = useState<Itinerary | null>(null);
  const [addingItem, setAddingItem] = useState(false);

  const [showParticipants, setShowParticipants] = useState(false);

  // Invite form state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteMode, setInviteMode] = useState<"existing" | "new">("existing");
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [inviteSending, setInviteSending] = useState(false);
  const [allUsers, setAllUsers] = useState<UserSummary[]>([]);
  const [inviteSendingForParticipant, setInviteSendingForParticipant] = useState<Record<string, boolean>>({});
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  const copyInviteLink = (id: string, link: string) => {
    navigator.clipboard.writeText(link);
    setCopiedInviteId(id);
    setTimeout(() => setCopiedInviteId((cur) => cur === id ? null : cur), 2000);
  };

  const load = useCallback(async () => {
    if (!tripId) return;
    try {
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
    } catch (err: any) {
      setError(err.message || "Failed to load trip");
    } finally {
      setLoading(false);
    }
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
  if (error) {
    return <p className="py-20 text-center text-red-500">{error}</p>;
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
            <div className="flex gap-2">
              <button
                onClick={() => setEditingTrip(true)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit Trip
              </button>
              {(user?.role === "admin" || tripRole === "Owner") && (
                <button
                  onClick={async () => {
                    if (!tripId || !confirm("Delete this trip?")) return;
                    await tripsApi.delete(tripId);
                    navigate("/");
                  }}
                  className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  Delete Trip
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Participants */}
      <div className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowParticipants((v) => !v)}
            className="flex items-center gap-1 text-sm font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700"
          >
            Participants
            {showParticipants ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
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

        {showParticipants && canManageParticipants && showInvite && (() => {
          const participantUserIds = new Set(participants.map((p) => p.userId));
          const availableUsers = allUsers.filter((u) => !participantUserIds.has(u.id));
          return (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!tripId) return;
              setInviteError("");
              setInviteSuccess("");
              setInviteSending(true);
              try {
                if (inviteMode === "existing") {
                  const selected = allUsers.find((u) => u.id === inviteUserId);
                  if (!selected) return;
                  const p = await participantsApi.create(tripId, {
                    userId: selected.id,
                    name: selected.name,
                    role: "Viewer",
                  });
                  setParticipants([...participants, p]);
                  setInviteUserId("");
                  setShowInvite(false);
                } else {
                  const inv = await invitesApi.create(tripId, { name: inviteName || undefined });
                  const link = `${window.location.origin}/invite/${inv.token}`;
                  setInviteSuccess(link);
                  setPendingInvites([...pendingInvites, inv]);
                  setInviteName("");
                }
              } catch (err: any) {
                setInviteError(err.message);
              } finally {
                setInviteSending(false);
              }
            }}
            className="mb-4 rounded-lg border border-gray-200 bg-white p-4"
          >
            <div className="mb-3 flex gap-1 rounded-lg bg-gray-100 p-0.5 text-sm">
              {(["existing", "new"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setInviteMode(m); setInviteUserId(""); setInviteName(""); setInviteSuccess(""); setInviteError(""); }}
                  className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${inviteMode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                >
                  {m === "existing" ? "Existing user" : "New user"}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              {inviteMode === "existing" ? (
                <select
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                  value={inviteUserId}
                  onChange={(e) => setInviteUserId(e.target.value)}
                  required
                >
                  <option value="">Select a user...</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                  type="text"
                  placeholder="Name"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                />
              )}
              <button
                type="submit"
                disabled={inviteSending}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {inviteSending ? "..." : "Create Invite"}
              </button>
            </div>
            {inviteError && <p className="mt-2 text-sm text-red-600">{inviteError}</p>}
            {inviteSuccess && (
              <div className="mt-3">
                <p className="mb-1 text-sm text-green-600">Invite created! Share this link:</p>
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-600"
                    value={inviteSuccess}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(inviteSuccess)}
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

        {/* Participants + pending invites */}
        {showParticipants && (() => {
          // Build a map of participantId -> pending invite for deduplication
          const inviteByParticipantId = new Map(
            pendingInvites.filter((inv) => inv.participantId).map((inv) => [inv.participantId!, inv])
          );
          // Standalone invites not linked to any participant
          const standaloneInvites = pendingInvites.filter((inv) => !inv.participantId);
          const total = participants.length + standaloneInvites.length;
          if (total === 0) return null;
          return (
            <div className="space-y-1">
              {[...participants].sort((a, b) => (a.userId ? 0 : 1) - (b.userId ? 0 : 1)).map((p) => {
                const linkedInvite = inviteByParticipantId.get(p.id);
                const hasAccount = p.userId !== null;
                const inviteLink = linkedInvite ? `${window.location.origin}/invite/${linkedInvite.token}` : null;
                return (
                  <div key={p.id} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${hasAccount ? "border-gray-200 bg-white" : "border-dashed border-gray-200 bg-gray-50"}`}>
                    <div className="flex items-center gap-2">
                      <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${hasAccount ? "bg-accent-light text-accent" : "bg-gray-100 text-gray-400"}`}>
                        {p.name[0]}
                      </div>
                      <span className={`text-sm ${hasAccount ? "text-gray-700" : "text-gray-500"}`}>
                        {p.name}{p.userId === user?.id ? " (me)" : ""}
                      </span>
                      {!canManageParticipants && p.traveling && (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Traveling</span>
                      )}
                      {!hasAccount && (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${linkedInvite ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                          {linkedInvite ? "Invite pending" : "No account"}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {canManageParticipants ? (
                        <>
                          {!hasAccount && (
                            inviteLink ? (
                              <button
                                type="button"
                                onClick={() => copyInviteLink(linkedInvite!.id, inviteLink)}
                                className={`text-xs transition-colors ${copiedInviteId === linkedInvite!.id ? "text-green-600" : "text-accent hover:text-accent-hover"}`}
                                title={inviteLink}
                              >
                                {copiedInviteId === linkedInvite!.id ? "Copied!" : "Copy invite link"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={inviteSendingForParticipant[p.id]}
                                onClick={async () => {
                                  if (!tripId) return;
                                  setInviteSendingForParticipant((s) => ({ ...s, [p.id]: true }));
                                  try {
                                    const inv = await invitesApi.create(tripId, { name: p.name, participantId: p.id });
                                    setPendingInvites((prev) => [...prev, inv]);
                                  } finally {
                                    setInviteSendingForParticipant((s) => ({ ...s, [p.id]: false }));
                                  }
                                }}
                                className="text-xs text-accent hover:text-accent-hover disabled:opacity-50"
                              >
                                Invite
                              </button>
                            )
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              if (!tripId) return;
                              const updated = await participantsApi.update(tripId, p.id, { traveling: !p.traveling });
                              setParticipants(participants.map((x) => x.id === p.id ? updated : x));
                            }}
                            className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${p.traveling ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                          >
                            {p.traveling ? "Traveling" : "Not traveling"}
                          </button>
                          {hasAccount && (
                            <select
                              className="rounded border border-gray-200 bg-transparent px-2 py-0.5 text-xs text-gray-500 focus:border-accent focus:outline-none"
                              value={p.role}
                              onChange={async (e) => {
                                if (!tripId) return;
                                const updated = await participantsApi.update(tripId, p.id, { role: e.target.value as Participant["role"] });
                                setParticipants(participants.map((x) => x.id === p.id ? updated : x));
                              }}
                            >
                              <option value="Viewer">Viewer</option>
                              <option value="Editor">Editor</option>
                              <option value="Owner">Owner</option>
                            </select>
                          )}
                          {linkedInvite && (
                            <button
                              onClick={async () => {
                                if (!tripId) return;
                                await invitesApi.revoke(tripId, linkedInvite.id);
                                setPendingInvites(pendingInvites.filter((x) => x.id !== linkedInvite.id));
                              }}
                              className="text-xs text-red-400 hover:text-red-600"
                            >
                              Revoke
                            </button>
                          )}
                          {!linkedInvite && (
                            <button
                              onClick={async () => {
                                if (!tripId) return;
                                await participantsApi.remove(tripId, p.id);
                                setParticipants(participants.filter((x) => x.id !== p.id));
                              }}
                              className="text-xs text-red-400 hover:text-red-600"
                            >
                              Remove
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-gray-400">{hasAccount ? p.role : ""}</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {standaloneInvites.map((inv) => {
                const inviteLink = `${window.location.origin}/invite/${inv.token}`;
                return (
                  <div key={inv.id} className="flex items-center justify-between rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-400">
                        {inv.name ? inv.name[0] : "?"}
                      </div>
                      <span className="text-sm text-gray-500">{inv.name || "Invite"}</span>
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">Invite pending</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyInviteLink(inv.id, inviteLink)}
                        className={`text-xs transition-colors ${copiedInviteId === inv.id ? "text-green-600" : "text-accent hover:text-accent-hover"}`}
                        title={inviteLink}
                      >
                        {copiedInviteId === inv.id ? "Copied!" : "Copy invite link"}
                      </button>
                      {canManageParticipants && (
                        <button
                          onClick={async () => {
                            if (!tripId) return;
                            await invitesApi.revoke(tripId, inv.id);
                            setPendingInvites(pendingInvites.filter((x) => x.id !== inv.id));
                          }}
                          className="text-xs text-red-400 hover:text-red-600"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
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
        showCost={user?.role === "admin" || tripRole === "Owner" || tripRole === "Editor"}
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
