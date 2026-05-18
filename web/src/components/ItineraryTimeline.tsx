import type { Itinerary } from "../lib/types";
import { Plane, Bed, TrainFront, Car, Utensils, Bus, MapPin, Map as MapIcon } from "lucide-react";

const getTypeIcon = (type: string) => {
  const props = { className: "w-3 h-3" };
  switch (type) {
    case "Flight": return <Plane {...props} />;
    case "Lodging": case "Lodging-arrival": case "Lodging-departure": return <Bed {...props} />;
    case "Rail": return <TrainFront {...props} />;
    case "Car": return <Car {...props} />;
    case "Restaurant": return <Utensils {...props} />;
    case "Transport": return <Bus {...props} />;
    case "Activity": return <MapPin {...props} />;
    default: return <MapIcon {...props} />;
  }
};

const typeColors: Record<string, string> = {
  Flight: "bg-blue-100 text-blue-700",
  Lodging: "bg-purple-100 text-purple-700",
  "Lodging-arrival": "bg-purple-100 text-purple-700",
  "Lodging-departure": "bg-purple-100 text-purple-700",
  Rail: "bg-orange-100 text-orange-700",
  Car: "bg-green-100 text-green-700",
  Restaurant: "bg-red-100 text-red-700",
  Transport: "bg-yellow-100 text-yellow-700",
  Activity: "bg-pink-100 text-pink-700",
};

const statusStyles: Record<string, string> = {
  Confirmed: "bg-emerald-50 text-emerald-700",
  Pending: "bg-amber-50 text-amber-700",
  Cancelled: "bg-red-50 text-red-600 line-through",
};

// A display-only entry used for rendering the timeline
interface TimelineEntry {
  key: string;
  item: Itinerary;
  displayType: string;
  title: string;
  timeLabel: string;
  secondaryTimeLabel?: string;
  sortTime: number;
  legIndex?: number; // for flights with multiple legs
}

function formatTime(time: string, tz?: string): string {
  // The stored datetime string is a wall-clock time (as entered by the user),
  // not a UTC timestamp. Append "Z" so Date() treats it as UTC and preserves
  // the numeric values rather than reinterpreting them in the browser's locale.
  const hasOffset = /[Z+\-]\d*$/.test(time);
  const utcTime = hasOffset ? time : time + "Z";
  const d = new Date(utcTime);

  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  };

  if (tz) {
    try {
      // Format the stored values directly (as UTC) then append the tz abbreviation.
      const formatted = d.toLocaleString("en-US", opts);
      const abbr = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "short",
      }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
      return abbr ? `${formatted} ${abbr}` : formatted;
    } catch { /* fall through on invalid tz */ }
  }

  return d.toLocaleString("en-US", opts);
}

