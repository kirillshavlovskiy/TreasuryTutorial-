import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import type { ExecutionLogEvent } from '@/lib/test-mode/execution-monitor';
import type {
  MatchingFillNotice,
  MatchingHeartbeat,
  MatchingHeartbeatProbe,
} from '@/lib/test-mode/matching-process-runtime';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';
import { WORKSPACE_SANDBOX_TASK_ID } from '@/lib/workspace-client';

export type MatchingHeartbeatView = MatchingHeartbeat & {
  authenticated?: boolean;
  fills?: Pick<
    MatchingFillNotice,
    'orderId' | 'taskId' | 'outcome' | 'ticket' | 'cancelledOrderIds' | 'atMs'
  >[];
  /** Server-recorded tape per quoteKey for this user's working/live tickets. */
  tape?: Record<string, Array<SimSpotQuote & { t: number }>>;
  probe?: MatchingHeartbeatProbe['probe'];
};

/**
 * Sandbox row the matcher must write fills into.
 * Curriculum: /test/tasks/01 → "01". Practice uses storageTaskId "practice"
 * (pass it explicitly). Workbench /workspace → "workspace", not "02".
 */
export function inferWorkbenchTaskId(
  pathname = typeof window === 'undefined' ? '' : window.location.pathname,
): string {
  const m = pathname.match(/\/tasks\/(\d+)/);
  return m?.[1] ?? WORKSPACE_SANDBOX_TASK_ID;
}

