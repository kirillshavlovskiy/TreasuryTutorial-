'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { usdMarketPair } from '@/lib/fx-market-rates';
import {
  hedgeTicketExecutionState,
  isLiveHedgeTicket,
  type HedgeTicket,
  type HedgeTicketExecutionState,
} from '@/lib/test-mode/hedge-var';
import {
  fetchExecutionJournal,
  saveExecutionJournal,
  type ExecutionJournal,
} from '@/lib/test-mode/matching-process-client';

type Kind = 'fill' | 'break' | 'option' | 'partial' | 'working' | 'cancelled';
type FilterId = 'all' | 'fills' | 'working' | 'partial' | 'breaks';

/**
 * Execution state of a single leg. There is deliberately no PART FILL here:
 * a HedgeTicket carries one notional with no filled-so-far quantity, so a
 * leg is all-or-nothing. Partial is a property of a multi-leg strip, not of
 * a leg — see kindOfGroup.
 */
type LegState = HedgeTicketExecutionState;

type LegRow = {
  ticket: HedgeTicket;
  tenor: string;
  state: LegState;
  sizeM: number;
  px: number | null;
};

/** One notification: a whole strip, or a single standalone ticket. */
type Notice = {
  id: string;
  kind: Kind;
  primary: HedgeTicket;
  legs: LegRow[];
  ticketIds: string[];
};

type TimedNotice = Notice & { lastFilledAtMs: number };

const EM = '#6ee7b7';
const SK = '#7dd3fc';
const RO = '#fda4af';
const AM = '#fcd34d';
const VI = '#c4b5fd';
const SLATE_50 = '#f8fafc';
const SLATE_400 = '#94a3b8';
const SLATE_500 = '#64748b';
const SLATE_600 = '#475569';

const BELL_SIZE = 40;
const BELL_MARGIN = 12;
/** Leave room for the header avatar / Next overlay in the far top-right. */
const BELL_DEFAULT_TOP = 108;
const BELL_DEFAULT_RIGHT = 88;
const BELL_POS_KEY = 'org-booked-trades-push-pos';
const DRAG_THRESHOLD_PX = 5;

type BellPos = { left: number; top: number };

function defaultBellPos(): BellPos {
  if (typeof window === 'undefined') {
    return { left: 16, top: BELL_DEFAULT_TOP };
  }
  return {
    left: Math.max(BELL_MARGIN, window.innerWidth - BELL_SIZE - BELL_DEFAULT_RIGHT),
    top: BELL_DEFAULT_TOP,
  };
}

function clampBellPos(p: BellPos): BellPos {
  if (typeof window === 'undefined') return p;
  const maxL = Math.max(BELL_MARGIN, window.innerWidth - BELL_SIZE - BELL_MARGIN);
  const maxT = Math.max(BELL_MARGIN, window.innerHeight - BELL_SIZE - BELL_MARGIN);
  return {
    left: Math.min(Math.max(BELL_MARGIN, p.left), maxL),
    top: Math.min(Math.max(BELL_MARGIN, p.top), maxT),
  };
}

function readStoredBellPos(): BellPos | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BELL_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<BellPos>;
    if (typeof p.left !== 'number' || typeof p.top !== 'number') return null;
    if (!Number.isFinite(p.left) || !Number.isFinite(p.top)) return null;
    return clampBellPos({ left: p.left, top: p.top });
  } catch {
    return null;
  }
}

function writeStoredBellPos(p: BellPos) {
  try {
    window.localStorage.setItem(BELL_POS_KEY, JSON.stringify(p));
  } catch {
    /* quota / private mode */
  }
}

function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const FILTERS: { id: FilterId; label: string; kinds: Kind[] }[] = [
  { id: 'all', label: 'All', kinds: ['fill', 'break', 'option', 'partial', 'working', 'cancelled'] },
  { id: 'fills', label: 'Fills', kinds: ['fill'] },
  { id: 'working', label: 'Working', kinds: ['working', 'option'] },
  { id: 'partial', label: 'Partial', kinds: ['partial'] },
  { id: 'breaks', label: 'Breaks', kinds: ['break', 'cancelled'] },
];

const GLYPH_PATHS: Record<Kind, string[]> = {
  fill: ['M20 6.5 9.6 17 4 11.6'],
  break: ['M12 4.2 20.6 19H3.4z', 'M12 9.6v4.2', 'M12 16.6h.01'],
  option: ['M14.828 14.828 21 21', 'M21 16v5h-5', 'm21 3-9 9-4-4-6 6', 'M21 8V3h-5'],
  partial: ['M12 3.4a8.6 8.6 0 1 1-8.6 8.6', 'M12 7.4V12l3.2 2'],
  working: ['M4 20h16', 'M6.6 20v-4', 'M11 20v-6.6', 'M15.4 20v-9.2', 'M19.8 20v-11.8'],
  cancelled: [
    'M12 20.4a8.4 8.4 0 1 0 0-16.8 8.4 8.4 0 0 0 0 16.8z',
    'M9.2 9.2l5.6 5.6',
    'M14.8 9.2l-5.6 5.6',
  ],
};

const KIND_STYLE: Record<Kind, { label: string; hue: string; ring: boolean }> = {
  fill: { label: 'FILL', hue: EM, ring: true },
  break: { label: 'BREAK', hue: RO, ring: true },
  option: { label: 'OPTION', hue: VI, ring: true },
  partial: { label: 'PARTIAL FILL', hue: AM, ring: false },
  working: { label: 'WORKING', hue: AM, ring: false },
  cancelled: { label: 'CANCELLED', hue: RO, ring: false },
};

const VERB: Record<Kind, string> = {
  fill: 'filled',
  option: 'booked',
  break: 'quote failed',
  partial: 'partial fill',
  working: 'scheduled',
  cancelled: 'cancelled',
};

const LEG_STATE_HUE: Record<LegState, string> = {
  FILLED: EM,
  WORKING: AM,
  HELD: SK,
  REJECTED: RO,
  CANCELLED: RO,
  EXPIRED: SLATE_400,
};

/** States that never carry an executed price — the leg row greys its tenor. */
const PENDING_STATES: readonly LegState[] = [
  'WORKING',
  'HELD',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
];

const LEG_GRID = '40px 1fr 64px 62px';

/** Push banners on screen at once, and how long each stays. */
const TOAST_MAX = 3;
const TOAST_MS = 7_000;
/** Length of a banner's exit animation (ncToastOut) before it is removed. */
const TOAST_EXIT_MS = 420;

type Toast = {
  key: string;
  noticeId: string;
  kind: Kind;
  glyph: Kind;
  title: string;
  body: string;
  time: string;
  /** Playing its exit animation; dropped once that has finished. */
  leaving?: boolean;
};

/**
 * Banners after `fresh` arrive: newest first, and a key raised again replaces
 * its old banner. Any banner showing past TOAST_MAX plays its exit instead of
 * vanishing mid-stack; banners already leaving do not count toward the limit.
 */