function buildEntries(items: Itinerary[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const item of items) {
    const c = item.content as Record<string, string>;

    if (item.type === "Lodging") {
      const name = c.propertyName || "Lodging";
      // Combine a bare time ("15:00") with a separate date field if the time lacks a date component.
      const hasDate = (t: string) => /^\d{4}-\d{2}-\d{2}/.test(t);
      const mergeDateTime = (date: string | undefined, time: string | undefined) =>
        time ? (date && !hasDate(time) ? `${date}T${time}` : time) : undefined;
      const checkInDateTime = mergeDateTime(c.checkInDate, c.checkInTime);
      const checkOutDateTime = mergeDateTime(c.checkOutDate, c.checkOutTime);
      const arrivalDateTime = c.arrivalDateTime || undefined;
      const departureDateTime = c.departureDateTime || undefined;
      const arrivalSortTime = arrivalDateTime || checkInDateTime;
      const departureSortTime = departureDateTime || checkOutDateTime;

      let arrivalTimeLabel = "";
      let arrivalSecondaryTimeLabel: string | undefined;
      if (arrivalDateTime && checkInDateTime) {
        arrivalTimeLabel = `Planned arrival: ${formatTime(arrivalDateTime, c.arrivalDateTimeTz || undefined)}`;
        arrivalSecondaryTimeLabel = `Check-in: ${formatTime(checkInDateTime, c.checkInTimeTz || undefined)}`;
      } else if (arrivalDateTime) {
        arrivalTimeLabel = formatTime(arrivalDateTime, c.arrivalDateTimeTz || undefined);
      } else if (checkInDateTime) {
        arrivalTimeLabel = formatTime(checkInDateTime, c.checkInTimeTz || undefined);
      }

      let departureTimeLabel = "";
      let departureSecondaryTimeLabel: string | undefined;
      if (departureDateTime && checkOutDateTime) {
        departureTimeLabel = `Planned departure: ${formatTime(departureDateTime, c.departureDateTimeTz || undefined)}`;
        departureSecondaryTimeLabel = `Check-out: ${formatTime(checkOutDateTime, c.checkOutTimeTz || undefined)}`;
      } else if (departureDateTime) {
        departureTimeLabel = formatTime(departureDateTime, c.departureDateTimeTz || undefined);
      } else if (checkOutDateTime) {
        departureTimeLabel = formatTime(checkOutDateTime, c.checkOutTimeTz || undefined);
      }

      // Arrival entry
      if (arrivalSortTime) {
        entries.push({
          key: `${item.id}-arrival`,
          item,
          displayType: "Lodging-arrival",
          title: `${name} — Check-in`,
          timeLabel: arrivalTimeLabel,
          secondaryTimeLabel: arrivalSecondaryTimeLabel,
          sortTime: new Date(arrivalSortTime).getTime(),
        });
      }
      // Departure entry
      if (departureSortTime) {
        entries.push({
          key: `${item.id}-departure`,
          item,
          displayType: "Lodging-departure",
          title: `${name} — Check-out`,
          timeLabel: departureTimeLabel,
          secondaryTimeLabel: departureSecondaryTimeLabel,
          sortTime: new Date(departureSortTime).getTime(),
        });
      }
      // Fallback if no dates at all
      if (!arrivalSortTime && !departureSortTime) {
        entries.push({
          key: item.id,
          item,
          displayType: "Lodging",
          title: name,
          timeLabel: "",
          sortTime: Infinity,
        });
      }
      continue;
    }

    // Flights: one timeline entry per leg
    if (item.type === "Flight") {
      const cc = item.content as Record<string, unknown>;
      const allLegs = ((cc.legs as Array<Record<string, string>>) || []).map((l) => ({
        airline: l.airline || "", flightNumber: l.flightNumber || "",
        departureAirport: l.departureAirport || "", departureTime: l.departureTime || "",
        departureTimeTz: l.departureTimeTz || "", arrivalAirport: l.arrivalAirport || "",
        arrivalTime: l.arrivalTime || "", arrivalTimeTz: l.arrivalTimeTz || "",
      }));
      for (let li = 0; li < allLegs.length; li++) {
        const leg = allLegs[li];
        const legTitle = `${leg.airline || ""} ${leg.flightNumber || ""} — ${leg.departureAirport || ""} to ${leg.arrivalAirport || ""}`.trim();
        const time = leg.departureTime;
        const depTz = leg.departureTimeTz || undefined;
        const arrTz = leg.arrivalTimeTz || undefined;
        const depLabel = time ? formatTime(time, depTz) : "";
        const arrLabel = leg.arrivalTime ? formatTime(leg.arrivalTime, arrTz) : "";
        const timeLabel = arrLabel ? `${depLabel} → ${arrLabel}` : depLabel;
        entries.push({
          key: allLegs.length > 1 ? `${item.id}-leg-${li}` : item.id,
          item,
          displayType: "Flight",
          title: legTitle,
          timeLabel,
          sortTime: time ? new Date(time).getTime() : Infinity,
          legIndex: li,
        });
      }
      continue;
    }

    // All other types
    let title: string;
    switch (item.type) {
      case "Rail":
        title = `${c.trainOperator || ""} ${c.trainNumber || ""} — ${c.departureStation || ""} to ${c.arrivalStation || ""}`.trim();
        break;
      case "Car":
        title = `${c.rentalCompany || ""} — ${c.vehicleType || "Car"}`.trim();
        break;
      case "Restaurant":
        title = c.restaurantName || "Restaurant";
        break;
      case "Transport":
        title = `${c.operator || ""} — ${c.departureLocation || ""} to ${c.arrivalLocation || ""}`.trim();
        break;
      case "Activity":
        title = c.name || "Activity";
        break;
      default:
        title = item.type;
    }

    const timeKey =
      c.departureTime ? "departureTime" :
      c.pickUpTime ? "pickUpTime" :
      c.reservationTime ? "reservationTime" :
      c.startTime ? "startTime" : "";
    const time = timeKey ? c[timeKey] : "";
    const timeTz = timeKey ? c[`${timeKey}Tz`] || undefined : undefined;

    entries.push({
      key: item.id,
      item,
      displayType: item.type,
      title,
      timeLabel: time ? formatTime(time, timeTz) : "",
      sortTime: time ? new Date(time).getTime() : Infinity,
    });
  }

  return entries.sort((a, b) => a.sortTime - b.sortTime);
}

