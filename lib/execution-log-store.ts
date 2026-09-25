import {
  dedupeMonitorEvents,
  type ExecutionLogEvent,
} from '@/lib/test-mode/execution-monitor';

/**
 * An execution event and the desk it belongs to. `ownerEmail` is null only
 * for a process-level beat (counts across every desk, no order levels); an
 * order event with no known owner is never shown to anyone.
 */
export type OwnedExecutionLogEvent = {
  ownerEmail: string | null;
  event: ExecutionLogEvent;
};

const MAX = 2_000;
const buf: OwnedExecutionLogEvent[] = [];

export function normalizeOwnerEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Order events are visible to their owner only; beats to every desk. */
export function isVisibleTo(entry: OwnedExecutionLogEvent, viewerEmail: string): boolean {
  if (entry.event.kind === 'beat') {
    return entry.ownerEmail === null || entry.ownerEmail === viewerEmail;
  }
  return entry.ownerEmail !== null && entry.ownerEmail === viewerEmail;
}

export function appendExecutionLogs(entries: readonly OwnedExecutionLogEvent[]) {
  if (entries.length === 0) return;
  buf.push(...entries);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

export function listExecutionLogs(viewerEmail: string, limit = 200): ExecutionLogEvent[] {
  const n = Math.min(Math.max(1, limit), MAX);
  const viewer = normalizeOwnerEmail(viewerEmail);
  const visible = buf
    .filter(entry => isVisibleTo(entry, viewer))
    .slice(-n)
    .reverse()
    .map(entry => entry.event);
  return dedupeMonitorEvents(visible).slice(0, n);
}

export function executionLogSize(): number {
  return buf.length;
}

export function clearExecutionLogs() {
  buf.length = 0;
}
