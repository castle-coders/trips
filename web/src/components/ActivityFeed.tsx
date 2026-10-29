import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AuditEvent, AuditLoader } from "../lib/types";
import {
  channelLabel,
  describeEvent,
  describeSnapshot,
  formatEventTime,
  formatValue,
} from "../lib/auditText";

interface Props {
  /**
   * Page loader. Called with null on mount and with `nextCursor` for "Load more".
   * The feed reloads from the top whenever this function's identity changes, so
   * wrap it in `useCallback` keyed on the current filters.
   */
  load: AuditLoader;
  emptyText?: string;
  /** Show the trip id in the expanded row (admin feed, where events span trips). */
  showTrip?: boolean;
  /** Also show the raw before/after/changes/metadata JSON in the expanded row (admin feed). */
  showRaw?: boolean;
}

export function ActivityFeed({ load, emptyText = "No activity yet.", showTrip = false, showRaw = false }: Props) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Ignore responses from a loader that has since been replaced.
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    // An in-flight "load more" from the previous loader skips its own finally, so clear it here.
    setLoadingMore(false);
    setError(null);
    setEvents([]);
    setNextCursor(null);
    setExpanded(new Set());
    load(null)
      .then((page) => {
        if (seq !== requestSeq.current) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : "Failed to load activity");
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await load(nextCursor);
      if (seq !== requestSeq.current) return;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...page.events.filter((e) => !seen.has(e.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load more activity");
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }, [load, nextCursor, loadingMore]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return <p className="py-6 text-center text-sm text-gray-500">Loading activity...</p>;
  }

  if (error && events.length === 0) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (events.length === 0) {
    return <p className="py-6 text-center text-sm text-gray-500">{emptyText}</p>;
  }

  return (
    <div>
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {events.map((event) => (
          <ActivityRow
            key={event.id}
            event={event}
            open={expanded.has(event.id)}
            onToggle={() => toggle(event.id)}
            showTrip={showTrip}
            showRaw={showRaw}
          />
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {nextCursor && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  event: AuditEvent;
  open: boolean;
  onToggle: () => void;
  showTrip: boolean;
  showRaw: boolean;
}

function ActivityRow({ event, open, onToggle, showTrip, showRaw }: RowProps) {
  const { headline, via, details } = describeEvent(event);
  const Chevron = open ? ChevronDown : ChevronRight;
  const currency =
    typeof event.after?.currency === "string"
      ? event.after.currency
      : typeof event.before?.currency === "string"
        ? event.before.currency
        : undefined;
  const showSnapshot = details.length === 0;
  const snapshot = showSnapshot ? describeSnapshot(event) : [];

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-gray-50"
      >
        <Chevron className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-gray-900">{headline}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <time dateTime={event.createdAt}>{formatEventTime(event.createdAt)}</time>
            {via && (
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                via {via}
              </span>
            )}
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-3 pl-9 text-sm">
          {details.length > 0 && (
            <dl className="space-y-1">
              {details.map((d, i) => (
                <div key={i} className="flex flex-wrap gap-x-2">
                  <dt className="font-medium text-gray-700">{d.label}</dt>
                  <dd className="text-gray-600">
                    {d.kind === "added" && `set to ${formatValue(d.label, d.to, currency)}`}
                    {d.kind === "removed" && `removed (was ${formatValue(d.label, d.from, currency)})`}
                    {d.kind === "changed" &&
                      `from ${formatValue(d.label, d.from, currency)} to ${formatValue(d.label, d.to, currency)}`}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {showSnapshot && snapshot.length > 0 && (
            <dl className="space-y-1">
              {snapshot.map((row, i) => (
                <div key={i} className="flex flex-wrap gap-x-2">
                  <dt className="font-medium text-gray-700">{row.label}</dt>
                  <dd className="text-gray-600">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {showSnapshot && snapshot.length === 0 && (
            <p className="text-gray-500">No further details.</p>
          )}
          <p className="mt-3 text-xs text-gray-500">
            {event.actorEmail ? `${event.actorEmail} · ` : ""}
            {channelLabel(event.channel)}
            {event.clientName || event.clientId ? ` · ${event.clientName ?? event.clientId}` : ""}
            {showTrip && event.tripId ? ` · trip ${event.tripId}` : ""}
          </p>
          {showRaw && (
            <pre className="mt-3 max-h-96 overflow-auto rounded bg-gray-50 p-3 text-xs text-gray-700">
              {JSON.stringify(
                {
                  before: event.before,
                  after: event.after,
                  changes: event.changes,
                  metadata: event.metadata,
                  requestId: event.requestId ?? null,
                },
                null,
                2
              )}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
