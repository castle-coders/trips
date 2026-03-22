import { Link } from "react-router-dom";
import type { Trip } from "../lib/types";
import { formatDateRange } from "../lib/format";
import { useAuth } from "../lib/auth";

const roleBadgeStyles: Record<string, string> = {
  admin: "bg-accent-light text-accent",
  editor: "bg-emerald-50 text-emerald-700",
  viewer: "bg-gray-100 text-gray-500",
};

export function TripCard({ trip }: { trip: Trip }) {
  const { user } = useAuth();
  const role = user?.role || "viewer";
  return (
    <Link
      to={`/trips/${trip.id}`}
      className="block rounded-xl border border-gray-200 bg-white p-6 transition-shadow hover:shadow-md"
    >
      <div className="mb-3 flex items-start justify-between">
        <h3 className="text-lg font-semibold text-gray-900">{trip.name}</h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeStyles[role] || roleBadgeStyles.viewer}`}
        >
          {role}
        </span>
      </div>
      {trip.destination && (
        <p className="mb-2 text-sm text-gray-600">{trip.destination}</p>
      )}
      <p className="text-xs text-gray-400">
        {formatDateRange(trip.startDate, trip.endDate)}
      </p>
    </Link>
  );
}