function formatDayHeader(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function groupByDay(entries: TimelineEntry[]): { date: string; entries: TimelineEntry[] }[] {
  const groups: { date: string; entries: TimelineEntry[] }[] = [];
  let currentDate = "";

  for (const entry of entries) {
    let dayKey: string;
    if (!isFinite(entry.sortTime)) {
      dayKey = "Unscheduled";
    } else {
      const d = new Date(entry.sortTime);
      dayKey = formatDayHeader(d);
    }

    if (dayKey !== currentDate) {
      currentDate = dayKey;
      groups.push({ date: dayKey, entries: [] });
    }
    groups[groups.length - 1].entries.push(entry);
  }

  return groups;
}

export function ItineraryTimeline({
  items,
  onEdit,
  onDelete,
  showCost = true,
}: {
  items: Itinerary[];
  onEdit?: (item: Itinerary) => void;
  onDelete?: (item: Itinerary) => void;
  showCost?: boolean;
}) {
  const entries = buildEntries(items);

  if (!entries.length) {
    return (
      <p className="py-8 text-center text-sm text-gray-400">
        No itinerary items yet.
      </p>
    );
  }

  const dayGroups = groupByDay(entries);

  return (
    <div className="space-y-6">
      {dayGroups.map((group) => (
        <div key={group.date}>
          <h3 className="mb-3 text-sm font-semibold text-gray-500 uppercase tracking-wide">
            {group.date}
          </h3>
          <div className="relative space-y-4">
            <div className="absolute top-0 bottom-0 left-5 w-px bg-gray-200" />
            {group.entries.map((entry) => {
        const colorKey = entry.displayType;
        const badgeLabel = entry.displayType.startsWith("Lodging")
          ? "Lodging"
          : entry.displayType;
        return (
          <div key={entry.key} className="relative flex gap-4 pl-12">
            <div
              className={`absolute left-3 top-1 h-5 w-5 rounded-full ${typeColors[colorKey] || "bg-gray-100 text-gray-700"} flex items-center justify-center`}
            >
              {getTypeIcon(colorKey)}
            </div>
            <div
              className={`flex-1 rounded-lg border border-gray-200 bg-white p-3 sm:p-4 ${onEdit ? "cursor-pointer hover:border-gray-300" : ""}`}
              onClick={() => onEdit?.(entry.item)}
            >
              <div className="mb-1 flex items-center gap-1.5 sm:gap-2">
                <div className="flex flex-1 flex-wrap items-center gap-1.5 sm:gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${typeColors[colorKey]}`}
                  >
                    {badgeLabel}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${statusStyles[entry.item.status]}`}
                  >
                    {entry.item.status}
                  </span>
                  {entry.item.confirmationNumber && (
                    <span className="text-xs text-gray-400">
                      #{entry.item.confirmationNumber}
                    </span>
                  )}
                </div>
                {onDelete && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm("Delete this item?")) {
                        onDelete(entry.item);
                      }
                    }}
                    className="ml-auto shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"
                    title="Delete"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                      <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
              </div>
              <h4 className="font-medium text-gray-900">{entry.title}</h4>
              <p className="text-sm text-gray-500">{entry.timeLabel}</p>
              {entry.secondaryTimeLabel && (
                <p className="text-sm text-gray-500">{entry.secondaryTimeLabel}</p>
              )}
              {(() => {
                const c = entry.item.content as Record<string, unknown>;
                const address =
                  (entry.item.type === "Lodging" || entry.item.type === "Restaurant")
                    ? (c.address as string | undefined)
                    : entry.item.type === "Activity"
                    ? (c.location as string | undefined)
                    : undefined;
                if (!address) return null;
                return (
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-gray-500">
                    <MapPin className="h-3 w-3 shrink-0" />
                    <a
                      href={`https://maps.google.com/maps?q=${encodeURIComponent(address)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="hover:underline"
                    >
                      {address}
                    </a>
                  </p>
                );
              })()}
              {showCost && entry.item.totalCost != null && (
                <p className="mt-1 text-sm font-medium text-gray-700">
                  {entry.item.currency || "USD"}{" "}
                  {entry.item.totalCost.toFixed(2)}
                </p>
              )}
              {/* Travelers */}
              {(() => {
                const c = entry.item.content as Record<string, unknown>;
                const travelers = c.travelers as Array<Record<string, string>> | undefined;
                if (!travelers?.length) return null;

                // Get seat assignments for this specific leg
                let seatMap: Map<string, string>;
                if (entry.item.type === "Flight" && entry.legIndex != null) {
                  const rawLegs = c.legs as Array<Record<string, unknown>> | undefined;
                  const leg = rawLegs?.[entry.legIndex];
                  const seats = leg?.seatAssignments as Array<Record<string, string>> | undefined;
                  seatMap = new Map(seats?.map((s) => [s.participantId, s.seatNumber]) || []);
                } else {
                  const seats = c.seatAssignments as Array<Record<string, string>> | undefined;
                  seatMap = new Map(seats?.map((s) => [s.participantId, s.seatNumber]) || []);
                }

                return (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {travelers.map((t) => {
                      const seatNumber = seatMap.get(t.participantId);
                      const details = [t.ticketNumber, seatNumber && `Seat ${seatNumber}`, t.driverRole].filter(Boolean);
                      return (
                        <span
                          key={t.participantId}
                          className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                        >
                          <span className="font-medium">{t.name}</span>
                          {details.length > 0 && (
                            <span className="text-gray-400">
                              ({details.join(", ")})
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })}
          </div>
        </div>
      ))}
    </div>
  );
}
