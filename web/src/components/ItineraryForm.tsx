import { useState, useEffect } from "react";
import type { Itinerary, ItineraryType, Participant } from "../lib/types";

const TYPES: ItineraryType[] = [
  "Flight",
  "Lodging",
  "Rail",
  "Car",
  "Restaurant",
  "Transport",
  "Activity",
];

const STATUSES = ["Confirmed", "Pending", "Cancelled"] as const;

// Fields for each type's content
const typeFields: Record<ItineraryType, { key: string; label: string; type?: string; required?: boolean }[]> = {
  Flight: [
    { key: "airline", label: "Airline", required: true },
    { key: "flightNumber", label: "Flight Number", required: true },
    { key: "departureAirport", label: "Departure Airport", required: true },
    { key: "departureTime", label: "Departure Time", type: "datetime-local", required: true },
    { key: "arrivalAirport", label: "Arrival Airport", required: true },
    { key: "arrivalTime", label: "Arrival Time", type: "datetime-local", required: true },
    { key: "fareClass", label: "Fare Class" },
    { key: "baggageAllowance", label: "Baggage Allowance" },
  ],
  Lodging: [
    { key: "propertyName", label: "Property Name", required: true },
    { key: "address", label: "Address" },
    { key: "checkInTime", label: "Check-in Time (earliest)", type: "datetime-local", required: true },
    { key: "checkOutTime", label: "Check-out Time (latest)", type: "datetime-local", required: true },
    { key: "arrivalDateTime", label: "Planned Arrival", type: "datetime-local" },
    { key: "departureDateTime", label: "Planned Departure", type: "datetime-local" },
    { key: "roomType", label: "Room Type" },
    { key: "boardBasis", label: "Board Basis" },
    { key: "numberOfGuests", label: "Number of Guests", type: "number" },
  ],
  Rail: [
    { key: "trainOperator", label: "Operator", required: true },
    { key: "trainNumber", label: "Train Number", required: true },
    { key: "departureStation", label: "Departure Station", required: true },
    { key: "departureTime", label: "Departure Time", type: "datetime-local", required: true },
    { key: "arrivalStation", label: "Arrival Station", required: true },
    { key: "arrivalTime", label: "Arrival Time", type: "datetime-local", required: true },
  ],
  Car: [
    { key: "rentalCompany", label: "Rental Company", required: true },
    { key: "pickUpLocation", label: "Pick-up Location", required: true },
    { key: "pickUpTime", label: "Pick-up Time", type: "datetime-local", required: true },
    { key: "dropOffLocation", label: "Drop-off Location", required: true },
    { key: "dropOffTime", label: "Drop-off Time", type: "datetime-local", required: true },
    { key: "vehicleType", label: "Vehicle Type" },
  ],
  Restaurant: [
    { key: "restaurantName", label: "Restaurant Name", required: true },
    { key: "address", label: "Address" },
    { key: "reservationTime", label: "Reservation Time", type: "datetime-local", required: true },
    { key: "partySize", label: "Party Size", type: "number", required: true },
  ],
  Transport: [
    { key: "transportType", label: "Transport Type", required: true },
    { key: "operator", label: "Operator", required: true },
    { key: "departureLocation", label: "Departure Location", required: true },
    { key: "departureTime", label: "Departure Time", type: "datetime-local", required: true },
    { key: "arrivalLocation", label: "Arrival Location", required: true },
    { key: "arrivalTime", label: "Arrival Time", type: "datetime-local", required: true },
  ],
  Activity: [
    { key: "name", label: "Activity Name", required: true },
    { key: "location", label: "Location" },
    { key: "startTime", label: "Start Time", type: "datetime-local", required: true },
    { key: "endTime", label: "End Time", type: "datetime-local" },
  ],
};

// Which extra fields each type supports per-traveler
const travelerExtras: Record<ItineraryType, string[]> = {
  Flight: ["ticketNumber", "seatNumber"],
  Rail: ["ticketNumber", "seatNumber"],
  Transport: ["ticketNumber", "seatNumber"],
  Car: ["driverRole"],
  Lodging: [],
  Restaurant: [],
  Activity: [],
};