export async function startMatchingProcess(): Promise<MatchingHeartbeatView | null> {
  try {
    const res = await fetch('/api/matching-process/start', { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as MatchingHeartbeatView;
  } catch {
    return null;
  }
}

export async function fetchMatchingHeartbeat(
  probeMs = 0,
  // Currencies with a ticket open. The heartbeat is the 2s channel that
  // keeps the server recording them while the desk watches the chart.
  watchCcys: readonly string[] = [],
  taskId?: string,
): Promise<MatchingHeartbeatView | null> {
  try {
    const params = new URLSearchParams();
    if (probeMs > 0) params.set('probeMs', String(probeMs));
    if (watchCcys.length > 0) {
      params.set('watch', watchCcys.join(','));
      // Recording is attributed per owner+task, same as every other key.
      params.set('taskId', taskId ?? inferWorkbenchTaskId());
    }
    const q = params.toString() ? `?${params}` : '';
    const res = await fetch(`/api/matching-process/heartbeat${q}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as MatchingHeartbeatView;
  } catch {
    return null;
  }
}

export async function syncMatchingOrders(input: {
  tickets: readonly HedgeTicket[];
  spots?: Record<string, SimSpotQuote>;
  taskId?: string;
  /** Currencies with a ticket open — start recording their spot tape now. */
  watchCcys?: readonly string[];
}): Promise<MatchingHeartbeatView | null> {
  try {
    const res = await fetch('/api/matching-process/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickets: input.tickets,
        spots: input.spots ?? {},
        taskId: input.taskId ?? inferWorkbenchTaskId(),
        watchCcys: input.watchCcys ?? [],
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as MatchingHeartbeatView;
  } catch {
    return null;
  }
}

export async function fetchExecutionLogEvents(
  limit = 200,
): Promise<{ events: ExecutionLogEvent[]; degraded: boolean }> {
  try {
    const res = await fetch(`/api/execution-log?limit=${limit}`, {
      cache: 'no-store',
    });
    if (!res.ok) return { events: [], degraded: true };
    const body = (await res.json()) as {
      events?: ExecutionLogEvent[];
      degraded?: boolean;
    };
    return {
      events: Array.isArray(body.events) ? body.events : [],
      degraded: body.degraded === true,
    };
  } catch {
    return { events: [], degraded: true };
  }
}

export type ExecutionJournal = {
  events: ExecutionLogEvent[];
  tapeByCcy: Record<string, Array<SimSpotQuote & { t: number }>>;
  notifications?: {
    tickets: HedgeTicket[];
    cancelled: HedgeTicket[];
    readIds: string[];
    /** Ticket id → arrival epoch (ms). Older journals stored a formatted
     * HH:MM string here; readers must tolerate that legacy shape. */
    arrivedAt: Record<string, number | string>;
    /** Epoch of the bell's "Clear all": notices whose last event is at or
     * before it stay hidden. Absent on journals saved before it existed. */
    clearedAtMs?: number;
  };
  /**
   * Set when this journal is the browser's local copy served because the
   * server could not be read. It may seed the chart, but it is not a load
   * that succeeded, so nothing may be saved on the strength of it.
   */
  localFallback?: true;
  /** Which browser-owned parts the server already holds (GET only). */
  parts?: { desk: boolean; notifications: boolean };
};

/**
 * Where `next dev` used to keep the journal, before it went to the server
 * (MinIO locally, S3 in the cluster) like every other build. Read only to
 * import it once; never written.
 */
const LEGACY_LOCAL_JOURNAL_PREFIX = 'treasury:execution-journal:';

function journalTaskId(taskId?: string): string {
  const trimmed = taskId?.trim();
  return trimmed || inferWorkbenchTaskId();
}

let journalLoadWarned = false;

/** Waits before each retry of a failed load — a blip at page load recovers. */
const JOURNAL_LOAD_RETRY_MS = [1_000, 4_000, 15_000];

/**
 * A load that failed answers null, never an empty journal: the desk and the
 * bell only start saving after a successful load, so a failed one cannot
 * overwrite the stored history with whatever is on screen. A signed-out
 * caller (401) is not retried.
 */
async function getServerJournal(taskId: string): Promise<ExecutionJournal | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`/api/execution-journal?taskId=${encodeURIComponent(taskId)}`, {
        cache: 'no-store',
      });
      if (res.ok) return await res.json() as ExecutionJournal;
      if (res.status === 401) return null;
    } catch {
      // Unreachable server: retried, then reported once, below.
    }
    const waitMs = JOURNAL_LOAD_RETRY_MS[attempt];
    if (waitMs === undefined) break;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  if (!journalLoadWarned) {
    journalLoadWarned = true;
    console.warn(
      '[execution-journal] could not load the journal, so it is not being saved '
      + 'this session. Locally, check `npm run stack:status` (MinIO must be up).',
    );
  }
  return null;
}

function readLegacyLocalJournal(taskId: string): Partial<ExecutionJournal> | null {
  try {
    const raw = window.localStorage.getItem(`${LEGACY_LOCAL_JOURNAL_PREFIX}${taskId}`);
    return raw ? JSON.parse(raw) as Partial<ExecutionJournal> : null;
  } catch {
    return null;
  }
}

/**
 * Shape a legacy localStorage journal into what the desk hydrates from. Used
 * when MinIO/S3 cannot serve the journal so a perfectly good local tape is
 * not thrown away (chart opened empty while `treasury:execution-journal:*`
 * still held tens of thousands of points).
 */
function legacyJournalFallback(
  local: Partial<ExecutionJournal>,
): ExecutionJournal | null {
  if (!(local.events || local.tapeByCcy || local.notifications)) return null;
  return {
    events: Array.isArray(local.events) ? local.events : [],
    tapeByCcy:
      local.tapeByCcy && typeof local.tapeByCcy === 'object'
        ? local.tapeByCcy
        : {},
    notifications: local.notifications,
    // Server has neither part yet from this browser's point of view — keep
    // the local key so a later successful GET can still import it.
    parts: { desk: false, notifications: false },
    localFallback: true,
  };
}

type LegacyImport = 'none' | 'imported' | 'failed';

/**
 * Move a journal `next dev` left in this browser onto the server, into only
 * the parts the server does not have yet, then drop the local copy. The local
 * copy is kept if the upload fails.
 */
async function importLegacyLocalJournal(
  taskId: string,
  server: ExecutionJournal,
): Promise<LegacyImport> {
  const local = readLegacyLocalJournal(taskId);
  if (!local) return 'none';
  const upload: Partial<ExecutionJournal> = {};
  if (!server.parts?.desk && (local.events || local.tapeByCcy)) {
    upload.events = local.events ?? [];
    upload.tapeByCcy = local.tapeByCcy ?? {};
  }
  if (!server.parts?.notifications && local.notifications) {
    upload.notifications = local.notifications;
  }
  const hasUpload = Object.keys(upload).length > 0;
  if (hasUpload && !(await saveExecutionJournal(upload, taskId))) {
    console.warn(
      '[execution-journal] could not upload the journal an older `next dev` left in '
      + 'this browser; it is kept, and the upload is retried on the next load.',
    );
    return 'failed';
  }
  try {
    window.localStorage.removeItem(`${LEGACY_LOCAL_JOURNAL_PREFIX}${taskId}`);
  } catch {
    // Storage blocked: the import is done; the stale copy is harmless.
  }
  return hasUpload ? 'imported' : 'none';
}

async function loadAndImportJournal(taskId: string): Promise<ExecutionJournal | null> {
  const journal = await getServerJournal(taskId);
  if (!journal) {
    // Docker/MinIO down, S3 blip, etc.: still seed the chart from the local
    // copy. Leaving it in place lets a later load retry the import.
    return legacyJournalFallback(readLegacyLocalJournal(taskId) ?? {});
  }
  const imported = await importLegacyLocalJournal(taskId, journal);
  // A failed import fails the load: were the desk to start saving now, its
  // first save would create the part the import still has to fill, and the
  // next load would then skip it and drop the local copy.
  if (imported === 'failed') return null;
  return imported === 'imported' ? getServerJournal(taskId) : journal;
}

/**
 * The desk and the bell both load on mount. While a legacy copy is still in
 * this browser they share ONE load — GET, import, re-fetch — so neither can
 * read the server before the import and answer a journal without it.
 */
const legacyLoads = new Map<string, Promise<ExecutionJournal | null>>();

export async function fetchExecutionJournal(
  taskId?: string,
): Promise<ExecutionJournal | null> {
  const id = journalTaskId(taskId);
  if (!readLegacyLocalJournal(id)) return getServerJournal(id);
  let pending = legacyLoads.get(id);
  if (!pending) {
    pending = loadAndImportJournal(id);
    legacyLoads.set(id, pending);
    void pending.finally(() => legacyLoads.delete(id));
  }
  return pending;
}

let journalSaveWarned = false;

export async function saveExecutionJournal(
  journal: Partial<ExecutionJournal>,
  taskId?: string,
): Promise<boolean> {
  const id = journalTaskId(taskId);
  let saved = false;
  try {
    const res = await fetch('/api/execution-journal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...journal, taskId: id }),
    });
    saved = res.ok;
  } catch {
    // Unreachable server: reported once, below.
  }
  // The desk and the bell save fire-and-forget, so this is the one place a
  // failed save can be seen at all.
  if (!saved && !journalSaveWarned) {
    journalSaveWarned = true;
    console.warn('[execution-journal] a journal save failed; later saves may be lost too.');
  }
  return saved;
}

export function matchingServerIsLive(
  hb: MatchingHeartbeatView | null | undefined,
): boolean {
  return Boolean(hb?.processAlive && hb.verdict === 'live');
}
