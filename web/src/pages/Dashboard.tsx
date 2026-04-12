import { useEffect, useState } from "react";
import { trips as tripsApi } from "../lib/api";
import type { Trip } from "../lib/types";
import { TripCard } from "../components/TripCard";
import { useAuth } from "../lib/auth";

type Tab = "upcoming" | "past";

function isPastTrip(trip: Trip): boolean {
  if (!trip.endDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return trip.endDate < today;
}

export function Dashboard() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [tab, setTab] = useState<Tab>("upcoming");
  const { user, logout } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const sortTrips = (list: Trip[]) =>
    [...list].sort((a, b) => {
      if (!a.startDate && !b.startDate) return 0;
      if (!a.startDate) return 1;
      if (!b.startDate) return -1;
      return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0;
    });

  const upcomingTrips = trips.filter((t) => !isPastTrip(t));
  const pastTrips = trips.filter(isPastTrip);
  const visibleTrips = tab === "upcoming" ? upcomingTrips : pastTrips;

  useEffect(() => {
    tripsApi.list()
      .then((data) => setTrips(sortTrips(data)))
      .catch((err) => setError(err.message || "Failed to load trips"))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const trip = await tripsApi.create({ name: newName.trim() });
    setTrips(sortTrips([...trips, trip]));
    setNewName("");
    setShowCreate(false);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <img src="/favicon.png" alt="Clawdbot Logo" className="h-12 w-12 shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Trips</h1>
            <p className="text-sm text-gray-500">
              {visibleTrips.length} trip{visibleTrips.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/account"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Account
          </a>
          {user?.role === "admin" && (
            <a
              href="/admin"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Admin
            </a>
          )}
          {canEdit && (
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              + New Trip
            </button>
          )}
          <button
            onClick={logout}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Sign out
          </button>
        </div>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row"
        >
          <input
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            placeholder="Trip name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(false)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
        </form>
      )}

      {!loading && trips.length > 0 && (
        <div className="mb-6 flex gap-1 border-b border-gray-200">
          <button
            onClick={() => setTab("upcoming")}
            className={`px-4 py-2 text-sm font-medium ${
              tab === "upcoming"
                ? "border-b-2 border-accent text-accent"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Upcoming{upcomingTrips.length > 0 ? ` (${upcomingTrips.length})` : ""}
          </button>
          <button
            onClick={() => setTab("past")}
            className={`px-4 py-2 text-sm font-medium ${
              tab === "past"
                ? "border-b-2 border-accent text-accent"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Past{pastTrips.length > 0 ? ` (${pastTrips.length})` : ""}
          </button>
        </div>
      )}

      {loading ? (
        <p className="py-20 text-center text-gray-400">Loading...</p>
      ) : error ? (
        <p className="py-20 text-center text-red-500">{error}</p>
      ) : trips.length === 0 ? (
        <p className="py-20 text-center text-gray-400">
          No trips yet. Create one to get started.
        </p>
      ) : visibleTrips.length === 0 ? (
        <p className="py-20 text-center text-gray-400">
          No {tab} trips.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleTrips.map((trip) => (
            <TripCard key={trip.id} trip={trip} />
          ))}
        </div>
      )}
    </div>
  );
}