const flightLegFields: { key: string; label: string; type?: string; required?: boolean }[] = [
  { key: "airline", label: "Airline", required: true },
  { key: "flightNumber", label: "Flight Number", required: true },
  { key: "departureAirport", label: "Departure Airport", required: true },
  { key: "departureTime", label: "Departure Time", type: "datetime-local", required: true },
  { key: "arrivalAirport", label: "Arrival Airport", required: true },
  { key: "arrivalTime", label: "Arrival Time", type: "datetime-local", required: true },
  { key: "fareClass", label: "Fare Class" },
  { key: "baggageAllowance", label: "Baggage Allowance" },
];

type FlightLegEntry = Record<string, string>;

function emptyLeg(): FlightLegEntry {
  return { airline: "", flightNumber: "", departureAirport: "", departureTime: "", arrivalAirport: "", arrivalTime: "", fareClass: "", baggageAllowance: "" };
}

function initFlightLegs(initial: Itinerary | undefined): FlightLegEntry[] {
  if (!initial?.content || initial.type !== "Flight") return [emptyLeg()];
  const c = initial.content as Record<string, unknown>;
  const rawLegs = (c.legs as Array<Record<string, string>>) || [];
  if (rawLegs.length === 0) return [emptyLeg()];
  return rawLegs.map((l) => ({
    airline: l.airline || "",
    flightNumber: l.flightNumber || "",
    departureAirport: l.departureAirport || "",
    departureTime: l.departureTime || "",
    departureTimeTz: l.departureTimeTz || "",
    arrivalAirport: l.arrivalAirport || "",
    arrivalTime: l.arrivalTime || "",
    arrivalTimeTz: l.arrivalTimeTz || "",
    fareClass: l.fareClass || "",
    baggageAllowance: l.baggageAllowance || "",
  }));
}

interface TravelerEntry {
  participantId: string;
  name: string;
  ticketNumber?: string;
  seatByLeg: Record<number, string>; // leg index → seat number
  driverRole?: string;
}

function initTravelers(initial: Itinerary | undefined): TravelerEntry[] {
  if (!initial?.content) return [];
  const c = initial.content as Record<string, unknown>;
  const travelers = (c.travelers as Array<Record<string, string>>) || [];
  // Per-leg seatAssignments
  const rawLegs = (c.legs as Array<Record<string, unknown>>) || [];
  const legSeatMaps: Map<string, string>[] = rawLegs.map((leg) => {
    const seats = (leg.seatAssignments as Array<Record<string, string>>) || [];
    return new Map(seats.map((s) => [s.participantId, s.seatNumber]));
  });

  // Non-flight types: top-level seatAssignments
  const topSeats = (c.seatAssignments as Array<Record<string, string>>) || [];
  const topSeatMap = new Map(topSeats.map((s) => [s.participantId, s.seatNumber]));

  return travelers.map((t) => {
    const seatByLeg: Record<number, string> = {};
    if (initial?.type === "Flight") {
      legSeatMaps.forEach((m, i) => {
        const seat = m.get(t.participantId);
        if (seat) seatByLeg[i] = seat;
      });
    } else {
      const topSeat = topSeatMap.get(t.participantId);
      if (topSeat) seatByLeg[0] = topSeat;
    }
    return {
      participantId: t.participantId,
      name: t.name,
      ticketNumber: t.ticketNumber || undefined,
      seatByLeg,
      driverRole: t.driverRole || undefined,
    };
  });
}

interface Props {
  initial?: Itinerary;
  participants?: Participant[];
  onSave: (data: {
    type: ItineraryType;
    status: "Confirmed" | "Pending" | "Cancelled";
    content: Record<string, unknown>;
    confirmationNumber?: string;
    totalCost?: number;
    currency?: string;
    notes?: string;
  }) => Promise<void>;
  onClose: () => void;
}