export function withToastsAdded(cur: readonly Toast[], fresh: readonly Toast[]): Toast[] {
  const freshKeys = new Set(fresh.map(t => t.key));
  let shown = 0;
  return [...fresh, ...cur.filter(t => !freshKeys.has(t.key))].map(t => {
    if (t.leaving) return t;
    shown += 1;
    return shown > TOAST_MAX ? { ...t, leaving: true } : t;
  });
}

/**
 * macOS puts the close affordance on the banner's top-LEFT; Windows toasts
 * put it top-right. Read after mount only — `navigator` is not available
 * during SSR and a guess would hydrate wrong.
 */
function closeOnLeft(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

const LEG_COLUMNS: { label: string; align: 'left' | 'right' }[] = [
  { label: 'Leg', align: 'left' },
  { label: 'State', align: 'left' },
  { label: 'Size', align: 'right' },
  { label: 'Price', align: 'right' },
];

/**
 * Saved notifications older than this that no longer exist in the live book
 * are ghosts from a previous session and must not resurrect. Without this
 * cutoff a saved ticket lived forever: merge kept it, the debounced save
 * re-persisted the merged set, and even wiping the journal storage was
 * undone by the next save from in-memory state.
 */
const NOTIFICATION_REPLAY_MAX_AGE_MS = 12 * 3600_000;

/**
 * Saved notification history merged with the live book, by id.
 *
 * A saved working order that is no longer on the book is not working any
 * more — it filled under another id, was cancelled (that notice is its own
 * `:cancelled` copy) or was edited away — so it is dropped, not replayed as
 * WORKING.
 *
 * Deliberately no strip-slot collapse: one strip per currency is the BOOK's
 * rule, and the book already applies it (setBooked). Applied to history it
 * let an earlier strip's filled leg beat a freshly left order on the same
 * edge and folded the new strip's other legs into the old strip's notice,
 * so a newly left strip never showed up in the bell.
 */
export function mergeNotificationTickets(
  saved: NonNullable<ExecutionJournal['notifications']> | null,
  live: readonly HedgeTicket[],
): HedgeTicket[] {
  const liveIds = new Set(live.map(t => t.id));
  const cutoffMs = Date.now() - NOTIFICATION_REPLAY_MAX_AGE_MS;
  const byId = new Map<string, HedgeTicket>();
  for (const ticket of saved?.tickets ?? []) {
    if (!liveIds.has(ticket.id)) {
      if (ticket.status === 'scheduled') continue;
      const arrivedRaw = saved?.arrivedAt?.[ticket.id];
      const arrivedMs = typeof arrivedRaw === 'number' ? arrivedRaw : Number(arrivedRaw);
      const knownAgeMs = Math.max(
        ticket.filledAtMs ?? 0,
        Number.isFinite(arrivedMs) && arrivedMs > 0 ? arrivedMs : 0,
      );
      // Unknown age (0, incl. pre-migration HH:MM stamps) counts as ancient:
      // anything this component saved itself always has a real arrival epoch.
      if (knownAgeMs < cutoffMs) continue;
    }
    byId.set(ticket.id, ticket);
  }
  for (const ticket of live) byId.set(ticket.id, ticket);
  return [...byId.values()];
}

function legStateOf(t: HedgeTicket, nowMs: number): LegState {
  return hedgeTicketExecutionState(t, nowMs);
}

function kindOfGroup(legs: readonly LegRow[]): Kind {
  if (legs.some(l => l.state === 'REJECTED')) return 'break';
  if (legs.every(l => l.state === 'CANCELLED')) return 'cancelled';
  const filled = legs.filter(l => l.state === 'FILLED');
  if (filled.length === 0) return 'working';
  if (filled.length < legs.length) return 'partial';
  return filled.some(l => l.ticket.instrument === 'option') ? 'option' : 'fill';
}

/** Kind of a single freshly-arrived ticket, for deciding whether to ring. */
function ringKindOf(t: HedgeTicket): Kind {
  return kindOfGroup([
    {
      ticket: t,
      tenor: tenorOf(t),
      state: legStateOf(t, Date.now()),
      sizeM: Math.abs(t.amountLocalM),
      px: null,
    },
  ]);
}

function sumM(legs: readonly LegRow[], states: readonly LegState[]): number {
  return legs
    .filter(l => states.includes(l.state))
    .reduce((acc, l) => acc + l.sizeM, 0);
}

function preferredStripTicket(
  tickets: readonly HedgeTicket[],
  nowMs: number,
): HedgeTicket {
  const rank: Record<LegState, number> = {
    FILLED: 0,
    WORKING: 1,
    HELD: 2,
    REJECTED: 3,
    CANCELLED: 4,
    EXPIRED: 5,
  };
  return [...tickets].sort(
    (a, b) => rank[legStateOf(a, nowMs)] - rank[legStateOf(b, nowMs)],
  )[0]!;
}

/**
 * Strip legs share a stripId and are one execution to the desk, so they
 * collapse into a single notification whose leg table carries the per-leg
 * state. Everything else is its own one-leg notice.
 */
export function buildNotices(tickets: readonly HedgeTicket[], nowMs: number): TimedNotice[] {
  const groups = new Map<string, HedgeTicket[]>();
  const order: string[] = [];
  for (const t of tickets) {
    const key = t.stripId ? `strip:${t.stripId}` : `ticket:${t.id}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(t);
    } else {
      groups.set(key, [t]);
      order.push(key);
    }
  }

  const notices: TimedNotice[] = order.map(key => {
    const members = [...groups.get(key)!].sort(
      (a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0),
    );
    const isStrip = members.length > 1 || Boolean(members[0].stripId);
    const legTickets = isStrip
      ? [...members.reduce((byEdge, ticket) => {
          const edgeIndex = ticket.stripEdgeIndex ?? 0;
          const sameEdge = byEdge.get(edgeIndex) ?? [];
          sameEdge.push(ticket);
          byEdge.set(edgeIndex, sameEdge);
          return byEdge;
        }, new Map<number, HedgeTicket[]>())]
          .sort(([a], [b]) => a - b)
          .map(([_, tickets]) => preferredStripTicket(tickets, nowMs))
      : members;
    const legs: LegRow[] = legTickets.map((t, i) => {
      const state = legStateOf(t, nowMs);
      return {
        ticket: t,
        tenor: isStrip ? `M${(t.stripEdgeIndex ?? i) + 1}` : tenorOf(t),
        state,
        sizeM: Math.abs(t.amountLocalM),
        px: state === 'FILLED' ? t.ipaQuote?.fxOutright ?? null : null,
      };
    });
    return {
      id: key,
      kind: kindOfGroup(legs),
      // The leg that PRODUCED the group's verb, not an array position:
      // titleOf reads bracketRoleLabel(primary), and members[0] is merely
      // the lowest strip edge — a strip whose take-profit filled while its
      // edge-0 stop cancelled was pushed as "Stop Loss filled".
      // preferredStripTicket ranks FILLED > WORKING > … > EXPIRED, the same
      // precedence kindOfGroup derives the verb from.
      primary: preferredStripTicket(members, nowMs),
      legs,
      ticketIds: members.map(t => t.id),
      lastFilledAtMs: Math.max(
        ...members.map(t => t.filledAtMs ?? 0),
      ),
    };
  });
  return notices.sort((a, b) => b.lastFilledAtMs - a.lastFilledAtMs);
}

/**
 * Glyph for a notice. A working order is a clock; a working strip is the
 * ladder bars — same distinction the blotter status column draws.
 */
function glyphKindOf(n: Notice): Kind {
  if (n.kind === 'working') return n.legs.length > 1 ? 'working' : 'partial';
  return n.kind;
}

type NoticeAction = { label: string; hue?: string; onClick: () => void };

/**
 * Actions offered on an expanded notice. Only operations that exist on the
 * desk are listed — a re-quote is the working order reopened in the ticket,
 * which the blotter's Edit button also does, and is therefore unavailable
 * for a strip leg (booked from M0, not editable as a resting order).
 */
function actionsFor(
  n: Notice,
  handlers: {
    onOpenBlotter?: () => void;
    onEditOrder?: (t: HedgeTicket) => void;
    onCancelOrder?: (t: HedgeTicket) => void;
  },
): NoticeAction[] {
  const out: NoticeAction[] = [];
  const open = n.legs.filter(l => l.state === 'WORKING' || l.state === 'HELD');
  const editable = open.find(
    l => !l.ticket.stripId && l.ticket.limitRate != null,
  );
  if (editable && handlers.onEditOrder) {
    const fn = handlers.onEditOrder;
    const leg = editable.ticket;
    out.push({
      label: n.kind === 'partial' ? 'Re-quote balance' : 'Re-quote',
      hue: AM,
      onClick: () => fn(leg),
    });
  }
  if (open.length > 0 && handlers.onCancelOrder) {
    const fn = handlers.onCancelOrder;
    const leg = open[0]!.ticket;
    out.push({
      label: n.legs.length > 1 ? 'Cancel strip' : 'Cancel order',
      onClick: () => fn(leg),
    });
  }
  if (handlers.onOpenBlotter) {
    const fn = handlers.onOpenBlotter;
    out.push({ label: 'Open blotter', hue: SK, onClick: fn });
  }
  return out;
}

/**
 * Render an arrival epoch as a bare time for today, or `Mon D, HH:MM` once
 * it's a different calendar day — a bare clock face is ambiguous once the
 * list holds more than 24h of history, which it always does (nothing here
 * expires it).
 */
function fmtArrival(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * When a notice last changed — the one epoch it both sorts and displays by:
 * its newest ticket's arrival, or its newest fill, so a working order that
 * fills later surfaces again instead of staying where it was placed.
 * A ticket with no arrival stamp yet is arriving in this very render (the
 * stamping effect records it right after commit), so it counts as `nowMs`.
 * A restored legacy stamp is 0, not missing, and stays ancient.
 */
export function noticeEventMs(
  n: TimedNotice,
  arrivedAt: ReadonlyMap<string, number>,
  nowMs: number,
): number {
  let max = n.lastFilledAtMs;
  for (const id of n.ticketIds) {
    const ms = arrivedAt.get(id) ?? nowMs;
    if (ms > max) max = ms;
  }
  return max;
}

function pairSlash(pair: string): string {
  const p = pair.replace('/', '').toUpperCase();
  if (p.length < 6) return pair;
  return `${p.slice(0, 3)}/${p.slice(3, 6)}`;
}

function fmtPx(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 20) return v.toFixed(3);
  return v.toFixed(5);
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${Math.round(v).toLocaleString()}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}

function instTag(t: HedgeTicket): string {
  return t.instrument === 'spot' ? 'SP' : t.instrument === 'option' ? 'OPT' : 'FWD';
}

function tenorOf(t: HedgeTicket): string {
  const label = t.maturityLabel?.split('·')[0]?.trim();
  return label || t.maturity || (t.instrument === 'spot' ? 'T+2' : '—');
}

function bracketRoleLabel(t: HedgeTicket): string | null {
  return t.bracketRole === 'takeProfit'
    ? 'Take Profit'
    : t.bracketRole === 'stopLoss'
      ? 'Stop Loss'
      : null;
}

function titleOf(n: Notice): string {
  const t = n.primary;
  const kind = n.kind;
  const totalM = n.legs.reduce((acc, l) => acc + l.sizeM, 0).toFixed(2);
  if (n.legs.length > 1) {
    const filled = n.legs.filter(l => l.state === 'FILLED').length;
    if (kind === 'partial') {
      return `${t.ccy} strip partial · ${filled} of ${n.legs.length} legs`;
    }
    return `${t.ccy} strip ${VERB[kind]} · ${totalM}M`;
  }
  const role = bracketRoleLabel(t);
  const verb = role ? `${role} ${VERB[kind]}` : VERB[kind];
  return `${pairSlash(usdMarketPair(t.ccy))} ${instTag(t)} ${verb} · ${totalM}M`;
}

function bodyOf(n: Notice): string {
  const t = n.primary;
  const kind = n.kind;
  const entity = t.entityName || 'Group FX';

  if (kind === 'break') {
    const rejected = n.legs.filter(l => l.state === 'REJECTED');
    const note = rejected[0]?.ticket.ipaQuote?.errorMessage || 'Bank pulled the quote';
    if (n.legs.length > 1) {
      const held = n.legs.filter(l => l.state === 'FILLED').length;
      return `${note} — ${sumM(n.legs, ['REJECTED']).toFixed(2)}M unfilled, strip held at ${held}/${n.legs.length}`;
    }
    return note;
  }

  if (kind === 'partial') {
    const filledM = sumM(n.legs, ['FILLED']).toFixed(2);
    const openM = sumM(n.legs, ['WORKING', 'HELD']).toFixed(2);
    const filled = n.legs.filter(l => l.state === 'FILLED').length;
    return `${filled} of ${n.legs.length} legs filled · ${filledM}M done, ${openM}M working · ${entity}`;
  }

  if (kind === 'cancelled') {
    return `${sumM(n.legs, ['CANCELLED']).toFixed(2)}M cancelled before fill · ${entity}`;
  }

  const side = (t.orderSide ?? (t.amountLocalM >= 0 ? 'Sell' : 'Buy')).toUpperCase();
  const totalM = n.legs.reduce((acc, l) => acc + l.sizeM, 0).toFixed(2);

  if (kind === 'working') {
    // Working orders have no fxOutright yet — that's set on fill — so the
    // level to watch is limitRate, or there's nothing to monitor here.
    const level = `${fmtPx(t.limitRate)}${t.isSpotReferenced ? ' spot' : ''}`;
    return `${side} ${totalM}M waiting at ${level} · ${tenorOf(t)} · ${entity}`;
  }

  if (n.legs.length > 1) {
    const avg = avgFillPx(n.legs);
    return `${n.legs.length} legs · avg ${fmtPx(avg)} · ${tenorSpan(n.legs)} · ${entity}`;
  }
  const rate = fmtPx(t.ipaQuote?.fxOutright);
  const premium =
    t.ipaQuote?.premiumUsd != null ? ` · premium ${fmtUsd(t.ipaQuote.premiumUsd)}` : '';
  return `${side} ${Math.abs(t.amountLocalM).toFixed(2)}M @ ${rate} · ${tenorOf(t)}${premium} · ${entity}`;
}

function chipsOf(n: Notice): { label: string; hue: string }[] {
  const t = n.primary;
  const hue = KIND_STYLE[n.kind].hue;
  const filledM = sumM(n.legs, ['FILLED']);
  const openM = sumM(n.legs, ['WORKING', 'HELD']);
  const lostM = sumM(n.legs, ['REJECTED', 'CANCELLED', 'EXPIRED']);

  if (n.kind === 'break') {
    return [
      { label: 'BREAK', hue },
      { label: `${lostM.toFixed(2)}M UNFILLED`, hue: RO },
      { label: 're-quote', hue: SK },
    ];
  }
  if (n.kind === 'partial') {
    return [
      { label: 'PARTIAL FILL', hue },
      { label: `${filledM.toFixed(2)}M FILLED`, hue: EM },
      ...(openM > 0 ? [{ label: `${openM.toFixed(2)}M WORKING`, hue: AM }] : []),
      ...(lostM > 0 ? [{ label: `${lostM.toFixed(2)}M UNFILLED`, hue: RO }] : []),
    ];
  }
  if (n.kind === 'cancelled') {
    return [
      { label: 'CANCELLED', hue },
      ...(filledM > 0 ? [{ label: `${filledM.toFixed(2)}M STANDS`, hue: EM }] : []),
    ];
  }
  if (n.kind === 'option' && t.ipaQuote?.premiumUsd === 0) {
    return [{ label: 'OPTION', hue }, { label: '0 premium', hue: EM }];
  }
  const base = [{ label: n.legs.length > 1 ? 'STRIP' : KIND_STYLE[n.kind].label, hue }];
  if (n.kind === 'working' && n.legs.some(l => l.state === 'HELD')) {
    base.push({ label: 'NEEDS APPROVAL', hue: AM });
  }
  return base;
}

function avgFillPx(legs: readonly LegRow[]): number | null {
  const filled = legs.filter(l => l.px != null && l.sizeM > 0);
  if (filled.length === 0) return null;
  const notional = filled.reduce((acc, l) => acc + l.sizeM, 0);
  if (notional <= 0) return null;
  return filled.reduce((acc, l) => acc + l.px! * l.sizeM, 0) / notional;
}

function tenorSpan(legs: readonly LegRow[]): string {
  const first = legs[0]?.tenor ?? '—';
  const last = legs[legs.length - 1]?.tenor ?? '—';
  return first === last ? first : `${first}–${last}`;
}

function statsOf(n: Notice): { label: string; value: string; fg?: string }[] {
  const t = n.primary;
  const stats: { label: string; value: string; fg?: string }[] = [];
  const filledM = sumM(n.legs, ['FILLED']);
  const openM = sumM(n.legs, ['WORKING', 'HELD']);
  const lostM = sumM(n.legs, ['REJECTED', 'CANCELLED', 'EXPIRED']);
  const totalM = filledM + openM + lostM;

  // Execution ledger first — it is the question the panel exists to answer.
  stats.push({ label: 'Filled', value: `${filledM.toFixed(2)}M`, fg: filledM > 0 ? EM : SLATE_500 });
  if (openM > 0) stats.push({ label: 'Working', value: `${openM.toFixed(2)}M`, fg: AM });
  if (lostM > 0) stats.push({ label: 'Unfilled', value: `${lostM.toFixed(2)}M`, fg: RO });
  if (totalM > 0 && filledM > 0 && filledM < totalM) {
    stats.push({
      label: 'Fill rate',
      value: `${Math.round((filledM / totalM) * 100)}%`,
      fg: AM,
    });
  }

  if (n.legs.length > 1) {
    const avg = avgFillPx(n.legs);
    if (avg != null) stats.push({ label: 'Avg', value: fmtPx(avg) });
  } else if (t.status === 'scheduled' && t.limitRate != null) {
    stats.push({
      label: 'Limit',
      value: `${fmtPx(t.limitRate)}${t.isSpotReferenced ? ' spot' : ''}`,
    });
    stats.push({
      label: 'Role',
      value: bracketRoleLabel(t) ?? 'Leave order',
    });
  } else {
    stats.push({ label: 'Spot', value: fmtPx(t.ipaQuote?.fxSpot) });
    stats.push({ label: 'Outright', value: fmtPx(t.ipaQuote?.fxOutright) });
  }
  if (t.instrument === 'option') {
    stats.push({ label: 'Vol', value: fmtPct(t.ipaQuote?.impliedVolPercent ?? t.ipaQuote?.atmVolPercent) });
    stats.push({ label: 'Delta', value: fmtPct(t.ipaQuote?.deltaPercent) });
    stats.push({ label: 'Strike', value: t.ipaQuote?.strikeInput || fmtPx(t.ipaQuote?.strike) });
  }
  return stats;
}

function Glyph({ kind, color, size = 18 }: { kind: Kind; color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {GLYPH_PATHS[kind].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

function NotificationBell({
  ring,
  loop,
  color,
  count,
  badgeHue,
  ringKey,
}: {
  ring: boolean;
  loop: boolean;
  color: string;
  count: number;
  badgeHue: string;
  ringKey: number;
}) {
  const active = ring || loop;
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span style={{ display: 'flex' }}>
        <svg
          key={`bell-${ringKey}`}
          width={26}
          height={26}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ overflow: 'visible' }}
        >
          {active ? (
            <circle
              cx={12}
              cy={11}
              r={10}
              strokeWidth={1}
              style={{
                transformOrigin: '12px 11px',
                opacity: 0,
                animation: ring ? 'ncRippleOnce .9s ease-out 1' : 'ncRipple 2.8s ease-out infinite',
              }}
            />
          ) : null}
          <g
            style={{
              transformOrigin: '12px 4px',
              animation: ring
                ? 'ncRingOnce .9s cubic-bezier(.36,.07,.19,.97) 1'
                : loop
                  ? 'ncRing 2.8s cubic-bezier(.36,.07,.19,.97) infinite'
                  : 'none',
            }}
          >
            <path d="M6 8a6 6 0 0 1 12 0c0 5.4 1.5 7 1.5 7H4.5S6 13.4 6 8z" />
            <path
              style={{
                transformOrigin: '12px 17px',
                animation: ring
                  ? 'ncClapperOnce .9s cubic-bezier(.36,.07,.19,.97) 1'
                  : loop
                    ? 'ncClapper 2.8s cubic-bezier(.36,.07,.19,.97) infinite'
                    : 'none',
              }}
              d="M10.2 19a2 2 0 0 0 3.6 0"
            />
          </g>
        </svg>
      </span>
      {count > 0 ? (
        <span
          style={{
            position: 'absolute',
            top: '-6px',
            right: '-8px',
            minWidth: '17px',
            height: '17px',
            padding: '0 5px',
            borderRadius: '9px',
            background: badgeHue,
            color: '#0b1220',
            font: '700 10px/17px ui-monospace,Menlo,monospace',
            textAlign: 'center',
          }}
        >
          {count}
        </span>
      ) : null}
    </span>
  );
}

function Row({
  kind,
  glyph,
  title,
  body,
  time,
  unread,
  open,
  chips,
  stats,
  legs,
  errorMessage,
  actions,
  onToggle,
}: {
  kind: Kind;
  glyph: Kind;
  title: string;
  body: string;
  time: string;
  unread: boolean;
  open: boolean;
  chips: { label: string; hue: string }[];
  stats: { label: string; value: string; fg?: string }[];
  legs: LegRow[];
  errorMessage?: string;
  actions: NoticeAction[];
  onToggle: () => void;
}) {
  const hue = KIND_STYLE[kind].hue;
  const legCount = legs.length;
  return (
    <div
      style={{
        borderBottom: '1px solid #111c30',
        background: open ? tint(hue, 0.08) : unread ? tint(hue, 0.05) : 'transparent',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{ display: 'flex', gap: 12, padding: '13px 16px', cursor: 'pointer' }}
      >
        <span style={{ flex: 'none', marginTop: 2, color: hue, display: 'flex' }}>
          <Glyph kind={glyph} color={hue} size={18} />
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span
              style={{
                font: '600 12px/1.3 system-ui',
                color: unread ? SLATE_50 : SLATE_400,
              }}
            >
              {title}
            </span>
            <span
              style={{
                marginLeft: 'auto',
                flex: 'none',
                font: '400 10px/1.3 ui-monospace,Menlo,monospace',
                color: SLATE_500,
              }}
            >
              {time}
            </span>
          </span>
          <span
            style={{
              display: 'block',
              marginTop: 4,
              font: '400 10px/1.55 ui-monospace,Menlo,monospace',
              color: SLATE_400,
            }}
          >
            {body}
          </span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
            {chips.map((c, i) => (
              <span
                key={i}
                style={{
                  padding: '3px 8px',
                  borderRadius: 5,
                  border: `1px solid ${tint(c.hue, 0.4)}`,
                  color: c.hue,
                  font: '400 10px/1.4 ui-monospace,Menlo,monospace',
                }}
              >
                {c.label}
              </span>
            ))}
            <span
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                font: '600 10px/1.3 ui-monospace,Menlo,monospace',
                color: open ? hue : SLATE_500,
              }}
            >
              {open ? 'Hide execution' : `${legCount} ${legCount === 1 ? 'leg' : 'legs'}`}
              {open ? ' ▴' : ' ▾'}
            </span>
          </span>
        </span>
        <span
          style={{
            flex: 'none',
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: unread ? hue : 'transparent',
            marginTop: 6,
          }}
        />
      </div>

      {open ? (
        <div style={{ padding: '0 16px 14px 46px' }}>
          <div
            style={{
              border: `1px solid ${tint(hue, 0.28)}`,
              borderRadius: 9,
              background: 'rgba(2,6,23,.6)',
              overflow: 'hidden',
            }}
          >
            {errorMessage ? (
              <div
                style={{
                  padding: '7px 10px',
                  borderBottom: '1px solid #111c30',
                  font: '600 10px/1.4 ui-monospace,Menlo,monospace',
                  color: RO,
                }}
              >
                {errorMessage}
              </div>
            ) : null}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: LEG_GRID,
                gap: 9,
                padding: '7px 10px',
                borderBottom: '1px solid #111c30',
                background: 'rgba(148,163,184,.05)',
              }}
            >
              {LEG_COLUMNS.map(c => (
                <span
                  key={c.label}
                  style={{
                    font: '600 9px/1.2 ui-monospace,Menlo,monospace',
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: SLATE_500,
                    textAlign: c.align,
                  }}
                >
                  {c.label}
                </span>
              ))}
            </div>
            {legs.map(l => (
              <div
                key={l.ticket.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: LEG_GRID,
                  gap: 9,
                  padding: '6px 10px',
                  borderBottom: '1px solid #111c30',
                }}
              >
                <span
                  style={{
                    font: '600 11px/1.3 ui-monospace,Menlo,monospace',
                    color: PENDING_STATES.includes(l.state) ? SLATE_400 : '#e2e8f0',
                  }}
                >
                  {l.tenor}
                </span>
                <span
                  style={{
                    minWidth: 0,
                    font: '400 10px/1.3 ui-monospace,Menlo,monospace',
                    color: LEG_STATE_HUE[l.state],
                    letterSpacing: '.04em',
                  }}
                >
                  {l.state}
                </span>
                <span
                  style={{
                    font: '400 10px/1.3 ui-monospace,Menlo,monospace',
                    color: SLATE_400,
                    textAlign: 'right',
                  }}
                >
                  {`${l.sizeM.toFixed(2)}M`}
                </span>
                <span
                  style={{
                    font: '600 10px/1.3 ui-monospace,Menlo,monospace',
                    color: l.px == null ? SLATE_600 : '#e2e8f0',
                    textAlign: 'right',
                  }}
                >
                  {fmtPx(l.px)}
                </span>
              </div>
            ))}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                padding: '8px 10px',
                background: 'rgba(148,163,184,.05)',
              }}
            >
              {stats.map((s, i) => (
                <span
                  key={i}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'baseline',
                    gap: 6,
                    font: '400 10px/1.3 ui-monospace,Menlo,monospace',
                    color: SLATE_500,
                  }}
                >
                  {s.label}
                  <span style={{ fontWeight: 600, color: s.fg || '#e2e8f0' }}>{s.value}</span>
                </span>
              ))}
            </div>
          </div>
          {actions.length > 0 ? (
            <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
              {actions.map(a => (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onClick}
                  style={{
                    padding: '6px 11px',
                    border: `1px solid ${a.hue ? tint(a.hue, 0.45) : SLATE_600}`,
                    borderRadius: 7,
                    background: a.hue ? tint(a.hue, 0.12) : 'transparent',
                    color: a.hue ?? '#cbd5e1',
                    font: '600 10px/1.3 ui-monospace,Menlo,monospace',
                    cursor: 'pointer',
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function OrgBookedTradesPush({
  tickets,
  cancelled = [],
  sandboxTaskId,
  onOpenBlotter,
  onEditOrder,
  onCancelOrder,
}: {
  tickets: readonly HedgeTicket[];
  /** Cancellations, already removed from `tickets` — see requestCancellation. */
  cancelled?: readonly HedgeTicket[];
  /** Same sandbox row the decision layer journals into. */
  sandboxTaskId?: string;
  onOpenBlotter?: () => void;
  onEditOrder?: (ticket: HedgeTicket) => void;
  onCancelOrder?: (ticket: HedgeTicket) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const closeLeft = mounted && closeOnLeft();

  const [pos, setPos] = useState<BellPos>(defaultBellPos);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
    moved: boolean;
  } | null>(null);
  const skipClickRef = useRef(false);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    if (!mounted) return;
    setPos(readStoredBellPos() ?? defaultBellPos());
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    const onResize = () => setPos(p => clampBellPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mounted]);

  const [panelOpen, setPanelOpen] = useState(false);
  const bellWrapRef = useRef<HTMLDivElement | null>(null);

  // Capture phase so a pointerdown that also lands on an interactive element
  // elsewhere still closes the panel.
  useEffect(() => {
    if (!panelOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = bellWrapRef.current;
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      setPanelOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [panelOpen]);
  const [filter, setFilter] = useState<FilterId>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [ringSeq, setRingSeq] = useState(0);
  const [ringing, setRinging] = useState(false);
  const [ringHue, setRingHue] = useState(EM);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [savedNotifications, setSavedNotifications] = useState<
    NonNullable<ExecutionJournal['notifications']> | null
  >(null);
  const [notificationsReady, setNotificationsReady] = useState(false);
  /** "Clear all" epoch — see ExecutionJournal['notifications'].clearedAtMs. */
  const [clearedAtMs, setClearedAtMs] = useState(0);

  const seenIdsRef = useRef<Set<string> | null>(null);
  /** Ticket id → arrival epoch (ms). Drives both the displayed time and the
   * notice sort order, so the two can never disagree with each other. */
  const arrivedAtRef = useRef<Map<string, number>>(new Map());
  const notificationTickets = useMemo(
    () => mergeNotificationTickets(savedNotifications, tickets),
    [savedNotifications, tickets],
  );
  const notificationCancelled = useMemo(() => {
    const byId = new Map<string, HedgeTicket>();
    for (const ticket of savedNotifications?.cancelled ?? []) byId.set(ticket.id, ticket);
    for (const ticket of cancelled) byId.set(ticket.id, ticket);
    return [...byId.values()];
  }, [savedNotifications, cancelled]);

  useEffect(() => {
    let cancelledLoad = false;
    setNotificationsReady(false);
    void fetchExecutionJournal(sandboxTaskId).then(journal => {
      if (cancelledLoad) return;
      const restored = journal?.notifications;
      if (restored) {
        setSavedNotifications(restored);
        setReadIds(new Set(restored.readIds));
        setClearedAtMs(restored.clearedAtMs ?? 0);
        // Pre-migration journals stored a formatted HH:MM string here; those
        // don't parse to a usable epoch, so they fall back to 0 (displays as
        // "—", sorts last) rather than throwing or masquerading as recent.
        arrivedAtRef.current = new Map(
          Object.entries(restored.arrivedAt).map(([id, v]) => {
            const ms = typeof v === 'number' ? v : Number(v);
            return [id, Number.isFinite(ms) && ms > 0 ? ms : 0] as const;
          }),
        );
      }
      // Save only after a load that succeeded (see fetchExecutionJournal):
      // saving after a failed one would replace the stored bell history. A
      // `localFallback` journal is the browser's copy served when the server
      // could not be read — shown, never saved over the server's.
      if (journal && !journal.localFallback) setNotificationsReady(true);
    });
    return () => {
      cancelledLoad = true;
    };
  }, [sandboxTaskId]);

  const live = useMemo(
    () => notificationTickets.filter(isLiveHedgeTicket),
    [notificationTickets],
  );

  // Ring the bell for newly-arrived live tickets of a kind that rings
  // (fill/break/option). The first run only seeds the ring tracker, so an
  // existing book doesn't fire a storm of bell animations — but it must NOT
  // mark those tickets read. Read state comes solely from the persisted
  // journal (or "unread" for a ticket the journal never saw); stamping every
  // live ticket read on mount silently erased any FILL/WORKING that arrived
  // while this panel was unmounted (frequent in dev, where HMR remounts it),
  // which is exactly why only manually-clicked cancellations — written
  // straight into state while mounted — were ever visible. Arrival times are
  // stamped by the next effect, for every kind.
  useEffect(() => {
    const nowIds = new Set(live.map(t => t.id));
    const prevSeen = seenIdsRef.current;

    if (prevSeen == null) {
      seenIdsRef.current = nowIds;
      return;
    }

    const fresh = live.filter(t => !prevSeen.has(t.id));
    seenIdsRef.current = nowIds;
    if (fresh.length === 0) return;

    const ringer = fresh.find(t => KIND_STYLE[ringKindOf(t)].ring);
    if (ringer) {
      setRingHue(KIND_STYLE[ringKindOf(ringer)].hue);
      setRingSeq(s => s + 1);
    }
  }, [live]);

  useEffect(() => {
    if (ringSeq === 0) return;
    setRinging(true);
    const timer = setTimeout(() => setRinging(false), 900);
    return () => clearTimeout(timer);
  }, [ringSeq]);

  // Stamp every ticket the list is built from the first time it is seen —
  // working orders and cancellations included. Only `live` tickets used to
  // be stamped, so a strip left as working orders had no arrival at all: it
  // sorted below everything at 0 and displayed "—". A stamp is never
  // overwritten (a restored one is the real arrival); a later fill moves the
  // notice through filledAtMs instead — see noticeEventMs. Declared before
  // the toast effect, which reads these stamps in the same commit.
  useEffect(() => {
    const arrivedAtMs = Date.now();
    for (const t of [...notificationCancelled, ...notificationTickets]) {
      if (!arrivedAtRef.current.has(t.id)) arrivedAtRef.current.set(t.id, arrivedAtMs);
    }
  }, [notificationCancelled, notificationTickets]);

  // The list includes resting orders too — ringing above is live-only on
  // purpose (KIND_STYLE.working.ring is false), but the "Working" filter
  // needs something to show. buildNotices' own order is by fill time only;
  // re-sort by noticeEventMs, the same epoch each row displays, and drop
  // what "Clear all" hid (last event at or before clearedAtMs).
  const notices = useMemo(() => {
    const nowMs = Date.now();
    const built = buildNotices(
      [...notificationCancelled, ...notificationTickets],
      nowMs,
    );
    const arrivedAt = arrivedAtRef.current;
    return built
      .filter(n => noticeEventMs(n, arrivedAt, nowMs) > clearedAtMs)
      .sort((a, b) => noticeEventMs(b, arrivedAt, nowMs) - noticeEventMs(a, arrivedAt, nowMs));
  }, [notificationCancelled, notificationTickets, clearedAtMs]);
  const isUnread = (n: Notice) => n.ticketIds.some(id => !readIds.has(id));
  const unreadCount = notices.filter(isUnread).length;

  // Push banners. Keyed on id+kind so a state change (working → fill) raises a
  // new banner, while a re-render of the same state does not.
  const seenNoticeKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = new Set(
      notices.map(n => {
        const filled = n.legs.filter(l => l.state === 'FILLED').length;
        return `${n.id}:${n.kind}:${filled}/${n.legs.length}`;
      }),
    );
    const prev = seenNoticeKeysRef.current;
    seenNoticeKeysRef.current = keys;
    if (prev == null) return;
    const fresh = notices.filter(n => {
      const filled = n.legs.filter(l => l.state === 'FILLED').length;
      return !prev.has(`${n.id}:${n.kind}:${filled}/${n.legs.length}`);
    });
    if (fresh.length === 0) return;
    const freshToasts = fresh.map(
      (n): Toast => ({
        key: `${n.id}:${n.kind}:${n.legs.filter(l => l.state === 'FILLED').length}/${n.legs.length}`,
        noticeId: n.id,
        kind: n.kind,
        glyph: glyphKindOf(n),
        title: titleOf(n),
        body: bodyOf(n),
        time: fmtArrival(noticeEventMs(n, arrivedAtRef.current, Date.now())),
      }),
    );
    setToasts(cur => withToastsAdded(cur, freshToasts));
  }, [notices]);

  /** Start a banner's exit animation; the effect below drops it after. */
  const dismissToast = useCallback((key: string) => {
    setToasts(cur => cur.map(t => (t.key === key ? { ...t, leaving: true } : t)));
  }, []);

  // The oldest banner still showing leaves after TOAST_MS.
  useEffect(() => {
    const oldest = [...toasts].reverse().find(t => !t.leaving);
    if (!oldest) return;
    const timer = setTimeout(() => dismissToast(oldest.key), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts, dismissToast]);

  // Drop leaving banners once their exit has played. A later change that
  // restarts this timer only delays removing a banner that is already off
  // screen with its slot collapsed — the exit holds its end state (forwards).
  useEffect(() => {
    if (!toasts.some(t => t.leaving)) return;
    const timer = setTimeout(
      () => setToasts(cur => cur.filter(t => !t.leaving)),
      TOAST_EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [toasts]);
  const activeKinds = FILTERS.find(f => f.id === filter)?.kinds ?? FILTERS[0].kinds;
  const visibleNotices = notices.filter(n => activeKinds.includes(n.kind));

  const toggleRow = (n: Notice) => {
    setReadIds(prev => {
      if (n.ticketIds.every(id => prev.has(id))) return prev;
      const next = new Set(prev);
      n.ticketIds.forEach(id => next.add(id));
      return next;
    });
    setOpenId(prev => (prev === n.id ? null : n.id));
  };

  const markAllRead = () =>
    setReadIds(new Set([...notificationCancelled, ...notificationTickets].map(t => t.id)));

  // "Clear all" hides everything listed now and drops the saved history. A
  // later event on a ticket still on the book (it fills, or a strip gains a
  // leg) shows again. Arrival stamps stay: dropping them would re-stamp every
  // ticket on the book as arriving after the clear, so nothing would hide.
  const clearAll = () => {
    setClearedAtMs(Date.now());
    setSavedNotifications(null);
    setReadIds(new Set());
    setOpenId(null);
    setToasts(cur => cur.map(t => ({ ...t, leaving: true })));
  };

  useEffect(() => {
    if (!notificationsReady) return;
    const timer = window.setTimeout(() => {
      void saveExecutionJournal(
        {
          notifications: {
            tickets: notificationTickets,
            cancelled: notificationCancelled,
            readIds: [...readIds],
            arrivedAt: Object.fromEntries(arrivedAtRef.current),
            clearedAtMs,
          },
        },
        sandboxTaskId,
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [clearedAtMs, notificationCancelled, notificationTickets, notificationsReady, readIds, sandboxTaskId]);

  const onBellPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: posRef.current.left,
      origTop: posRef.current.top,
      moved: false,
    };
  }, []);

  const onBellPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      return;
    }
    drag.moved = true;
    setDragging(true);
    setPos(clampBellPos({
      left: drag.origLeft + dx,
      top: drag.origTop + dy,
    }));
  }, []);

  const endBellPointer = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (drag.moved) {
      skipClickRef.current = true;
      writeStoredBellPos(posRef.current);
    }
  }, []);

  const onBellClick = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    if (skipClickRef.current) {
      e.preventDefault();
      skipClickRef.current = false;
      return;
    }
    setPanelOpen(o => !o);
  }, []);

  if (!mounted || typeof document === 'undefined') return null;

  const panelFromRight = pos.left + BELL_SIZE / 2 > (typeof window !== 'undefined' ? window.innerWidth / 2 : 0);
  const panelFromBottom =
    typeof window !== 'undefined'
    && pos.top + BELL_SIZE + 8 + 360 > window.innerHeight - 16;

  return createPortal(
    <>
      <style>{`
        @keyframes ncRing{0%{transform:rotate(0)}3%{transform:rotate(15deg)}8%{transform:rotate(-12deg)}13%{transform:rotate(9deg)}18%{transform:rotate(-6deg)}23%{transform:rotate(3.5deg)}28%{transform:rotate(-1.6deg)}33%,100%{transform:rotate(0)}}
        @keyframes ncClapper{0%{transform:translateX(0)}4%{transform:translateX(2.4px)}10%{transform:translateX(-2px)}16%{transform:translateX(1.4px)}22%{transform:translateX(-.8px)}30%,100%{transform:translateX(0)}}
        @keyframes ncRipple{0%{transform:scale(.55);opacity:.5}22%{transform:scale(1.7);opacity:0}100%{transform:scale(1.7);opacity:0}}
        @keyframes ncRingOnce{0%{transform:rotate(0)}8%{transform:rotate(16deg)}20%{transform:rotate(-13deg)}32%{transform:rotate(10deg)}44%{transform:rotate(-7deg)}56%{transform:rotate(4deg)}68%{transform:rotate(-2deg)}80%,100%{transform:rotate(0)}}
        @keyframes ncClapperOnce{0%{transform:translateX(0)}10%{transform:translateX(2.4px)}24%{transform:translateX(-2px)}38%{transform:translateX(1.4px)}52%{transform:translateX(-.9px)}70%,100%{transform:translateX(0)}}
        @keyframes ncRippleOnce{0%{transform:scale(.55);opacity:.55}100%{transform:scale(1.75);opacity:0}}
        @keyframes ncToastIn{0%{transform:translateX(calc(100% + 24px));max-height:0;padding-top:0;padding-bottom:0;border-width:0;margin-bottom:-8px;animation-timing-function:ease-out}25%{transform:translateX(calc(100% + 24px));max-height:110px;padding-top:13px;padding-bottom:13px;border-width:1px;margin-bottom:0;animation-timing-function:cubic-bezier(.16,1,.3,1)}100%{transform:translateX(0);max-height:110px}}
        @keyframes ncToastOut{0%{transform:translateX(0);max-height:110px;animation-timing-function:cubic-bezier(.4,0,1,1)}60%{transform:translateX(calc(100% + 24px));max-height:110px;padding-top:13px;padding-bottom:13px;border-width:1px;margin-bottom:0;animation-timing-function:ease-out}100%{transform:translateX(calc(100% + 24px));max-height:0;padding-top:0;padding-bottom:0;border-width:0;margin-bottom:-8px}}
        .nc-toast-close{opacity:0;transition:opacity .15s ease}
        .nc-toast:hover .nc-toast-close,.nc-toast:focus-within .nc-toast-close{opacity:1}
        @media (hover:none){.nc-toast-close{opacity:1}}
        @media (prefers-reduced-motion:reduce){.nc-anim *{animation:none !important}}
      `}</style>

      <div
        className="nc-anim"
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          zIndex: 400,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        {toasts.map(t => {
          const hue = KIND_STYLE[t.kind].hue;
          return (
            <div
              key={t.key}
              className="nc-toast"
              style={{
                position: 'relative',
                pointerEvents: t.leaving ? 'none' : 'auto',
                width: 380,
                maxWidth: 'calc(100vw - 32px)',
                display: 'flex',
                gap: 11,
                padding: '13px 15px',
                borderRadius: 18,
                border: '1px solid rgba(148,163,184,.18)',
                background: 'rgba(15,23,42,.92)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                boxShadow: '0 18px 40px rgba(0,0,0,.55)',
                // Timing lives in the keyframes, per phase. The exit holds its
                // end state until the banner is dropped; the entrance must
                // not, or its max-height would cap the banner afterwards.
                animation: t.leaving
                  ? `ncToastOut ${TOAST_EXIT_MS}ms forwards`
                  : 'ncToastIn .48s',
              }}
            >
              <button
                type="button"
                className="nc-toast-close"
                aria-label="Close notification"
                onClick={() => dismissToast(t.key)}
                style={{
                  position: 'absolute',
                  top: -7,
                  ...(closeLeft ? { left: -7 } : { right: -7 }),
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  padding: 0,
                  borderRadius: '50%',
                  border: '1px solid rgba(148,163,184,.3)',
                  background: '#1e293b',
                  color: SLATE_400,
                  cursor: 'pointer',
                }}
              >
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
              <span style={{ flex: 'none', marginTop: 1, display: 'flex' }}>
                <Glyph kind={t.glyph} color={hue} size={18} />
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={() => {
                  setPanelOpen(true);
                  setOpenId(t.noticeId);
                  dismissToast(t.key);
                }}
                onKeyDown={e => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  setPanelOpen(true);
                  setOpenId(t.noticeId);
                  dismissToast(t.key);
                }}
                style={{ minWidth: 0, flex: 1, cursor: 'pointer' }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ font: '600 12px/1.3 system-ui', color: SLATE_50 }}>
                    {t.title}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      flex: 'none',
                      font: '400 10px/1.3 ui-monospace,Menlo,monospace',
                      color: SLATE_500,
                    }}
                  >
                    {t.time}
                  </span>
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 4,
                    font: '400 10px/1.5 ui-monospace,Menlo,monospace',
                    color: SLATE_400,
                  }}
                >
                  {t.body}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div
        className="nc-anim"
        ref={bellWrapRef}
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          zIndex: 300,
        }}
      >
        <button
          type="button"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          title="Drag to move · click to open"
          onPointerDown={onBellPointerDown}
          onPointerMove={onBellPointerMove}
          onPointerUp={endBellPointer}
          onPointerCancel={endBellPointer}
          onClick={onBellClick}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: BELL_SIZE,
            height: BELL_SIZE,
            borderRadius: 10,
            border: '1px solid #334155',
            background: '#0f172a',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          <NotificationBell
            ring={ringing}
            loop={unreadCount > 0 && !ringing}
            color={ringing ? ringHue : unreadCount > 0 ? SK : SLATE_400}
            count={unreadCount}
            badgeHue={ringing ? ringHue : RO}
            ringKey={ringSeq}
          />
        </button>

        {panelOpen ? (
          <div
            role="dialog"
            aria-label="Notifications"
            style={{
              position: 'absolute',
              ...(panelFromBottom
                ? { bottom: 'calc(100% + 8px)' }
                : { top: 'calc(100% + 8px)' }),
              ...(panelFromRight ? { right: 0 } : { left: 0 }),
              width: 404,
              maxWidth: 'calc(100vw - 32px)',
              border: '1px solid #334155',
              borderRadius: 14,
              background: '#0f172a',
              overflow: 'hidden',
              boxShadow: '0 20px 40px rgba(0,0,0,.5)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '14px 16px',
                borderBottom: '1px solid #1e293b',
              }}
            >
              <span style={{ font: '600 13px/1 system-ui', color: SLATE_50 }}>Notifications</span>
              <button
                type="button"
                onClick={markAllRead}
                disabled={unreadCount === 0}
                title="Mark all as read"
                aria-label="Mark all as read"
                style={{
                  marginLeft: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 30,
                  height: 30,
                  padding: 0,
                  border: `1px solid ${unreadCount > 0 ? tint(EM, 0.4) : '#334155'}`,
                  borderRadius: 7,
                  background: unreadCount > 0 ? tint(EM, 0.1) : 'transparent',
                  color: unreadCount > 0 ? EM : SLATE_600,
                  cursor: unreadCount > 0 ? 'pointer' : 'default',
                  opacity: unreadCount > 0 ? 1 : 0.45,
                }}
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6.5 9.6 17 4 11.6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={notices.length === 0}
                title="Clear all notifications"
                style={{
                  height: 30,
                  padding: '0 10px',
                  border: `1px solid ${notices.length > 0 ? tint(RO, 0.4) : '#334155'}`,
                  borderRadius: 7,
                  background: 'transparent',
                  color: notices.length > 0 ? RO : SLATE_600,
                  font: '600 10px/1 ui-monospace,Menlo,monospace',
                  cursor: notices.length > 0 ? 'pointer' : 'default',
                  opacity: notices.length > 0 ? 1 : 0.45,
                }}
              >
                Clear all
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6, padding: '11px 16px', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
              {FILTERS.map(f => {
                const on = filter === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setFilter(f.id);
                      setOpenId(null);
                    }}
                    style={{
                      padding: '6px 12px',
                      border: `1px solid ${on ? tint(SK, 0.5) : '#334155'}`,
                      borderRadius: 7,
                      background: on ? tint(SK, 0.14) : 'transparent',
                      color: on ? SK : SLATE_400,
                      font: '600 11px/1.2 ui-monospace,Menlo,monospace',
                      cursor: 'pointer',
                    }}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>

            <div style={{ maxHeight: 'min(60vh, 26rem)', overflowY: 'auto' }}>
              {visibleNotices.length === 0 ? (
                <div style={{ padding: '34px 16px', textAlign: 'center', font: '400 10px/1.5 ui-monospace,Menlo,monospace', color: '#475569' }}>
                  Nothing in this filter.
                </div>
              ) : (
                visibleNotices.map(n => (
                  <Row
                    key={n.id}
                    kind={n.kind}
                    glyph={glyphKindOf(n)}
                    title={titleOf(n)}
                    body={bodyOf(n)}
                    time={fmtArrival(noticeEventMs(n, arrivedAtRef.current, Date.now()))}
                    unread={isUnread(n)}
                    open={openId === n.id}
                    chips={chipsOf(n)}
                    stats={statsOf(n)}
                    legs={n.legs}
                    actions={actionsFor(n, {
                      onOpenBlotter,
                      onEditOrder,
                      onCancelOrder,
                    })}
                    errorMessage={
                      n.kind === 'break'
                        ? n.legs.find(l => l.state === 'REJECTED')?.ticket.ipaQuote?.errorMessage
                        : undefined
                    }
                    onToggle={() => toggleRow(n)}
                  />
                ))
              )}
            </div>

            <div style={{ padding: '12px 16px', font: '400 10px/1.4 ui-monospace,Menlo,monospace', color: SLATE_500 }}>
              {unreadCount > 0 ? `${unreadCount} unread` : 'All read'} · grouped by strip · click a row for execution detail
            </div>
          </div>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
