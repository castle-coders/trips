import { useState } from "react";
import type { Trip } from "../lib/types";

interface Props {
  trip: Trip;
  onSave: (data: Partial<Trip>) => Promise<void>;
  onClose: () => void;
}

export function EditTripModal({ trip, onSave, onClose }: Props) {
  const [form, setForm] = useState({
    name: trip.name,
    destination: trip.destination || "",
    startDate: trip.startDate || "",
    endDate: trip.endDate || "",
    description: trip.description || "",
    splitwiseGroupId: trip.splitwiseGroupId || "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        name: form.name,
        destination: form.destination || null,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        description: form.description || null,
        splitwiseGroupId: form.splitwiseGroupId || null,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/30">
      <div className="flex min-h-full items-end justify-center p-4 sm:items-center">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-lg sm:p-6"
      >
        <h2 className="mb-4 text-xl font-semibold">Edit Trip</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Name
            </span>
            <input
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Destination
            </span>
            <input
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
              value={form.destination}
              onChange={(e) =>
                setForm({ ...form, destination: e.target.value })
              }
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                Start Date
              </span>
              <input
                type="date"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                value={form.startDate}
                onChange={(e) =>
                  setForm({ ...form, startDate: e.target.value })
                }
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700">
                End Date
              </span>
              <input
                type="date"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                value={form.endDate}
                onChange={(e) =>
                  setForm({ ...form, endDate: e.target.value })
                }
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Description
            </span>
            <textarea
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
              rows={3}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Splitwise Group ID
            </span>
            <input
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
              value={form.splitwiseGroupId}
              onChange={(e) =>
                setForm({ ...form, splitwiseGroupId: e.target.value })
              }
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-3">
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
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
      </div>
    </div>
  );
}
