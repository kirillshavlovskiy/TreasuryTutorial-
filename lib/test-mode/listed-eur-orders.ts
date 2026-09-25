import type { EntityHedgeBook } from '@/lib/test-mode/hedge-var';

/** Fields the ghost match reads — HedgeTicket satisfies it structurally. */
type ListedEurProbe = {
  ccy?: string;
  instrument?: string;
  amountLocalM?: number;
  limitRate?: number | null;
  stripId?: string;
  status?: string;
};

function near(a: number, b: number, tol: number): boolean {
  return Number.isFinite(a) && Math.abs(a - b) <= tol;
}

/**
 * The EUR strip / option / TP-SL stack that keeps resurrecting after a
 * manual cancel. Matched by size and limit, not id — ids rotate on fill.
 */
export function isListedEurGhostTicket(ticket: ListedEurProbe): boolean {
  if (ticket.ccy !== 'EUR') return false;
  const amt = Math.abs(Number(ticket.amountLocalM) || 0);
  const lim = ticket.limitRate;
  if (
    lim != null
    && [1.1575, 1.1565, 1.1573, 1.1561, 1.15745, 1.156].some(x =>
      near(lim, x, 6e-5),
    )
  ) {
    return true;
  }
  if (ticket.stripId && [6.99, 3.96, 3.69, 14.65].some(x => near(amt, x, 0.04))) {
    return true;
  }
  if (ticket.instrument === 'option' && near(amt, 12.1, 0.04)) return true;
  if (
    (ticket.instrument === 'forward' || ticket.instrument === 'spot')
    && [2.55, 12.1, 14.65].some(x => near(amt, x, 0.04))
  ) {
    return true;
  }
  return false;
}

export function stripListedEurTickets<T extends ListedEurProbe>(
  tickets: readonly T[],
): { next: T[]; removed: T[] } {
  const next: T[] = [];
  const removed: T[] = [];
  for (const t of tickets) {
    if (isListedEurGhostTicket(t)) removed.push(t);
    else next.push(t);
  }
  return { next, removed };
}

export function stripListedEurFromHedgeBooks(
  hedges: Record<string, EntityHedgeBook> | undefined,
): {
  hedges: Record<string, EntityHedgeBook>;
  removedIds: string[];
  removedCount: number;
} {
  const out: Record<string, EntityHedgeBook> = {};
  const removedIds: string[] = [];
  let removedCount = 0;
  for (const [scope, book] of Object.entries(hedges ?? {})) {
    const { next, removed } = stripListedEurTickets(book.bookedHedges ?? []);
    removedCount += removed.length;
    for (const t of removed) {
      if (t.id) removedIds.push(t.id);
    }
    out[scope] = { ...book, bookedHedges: next };
  }
  return { hedges: out, removedIds, removedCount };
}