export function ItineraryForm({ initial, participants: tripParticipants, onSave, onClose }: Props) {
  const [type, setType] = useState<ItineraryType>(initial?.type || "Flight");
  const [status, setStatus] = useState<typeof STATUSES[number]>(initial?.status || "Pending");
  const [content, setContent] = useState<Record<string, string>>(
    () => {
    const raw = (initial?.content as Record<string, string>) || {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      // datetime-local inputs require "YYYY-MM-DDTHH:MM" exactly — strip seconds/tz suffix
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
        out[k] = v.slice(0, 16);
      } else {
        out[k] = v;
      }
    }
    // Merge separate date+time fields into a single datetime-local value.
    // Agents may store checkInDate/checkOutDate separately from the time.
    if (out.checkInDate && out.checkInTime && !out.checkInTime.includes("T")) {
      out.checkInTime = `${out.checkInDate}T${out.checkInTime}`;
    }
    if (out.checkOutDate && out.checkOutTime && !out.checkOutTime.includes("T")) {
      out.checkOutTime = `${out.checkOutDate}T${out.checkOutTime}`;
    }
    return out;
  });
  const [confirmationNumber, setConfirmationNumber] = useState(
    initial?.confirmationNumber || ""
  );
  const [totalCost, setTotalCost] = useState(
    initial?.totalCost?.toString() || ""
  );
  const [currency, setCurrency] = useState(initial?.currency || "USD");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [travelers, setTravelers] = useState<TravelerEntry[]>(() => initTravelers(initial));
  const [flightLegs, setFlightLegs] = useState<FlightLegEntry[]>(() => initFlightLegs(initial));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const fields = typeFields[type];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};

      if (type === "Flight") {
        // All legs go in the legs array
        payload.legs = flightLegs.map((l) => {
          const leg: Record<string, string> = {
            airline: l.airline,
            flightNumber: l.flightNumber,
            departureAirport: l.departureAirport,
            departureTime: l.departureTime,
            arrivalAirport: l.arrivalAirport,
            arrivalTime: l.arrivalTime,
          };
          if (l.departureTimeTz) leg.departureTimeTz = l.departureTimeTz;
          if (l.arrivalTimeTz) leg.arrivalTimeTz = l.arrivalTimeTz;
          if (l.fareClass) leg.fareClass = l.fareClass;
          if (l.baggageAllowance) leg.baggageAllowance = l.baggageAllowance;
          return leg;
        });
      } else {
        // Build payload: convert numeric fields, strip empty optional fields
        for (const f of fields) {
          const val = content[f.key];
          if (val === undefined || val === "") {
            continue;
          }
          if (f.type === "number") {
            payload[f.key] = Number(val);
          } else {
            payload[f.key] = val;
          }
          // Include companion timezone field
          if (f.type === "datetime-local") {
            const tz = content[`${f.key}Tz`];
            if (tz) payload[`${f.key}Tz`] = tz;
          }
        }
      }

      // Add travelers to content
      if (travelers.length > 0) {
        const extras = travelerExtras[type];
        payload.travelers = travelers.map((t) => {
          const ref: Record<string, string> = { participantId: t.participantId, name: t.name };
          if (extras.includes("ticketNumber") && t.ticketNumber) ref.ticketNumber = t.ticketNumber;
          if (type === "Car" && t.driverRole) ref.driverRole = t.driverRole;
          return ref;
        });

        if (type === "Flight") {
          // Seat assignments go on each leg
          const legsArr = payload.legs as Array<Record<string, unknown>>;
          legsArr.forEach((leg, li) => {
            const legSeats = travelers
              .filter((t) => t.seatByLeg[li])
              .map((t) => ({ participantId: t.participantId, seatNumber: t.seatByLeg[li] }));
            if (legSeats.length > 0) leg.seatAssignments = legSeats;
          });
        } else if (extras.includes("seatNumber")) {
          // Non-flight: single seat from seatByLeg[0]
          const seats = travelers
            .filter((t) => t.seatByLeg[0])
            .map((t) => ({ participantId: t.participantId, seatNumber: t.seatByLeg[0] }));
          if (seats.length > 0) payload.seatAssignments = seats;
        }
      }
      await onSave({
        type,
        status,
        content: payload,
        confirmationNumber: confirmationNumber || undefined,
        totalCost: totalCost ? Number(totalCost) : undefined,
        currency: currency || undefined,
        notes: notes || undefined,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none";

  const tzOptions = [
    "", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver",
    "America/Chicago", "America/New_York", "America/Halifax", "America/Sao_Paulo",
    "Atlantic/Reykjavik", "Europe/London", "Europe/Paris", "Europe/Helsinki",
    "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Shanghai",
    "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
  ];

  /** Renders a datetime-local input paired with a timezone select. */
  const renderDateTimeTz = (
    value: string,
    tzValue: string,
    onChange: (v: string) => void,
    onTzChange: (v: string) => void,
    required?: boolean,
  ) => (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
      <input
        className="w-full min-w-0 max-w-[calc(100vw-4.5rem)] sm:max-w-full rounded-lg border border-gray-300 px-1 sm:px-3 py-2 text-xs sm:text-sm focus:border-accent focus:outline-none"
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
      <select
        className="w-full min-w-0 max-w-[calc(100vw-4.5rem)] sm:max-w-full rounded-lg border border-gray-300 px-1 sm:px-2 py-2 text-xs sm:text-sm focus:border-accent focus:outline-none sm:w-36 sm:shrink-0"
        value={tzValue}
        onChange={(e) => onTzChange(e.target.value)}
      >
        <option value="">Timezone</option>
        {tzOptions.filter(Boolean).map((tz) => (
          <option key={tz} value={tz}>
            {tz.replace(/_/g, " ").replace(/^.*\//, "")}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex min-h-full items-end justify-center p-2 sm:p-4 sm:items-center"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg overflow-hidden rounded-xl bg-white p-4 shadow-lg sm:p-6"
      >
        <h2 className="mb-4 text-xl font-semibold">
          {initial ? "Edit" : "Add"} Itinerary Item
        </h2>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Type
            </span>
            <select
              className={inputClass}
              value={type}
              onChange={(e) => {
                setType(e.target.value as ItineraryType);
                setContent({});
              }}
            >
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Status
            </span>
            <select
              className={inputClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof STATUSES[number])}
            >
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>

        {/* Flight legs — each is a full flight entry */}
        {type === "Flight" && (
          <div className="mb-4 space-y-3">
            {flightLegs.map((leg, i) => (
              <fieldset key={i} className="min-w-0 space-y-3 rounded-lg border border-gray-200 p-3 sm:p-4">
                <legend className="px-2 text-sm font-medium text-gray-500">
                  <div className="flex items-center gap-3">
                    <span>Flight {i + 1}</span>
                    {flightLegs.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setFlightLegs(flightLegs.filter((_, j) => j !== i))}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </legend>
                {flightLegFields.map((f) => (
                  <label key={f.key} className="block">
                    <span className="mb-1 block text-sm font-medium text-gray-700">
                      {f.label}
                    </span>
                    {f.type === "datetime-local" ? renderDateTimeTz(
                      leg[f.key] || "",
                      leg[`${f.key}Tz`] || "",
                      (v) => {
                        const next = [...flightLegs];
                        next[i] = { ...leg, [f.key]: v };
                        setFlightLegs(next);
                      },
                      (v) => {
                        const next = [...flightLegs];
                        next[i] = { ...leg, [`${f.key}Tz`]: v };
                        setFlightLegs(next);
                      },
                      f.required,
                    ) : (
                      <input
                        className={inputClass}
                        type={f.type || "text"}
                        value={leg[f.key] || ""}
                        onChange={(e) => {
                          const next = [...flightLegs];
                          next[i] = { ...leg, [f.key]: e.target.value };
                          setFlightLegs(next);
                        }}
                        required={f.required}
                      />
                    )}
                  </label>
                ))}
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() => setFlightLegs([...flightLegs, emptyLeg()])}
              className="w-full rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-700"
            >
              + Add Flight
            </button>
          </div>
        )}

        {/* Non-flight type details */}
        {type !== "Flight" && (
          <fieldset className="mb-4 min-w-0 space-y-3 rounded-lg border border-gray-200 p-3 sm:p-4">
            <legend className="px-2 text-sm font-medium text-gray-500">
              {type} Details
            </legend>
            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700">
                  {f.label}
                </span>
                {f.type === "datetime-local" ? renderDateTimeTz(
                  content[f.key] || "",
                  content[`${f.key}Tz`] || "",
                  (v) => setContent({ ...content, [f.key]: v }),
                  (v) => setContent({ ...content, [`${f.key}Tz`]: v }),
                  f.required,
                ) : (
                  <input
                    className={inputClass}
                    type={f.type || "text"}
                    value={content[f.key] || ""}
                    onChange={(e) =>
                      setContent({ ...content, [f.key]: e.target.value })
                    }
                    required={f.required}
                    min={f.type === "number" ? 1 : undefined}
                  />
                )}
              </label>
            ))}
          </fieldset>
        )}

        {/* Travelers */}
        {tripParticipants && tripParticipants.length > 0 && (
          <fieldset className="mb-4 space-y-3 rounded-lg border border-gray-200 p-4">
            <legend className="px-2 text-sm font-medium text-gray-500">
              Participants
            </legend>
            {tripParticipants.map((p) => {
              const idx = travelers.findIndex((t) => t.participantId === p.id);
              const isSelected = idx !== -1;
              const entry = isSelected ? travelers[idx] : null;
              const extras = travelerExtras[type];

              const toggle = () => {
                if (isSelected) {
                  setTravelers(travelers.filter((t) => t.participantId !== p.id));
                } else {
                  setTravelers([...travelers, { participantId: p.id, name: p.name, seatByLeg: {} }]);
                }
              };

              const update = (field: string, value: string) => {
                setTravelers(travelers.map((t) =>
                  t.participantId === p.id ? { ...t, [field]: value } : t
                ));
              };

              return (
                <div key={p.id} className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={toggle}
                      className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent"
                    />
                    <span className="text-sm font-medium text-gray-700">{p.name}</span>
                  </label>
                  {isSelected && extras.length > 0 && (
                    <div className="ml-6 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        {extras.includes("ticketNumber") && (
                          <input
                            className={inputClass}
                            placeholder="Ticket #"
                            value={entry?.ticketNumber || ""}
                            onChange={(e) => update("ticketNumber", e.target.value)}
                          />
                        )}
                        {extras.includes("driverRole") && (
                          <select
                            className={inputClass}
                            value={entry?.driverRole || ""}
                            onChange={(e) => update("driverRole", e.target.value)}
                          >
                            <option value="">Role...</option>
                            <option value="Primary Driver">Primary Driver</option>
                            <option value="Additional Driver">Additional Driver</option>
                            <option value="Passenger">Passenger</option>
                          </select>
                        )}
                      </div>
                      {/* Per-flight seat assignments */}
                      {type === "Flight" && flightLegs.length > 0 && (
                        <div className="space-y-1">
                          {flightLegs.map((leg, li) => (
                            <div key={li} className="flex items-center gap-2">
                              <span className="w-28 shrink-0 truncate text-xs text-gray-400">
                                {leg.airline && leg.flightNumber
                                  ? `${leg.airline} ${leg.flightNumber}`
                                  : `Flight ${li + 1}`}
                              </span>
                              <input
                                className={inputClass}
                                placeholder="Seat"
                                value={entry?.seatByLeg[li] || ""}
                                onChange={(e) => {
                                  setTravelers(travelers.map((t) =>
                                    t.participantId === p.id
                                      ? { ...t, seatByLeg: { ...t.seatByLeg, [li]: e.target.value } }
                                      : t
                                  ));
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Single seat for non-flight types */}
                      {type !== "Flight" && extras.includes("seatNumber") && (
                        <input
                          className={inputClass}
                          placeholder="Seat"
                          value={entry?.seatByLeg[0] || ""}
                          onChange={(e) => {
                            setTravelers(travelers.map((t) =>
                              t.participantId === p.id
                                ? { ...t, seatByLeg: { ...t.seatByLeg, 0: e.target.value } }
                                : t
                            ));
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}

        <div className="mb-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                Confirmation #
              </span>
              <input
                className={inputClass}
                value={confirmationNumber}
                onChange={(e) => setConfirmationNumber(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                Total Cost
              </span>
              <input
                className={inputClass}
                type="number"
                step="0.01"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                Currency
              </span>
              <input
                className={inputClass}
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Notes
            </span>
            <textarea
              className={inputClass}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : initial ? "Update" : "Create"}
          </button>
        </div>
      </form>
      </div>
    </div>
  );
}
