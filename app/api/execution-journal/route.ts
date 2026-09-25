import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getS3ObjectText, putS3Object, s3OwnerSegment } from '@/lib/s3';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';
import {
  dedupeMonitorEvents,
  type ExecutionLogEvent,
} from '@/lib/test-mode/execution-monitor';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';

export const runtime = 'nodejs';

const MAX_EVENTS = 500;
const MAX_TAPE_POINTS = 6 * 3600;
/**
 * A 6h, 1-second tape is ~2M characters, and a desk keeps one per currency it
 * watched plus forward-leg keys. 64M characters is ~30 of those — room for a
 * full day on a busy desk — while still bounding what one caller can store.
 */
const MAX_BODY_CHARS = 64 * 1024 * 1024;

type TapePoint = SimSpotQuote & { t: number };
type TapeByKey = Record<string, TapePoint[]>;

/**
 * One journal, three S3 objects — each with exactly ONE writer, so no write
 * can erase another's history with a read-modify-write of a shared object:
 *
 * - `matcher`       `{task}.json`               the Node matcher (events + tape)
 * - `desk`          `{task}.desk.json`          this route, from the desk feed
 * - `notifications` `{task}.notifications.json` this route, from the bell
 *
 * `{task}.json` is the object every journal used to live in, so it can still
 * hold a browser-written `notifications` field from before the split; GET
 * falls back to it until the bell saves its own object.
 */
type JournalPart = 'matcher' | 'desk' | 'notifications';

function keyFor(email: string, taskId: string, part: JournalPart): string {
  const suffix = part === 'matcher' ? '' : `.${part}`;
  return `execution-journal/${s3OwnerSegment(email)}/${taskId}${suffix}.json`;
}

function taskIdOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value)
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventsOf(value: unknown): ExecutionLogEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is ExecutionLogEvent =>
      isRecord(e)
      && (e.kind === 'beat' || e.kind === 'order')
      && typeof e.atMs === 'number'
      && typeof e.summary === 'string',
  );
}

function tapeOf(value: unknown): TapeByKey {
  if (!isRecord(value)) return {};
  const out: TapeByKey = {};
  for (const [key, points] of Object.entries(value)) {
    if (!Array.isArray(points)) continue;
    out[key] = points.filter(
      (p): p is TapePoint =>
        isRecord(p)
        && typeof p.t === 'number'
        && typeof p.mid === 'number'
        && p.mid > 0,
    );
  }
  return out;
}

/**
 * Tape keys are `CCY|spot` or `CCY|forward|…` — the instrument is lower-case.
 * The PUT before the split upper-cased every key; nothing reads `EUR|SPOT`.
 */
const TAPE_KEY_PATTERN = /^[A-Z]{3}\|[a-z]/;

/**
 * Per key, the matcher's recorded series if it has one, else the desk's.
 * Never a union: while the browser thinks the matcher is down it walks its
 * own series under the same key, and interleaving two walks would draw a
 * tape the fills were never decided against (decisions.md, 2026-09-07).
 */
function mergeTape(matcher: TapeByKey, desk: TapeByKey): TapeByKey {
  const merged: TapeByKey = {};
  for (const key of new Set([...Object.keys(desk), ...Object.keys(matcher)])) {
    if (!TAPE_KEY_PATTERN.test(key)) continue;
    const own = matcher[key]?.length ? matcher[key] : desk[key];
    if (own?.length) merged[key] = own.slice(-MAX_TAPE_POINTS);
  }
  return merged;
}

/** A missing object is an empty part; any other failure is a real error. */
async function readPart(key: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await getS3ObjectText(key));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function writePart(
  key: string,
  taskId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await putS3Object({
    relativeKey: key,
    body: JSON.stringify(body),
    contentType: 'application/json',
    metadata: { task: taskId },
  });
}

/** The journal belongs to a real signed-in desk; the shared guest has none. */
async function userEmail(): Promise<string | null> {
  const email = (await auth())?.user?.email?.trim() ?? '';
  return email && email !== TEST_GUEST_EMAIL ? email : null;
}

export async function GET(request: NextRequest) {
  const email = await userEmail();
  if (!email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const taskId = taskIdOf(request.nextUrl.searchParams.get('taskId'));
  if (!taskId) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
  try {
    const [matcher, desk, notifications] = await Promise.all([
      readPart(keyFor(email, taskId, 'matcher')),
      readPart(keyFor(email, taskId, 'desk')),
      readPart(keyFor(email, taskId, 'notifications')),
    ]);
    const events = dedupeMonitorEvents(
      [...eventsOf(desk?.events), ...eventsOf(matcher?.events)]
        .sort((a, b) => b.atMs - a.atMs),
    ).slice(0, MAX_EVENTS);
    return NextResponse.json(
      {
        events,
        tapeByCcy: mergeTape(tapeOf(matcher?.tapeByCcy), tapeOf(desk?.tapeByCcy)),
        notifications: notifications?.notifications ?? matcher?.notifications,
        // Which browser-owned parts exist — the client imports a legacy
        // local journal only into a part the server does not have yet.
        parts: { desk: desk !== null, notifications: notifications !== null },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('[api/execution-journal] GET failed', error);
    return NextResponse.json({ error: 'Failed to load execution journal' }, { status: 500 });
  }
}

/**
 * Body: `{ taskId, events?, tapeByCcy?, notifications? }`. `events` /
 * `tapeByCcy` save the desk part, `notifications` the bell part; a body may
 * carry both. Neither part is ever written into the matcher's object.
 */
export async function PUT(request: NextRequest) {
  const email = await userEmail();
  if (!email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) {
      return NextResponse.json({ error: 'Journal too large' }, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isRecord(body)) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const taskId = taskIdOf(body.taskId);
  if (!taskId) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });

  const hasDesk = 'events' in body || 'tapeByCcy' in body;
  const hasNotifications = 'notifications' in body;
  if (!hasDesk && !hasNotifications) {
    return NextResponse.json({ error: 'Nothing to save' }, { status: 400 });
  }
  if (
    ('events' in body && !Array.isArray(body.events))
    || ('tapeByCcy' in body && !isRecord(body.tapeByCcy))
    || (hasNotifications && !isRecord(body.notifications))
  ) {
    return NextResponse.json({ error: 'Invalid journal shape' }, { status: 400 });
  }

  try {
    if (hasDesk) {
      const key = keyFor(email, taskId, 'desk');
      // The desk feed is this part's only writer, so keeping the half a
      // body omits cannot race another writer.
      const prior = 'events' in body && 'tapeByCcy' in body ? null : await readPart(key);
      const events = eventsOf('events' in body ? body.events : prior?.events)
        .slice(0, MAX_EVENTS);
      // Keys are tape quote keys (`EUR|spot`, `EUR|forward|t0.08`) and are
      // stored exactly as sent: upper-casing them made a reloaded chart look
      // up `EUR|spot` and find only `EUR|SPOT`.
      const tapeByCcy = Object.fromEntries(
        Object.entries(tapeOf('tapeByCcy' in body ? body.tapeByCcy : prior?.tapeByCcy))
          .map(([key, tape]) => [key, tape.slice(-MAX_TAPE_POINTS)]),
      );
      await writePart(key, taskId, { events, tapeByCcy });
    }
    if (hasNotifications) {
      await writePart(keyFor(email, taskId, 'notifications'), taskId, {
        notifications: body.notifications,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[api/execution-journal] PUT failed', error);
    return NextResponse.json({ error: 'Failed to save execution journal' }, { status: 500 });
  }
}
