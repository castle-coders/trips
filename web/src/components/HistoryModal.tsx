import { useEffect } from "react";
import { X } from "lucide-react";
import type { AuditLoader } from "../lib/types";
import { ActivityFeed } from "./ActivityFeed";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Modal heading, e.g. "History: Flight UA 123". */
  title: string;
  /** Entity loader, typically `(cursor) => audit.entity(tripId, type, id, { cursor })`, memoized with useCallback. */
  load: AuditLoader;
}

/** Per-item history in a modal. Closes on Escape, the backdrop, or the close button. */
export function HistoryModal({ open, onClose, title, load }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex min-h-full items-end justify-center p-4 sm:items-center"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-modal-title"
          className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-lg sm:p-6"
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="history-modal-title" className="text-xl font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            <ActivityFeed load={load} emptyText="No history yet." />
          </div>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
