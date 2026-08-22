import type { SwapForwardOverlay } from '@/lib/fx-hedge';
import {
  GROUP_HEDGE_SCOPE,
  type EntityHedgeBook,
  type EntityHedgeDeskState,
} from '@/lib/test-mode/hedge-var';
import type { LayerId } from '@/lib/fx-buffer';

const DESK_LAYER_IDS = new Set<string>([
  'sigmaP',
  'carryOptim',
  'floorH',
  'portfolioDiv',
  'cfarCover',
]);
const DESK_SCENARIO_IDS = new Set([
  'conservative',
  'carryTarget',
  'balanced',
  'maxCarry',
  'maxPolicyRisk',
  'maxReturn',
]);

function normalizeDeskLayers(raw: unknown): LayerId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(
    (id): id is LayerId => typeof id === 'string' && DESK_LAYER_IDS.has(id),
  );
}

function normalizeDeskScenarioId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return DESK_SCENARIO_IDS.has(raw) ? raw : '';
}

function finiteNumberMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeSwapForwardOverlayMap(
  raw: unknown,
): Record<string, SwapForwardOverlay> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, SwapForwardOverlay> = {};
  for (const [ccy, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (typeof row.delta !== 'number' || !Number.isFinite(row.delta)) continue;
    const swapNear = finiteOrZero(row.swapNearLocalM);
    out[ccy] = {
      delta: row.delta,
      exposureLocalM: finiteOrZero(row.exposureLocalM),
      swapNearLocalM: swapNear,
      swapStandingLocalM: finiteOrZero(
        row.swapStandingLocalM !== undefined ? row.swapStandingLocalM : swapNear,
      ),
      forwardLocalM: finiteOrZero(row.forwardLocalM),
      remainingFarLocalM: finiteOrZero(row.remainingFarLocalM),
      residualNearLocalM: finiteOrZero(row.residualNearLocalM),
      finalNetLocalM: finiteOrZero(row.finalNetLocalM),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Coerce a stored desk overlay blob. */
export function normalizeHedgeDesk(raw: unknown): EntityHedgeDeskState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as EntityHedgeDeskState & { hedgeStrategy?: unknown };
  const desk: EntityHedgeDeskState = {};
  const residual = finiteNumberMap(row.residualByCcy);
  if (residual) desk.residualByCcy = residual;
  const swapDelta = finiteNumberMap(row.swapForwardDeltaByRowId);
  if (swapDelta) desk.swapForwardDeltaByRowId = swapDelta;
  const optDelta = finiteNumberMap(row.optionDeltaByRowId);
  if (optDelta) desk.optionDeltaByRowId = optDelta;
  const overlay = normalizeSwapForwardOverlayMap(row.swapForwardOverlayByCcy);
  if (overlay) desk.swapForwardOverlayByCcy = overlay;
  if (typeof row.hedgeStrategy === 'string' && row.hedgeStrategy.trim()) {
    desk.hedgeStrategy = row.hedgeStrategy;
  }
  if (typeof row.policyVAR === 'number' && Number.isFinite(row.policyVAR)) {
    desk.policyVAR = row.policyVAR;
  }
  if (
    typeof row.portfolioCarryK === 'number'
    && Number.isFinite(row.portfolioCarryK)
  ) {
    desk.portfolioCarryK = row.portfolioCarryK;
  }
  const layers = normalizeDeskLayers(row.activeLayers);
  if (layers) desk.activeLayers = layers;
  if ('portfolioScenarioId' in row) {
    desk.portfolioScenarioId = normalizeDeskScenarioId(row.portfolioScenarioId) ?? '';
  }
  return Object.keys(desk).length > 0 ? desk : undefined;
}

/** Union two desk overlays — primary wins per field, secondary fills gaps. */
export function mergeHedgeDesk(
  primary?: EntityHedgeDeskState,
  secondary?: EntityHedgeDeskState,
): EntityHedgeDeskState | undefined {
  if (!primary && !secondary) return undefined;
  const residualByCcy = {
    ...(secondary?.residualByCcy ?? {}),
    ...(primary?.residualByCcy ?? {}),
  };
  const swapForwardDeltaByRowId = {
    ...(secondary?.swapForwardDeltaByRowId ?? {}),
    ...(primary?.swapForwardDeltaByRowId ?? {}),
  };
  const optionDeltaByRowId = {
    ...(secondary?.optionDeltaByRowId ?? {}),
    ...(primary?.optionDeltaByRowId ?? {}),
  };
  const swapForwardOverlayByCcy = {
    ...(secondary?.swapForwardOverlayByCcy ?? {}),
    ...(primary?.swapForwardOverlayByCcy ?? {}),
  };
  const desk: EntityHedgeDeskState = {};
  if (Object.keys(residualByCcy).length > 0) desk.residualByCcy = residualByCcy;
  if (Object.keys(swapForwardDeltaByRowId).length > 0) {
    desk.swapForwardDeltaByRowId = swapForwardDeltaByRowId;
  }
  if (Object.keys(optionDeltaByRowId).length > 0) {
    desk.optionDeltaByRowId = optionDeltaByRowId;
  }
  if (Object.keys(swapForwardOverlayByCcy).length > 0) {
    desk.swapForwardOverlayByCcy = swapForwardOverlayByCcy;
  }
  const hedgeStrategy = primary?.hedgeStrategy ?? secondary?.hedgeStrategy;
  if (hedgeStrategy) desk.hedgeStrategy = hedgeStrategy;
  const policyVAR = primary?.policyVAR ?? secondary?.policyVAR;
  if (typeof policyVAR === 'number') desk.policyVAR = policyVAR;
  const portfolioCarryK = primary?.portfolioCarryK ?? secondary?.portfolioCarryK;
  if (typeof portfolioCarryK === 'number') desk.portfolioCarryK = portfolioCarryK;
  if (primary && Array.isArray(primary.activeLayers)) {
    desk.activeLayers = primary.activeLayers;
  } else if (secondary && Array.isArray(secondary.activeLayers)) {
    desk.activeLayers = secondary.activeLayers;
  }
  if (primary && 'portfolioScenarioId' in primary) {
    if (primary.portfolioScenarioId) {
      desk.portfolioScenarioId = primary.portfolioScenarioId;
    }
  } else if (secondary?.portfolioScenarioId) {
    desk.portfolioScenarioId = secondary.portfolioScenarioId;
  }
  return Object.keys(desk).length > 0 ? desk : undefined;
}

function deskContentScore(desk?: EntityHedgeDeskState): number {
  if (!desk) return 0;
  return (
    Object.keys(desk.residualByCcy ?? {}).length
    + Object.keys(desk.swapForwardDeltaByRowId ?? {}).length
    + Object.keys(desk.optionDeltaByRowId ?? {}).length
    + Object.keys(desk.swapForwardOverlayByCcy ?? {}).length
    + (typeof desk.policyVAR === 'number' ? 1 : 0)
    + (typeof desk.portfolioCarryK === 'number' ? 1 : 0)
    + (desk.activeLayers?.length ?? 0)
    + (desk.portfolioScenarioId ? 1 : 0)
  );
}

/** Coerce a stored / API hedge-book map into the live EntityHedgeBook shape. */
export function normalizeHedgeBooksMap(
  raw: unknown,
): Record<string, EntityHedgeBook> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, EntityHedgeBook> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const book = value as {
      bookedHedges?: unknown;
      hedgeRatios?: unknown;
      preparedByCcy?: unknown;
      carrySessionsByCcy?: unknown;
      marketRatesByCcy?: unknown;
      desk?: unknown;
    };
    const desk = normalizeHedgeDesk(book.desk);
    out[key] = {
      bookedHedges: Array.isArray(book.bookedHedges) ? book.bookedHedges : [],
      hedgeRatios:
        book.hedgeRatios && typeof book.hedgeRatios === 'object'
          ? (book.hedgeRatios as Record<string, number>)
          : {},
      preparedByCcy:
        book.preparedByCcy && typeof book.preparedByCcy === 'object'
          ? (book.preparedByCcy as EntityHedgeBook['preparedByCcy'])
          : {},
      carrySessionsByCcy:
        book.carrySessionsByCcy && typeof book.carrySessionsByCcy === 'object'
          ? (book.carrySessionsByCcy as EntityHedgeBook['carrySessionsByCcy'])
          : {},
      marketRatesByCcy:
        book.marketRatesByCcy && typeof book.marketRatesByCcy === 'object'
          ? (book.marketRatesByCcy as EntityHedgeBook['marketRatesByCcy'])
          : {},
      ...(desk ? { desk } : {}),
    };
  }
  return out;
}

/** Count booked tickets, prepared packages, desk overlay, carry, and market curves. */
export function hedgeBookContentScore(
  hedges: Record<string, EntityHedgeBook> | undefined,
): {
  booked: number;
  prepared: number;
  desk: number;
  carry: number;
  market: number;
} {
  let booked = 0;
  let prepared = 0;
  let desk = 0;
  let carry = 0;
  let market = 0;
  for (const book of Object.values(hedges ?? {})) {
    booked += book.bookedHedges?.length ?? 0;
    prepared += Object.keys(book.preparedByCcy ?? {}).length;
    desk += deskContentScore(book.desk);
    carry += Object.keys(book.carrySessionsByCcy ?? {}).length;
    market += Object.keys(book.marketRatesByCcy ?? {}).length;
  }
  return { booked, prepared, desk, carry, market };
}

export function hedgeBookHasContent(
  hedges: Record<string, EntityHedgeBook> | undefined,
): boolean {
  const score = hedgeBookContentScore(hedges);
  return (
    score.booked + score.prepared + score.desk + score.carry + score.market > 0
  );
}

/**
 * Union two hedge maps so a newer structure/UI snapshot cannot drop
 * packages, tickets, carry sessions, or market curves still on the other copy.
 */
export function mergeHedgeBooksPreservingPrepared(
  primary: Record<string, EntityHedgeBook> | undefined,
  secondary: Record<string, EntityHedgeBook> | undefined,
): Record<string, EntityHedgeBook> {
  const keys = new Set([
    ...Object.keys(primary ?? {}),
    ...Object.keys(secondary ?? {}),
  ]);
  const out: Record<string, EntityHedgeBook> = {};
  for (const key of keys) {
    const a = primary?.[key];
    const b = secondary?.[key];
    const byId = new Map((b?.bookedHedges ?? []).map(t => [t.id, t] as const));
    for (const t of a?.bookedHedges ?? []) byId.set(t.id, t);
    const desk = mergeHedgeDesk(a?.desk, b?.desk);
    out[key] = {
      bookedHedges: [...byId.values()],
      hedgeRatios: { ...(b?.hedgeRatios ?? {}), ...(a?.hedgeRatios ?? {}) },
      preparedByCcy: {
        ...(b?.preparedByCcy ?? {}),
        ...(a?.preparedByCcy ?? {}),
      },
      carrySessionsByCcy: {
        ...(b?.carrySessionsByCcy ?? {}),
        ...(a?.carrySessionsByCcy ?? {}),
      },
      marketRatesByCcy: {
        ...(b?.marketRatesByCcy ?? {}),
        ...(a?.marketRatesByCcy ?? {}),
      },
      ...(desk ? { desk } : {}),
    };
  }
  return out;
}

function ledgerScore(score: ReturnType<typeof hedgeBookContentScore>): number {
  return score.booked + score.prepared + score.carry + score.market;
}

function bookedIdSet(book?: EntityHedgeBook): Set<string> {
  return new Set(
    (book?.bookedHedges ?? [])
      .map(t => t.id)
      .filter((id): id is string => Boolean(id)),
  );
}

function scoreOneBook(book?: EntityHedgeBook) {
  return hedgeBookContentScore(book ? { _: book } : {});
}

/**
 * Remount / Fast Refresh / desk overlay flush for one entity: tickets (if any)
 * are still present, but prepared packages, carry sessions, or market curves
 * were replaced with an empty shell. Un-staging *one of several* packages
 * keeps at least one prepared key and is not treated as a wipe.
 *
 * Fast Refresh remount of Simulator also publishes
 * `{ policyVAR: 5, activeLayers: [] }` while packages are still on the book.
 */
function deskLooksLikeRemountDefault(desk?: EntityHedgeDeskState): boolean {
  if (!desk) return true;
  const noLayers = !desk.activeLayers || desk.activeLayers.length === 0;
  const noScenario = !desk.portfolioScenarioId;
  const defaultVar = desk.policyVAR === undefined || desk.policyVAR === 5;
  return noLayers && noScenario && defaultVar;
}

function entityLooksLikeAccidentalWipe(
  incoming: EntityHedgeBook | undefined,
  existing: EntityHedgeBook | undefined,
): boolean {
  if (!existing) return false;
  const inc = scoreOneBook(incoming);
  const ex = scoreOneBook(existing);
  if (ledgerScore(ex) > 0 && ledgerScore(inc) === 0) return true;

  const exIds = bookedIdSet(existing);
  const incIds = bookedIdSet(incoming);
  const ticketsKept =
    exIds.size === 0 || [...exIds].every(id => incIds.has(id));
  if (!ticketsKept) return false;

  if (
    deskLooksLikeRemountDefault(incoming?.desk)
    && !deskLooksLikeRemountDefault(existing?.desk)
  ) {
    return true;
  }
  if (ex.prepared > 0 && inc.prepared === 0) return true;
  if (ex.carry > 0 && inc.carry === 0) return true;
  if (ex.market > 0 && inc.market === 0) return true;
  if (ex.desk > 1 && inc.desk < ex.desk && inc.desk <= 1) return true;
  if (
    inc.prepared < ex.prepared
    && (inc.booked < ex.booked || inc.carry < ex.carry || inc.market < ex.market)
  ) {
    return true;
  }
  if (
    inc.carry < ex.carry
    && inc.prepared === ex.prepared
    && inc.booked === ex.booked
  ) {
    return true;
  }
  if (
    inc.market < ex.market
    && inc.prepared === ex.prepared
    && inc.booked === ex.booked
  ) {
    return true;
  }
  return false;
}

/**
 * True when `incoming` is a thinner snapshot than `existing` — typical of a
 * structure/nav persist that still has a few booked tickets but dropped
 * prepared packages, desk overlay, carry sessions, or market curves.
 *
 * A booked-ticket delete with prepared/desk/carry/market intact is NOT
 * treated as partial, so Send/unbook still wins.
 */
export function hedgeBookLooksLikePartialSnapshot(
  incoming: Record<string, EntityHedgeBook> | undefined,
  existing: Record<string, EntityHedgeBook> | undefined,
): boolean {
  const inc = hedgeBookContentScore(incoming);
  const ex = hedgeBookContentScore(existing);
  if (inc.prepared < ex.prepared) return true;
  if (inc.desk < ex.desk) return true;
  if (inc.carry < ex.carry) return true;
  if (inc.market < ex.market) return true;
  return inc.booked + inc.prepared === 0 && ex.booked + ex.prepared > 0;
}

/**
 * Remount / desk-flush / Fast Refresh often writes
 * `{ entity: tickets + empty prepared + default desk }` with a newer
 * `hedgesUpdatedAt`. That is not an intentional un-prepare and must not
 * replace the ledger in Postgres or localStorage.
 *
 * Clearing *all* prepared keys while tickets stay is treated as a wipe
 * (the remount signature). Un-staging one of several packages still wins.
 */
export function hedgeBookLooksLikeAccidentalWipe(
  incoming: Record<string, EntityHedgeBook> | undefined,
  existing: Record<string, EntityHedgeBook> | undefined,
): boolean {
  const inc = hedgeBookContentScore(incoming);
  const ex = hedgeBookContentScore(existing);
  if (ledgerScore(ex) > 0 && ledgerScore(inc) === 0) return true;
  const keys = new Set([
    ...Object.keys(incoming ?? {}),
    ...Object.keys(existing ?? {}),
  ]);
  for (const key of keys) {
    if (entityLooksLikeAccidentalWipe(incoming?.[key], existing?.[key])) {
      return true;
    }
  }
  return false;
}

/** Tickets / prepared / desk overlay / carry / market changed. */
export function hedgeLedgerChanged(
  prev: Record<string, EntityHedgeBook> | undefined,
  next: Record<string, EntityHedgeBook> | undefined,
): boolean {
  const a = hedgeBookContentScore(prev);
  const b = hedgeBookContentScore(next);
  return (
    a.booked !== b.booked
    || a.prepared !== b.prepared
    || a.desk !== b.desk
    || a.carry !== b.carry
    || a.market !== b.market
  );
}

/** Keep existing hedge content when the incoming map looks like a partial PUT. */
export function coalesceHedgeBooks(
  incoming: Record<string, EntityHedgeBook> | undefined,
  existing: Record<string, EntityHedgeBook> | undefined,
): Record<string, EntityHedgeBook> {
  if (hedgeBookLooksLikePartialSnapshot(incoming, existing)) {
    return mergeHedgeBooksPreservingPrepared(incoming, existing);
  }
  return incoming ?? {};
}

function hedgeClock(iso?: string): number {
  return Date.parse(iso ?? '') || 0;
}

/** Keep books for entity ids the incoming snapshot simply omitted. */
export function retainOmittedHedgeEntities(
  incoming: Record<string, EntityHedgeBook> | undefined,
  existing: Record<string, EntityHedgeBook> | undefined,
): Record<string, EntityHedgeBook> {
  const out: Record<string, EntityHedgeBook> = { ...(incoming ?? {}) };
  for (const [key, book] of Object.entries(existing ?? {})) {
    if (!(key in out)) out[key] = book;
  }
  return out;
}

/** Merge a desk patch into the live book so a partial overlay cannot drop packages. */
export function applyDeskPatch(
  prev: EntityHedgeBook,
  patch: EntityHedgeDeskState,
): EntityHedgeBook {
  const desk = mergeHedgeDesk(patch, prev.desk);
  return desk ? { ...prev, desk } : { ...prev };
}

/**
 * Choose which hedge map to persist.
 * A newer `hedgesUpdatedAt` can unbook tickets or un-stage *some* packages.
 * Tickets kept + every prepared/carry/market key cleared is a remount wipe
 * and is merged so Postgres cannot lose the book. Same clock + a thinner
 * snapshot also merges. Omitted entity keys are kept.
 */
export function pickHedgeBooksForWrite(
  incoming: Record<string, EntityHedgeBook> | undefined,
  existing: Record<string, EntityHedgeBook> | undefined,
  incomingHedgesAt?: string,
  existingHedgesAt?: string,
): {
  hedgesByEntityId: Record<string, EntityHedgeBook>;
  hedgesUpdatedAt?: string;
} {
  const incH = hedgeClock(incomingHedgesAt);
  const exH = hedgeClock(existingHedgesAt);
  if (incH < exH) {
    return {
      hedgesByEntityId: mergeHedgeBooksPreservingPrepared(incoming, existing),
      hedgesUpdatedAt: existingHedgesAt,
    };
  }
  const retained = retainOmittedHedgeEntities(incoming, existing);
  if (hedgeBookLooksLikeAccidentalWipe(retained, existing)) {
    return {
      hedgesByEntityId: mergeHedgeBooksPreservingPrepared(existing, retained),
      hedgesUpdatedAt: incomingHedgesAt ?? existingHedgesAt,
    };
  }
  if (incH === exH && hedgeBookLooksLikePartialSnapshot(retained, existing)) {
    return {
      hedgesByEntityId: mergeHedgeBooksPreservingPrepared(retained, existing),
      hedgesUpdatedAt: existingHedgesAt ?? incomingHedgesAt,
    };
  }
  return {
    hedgesByEntityId: retained,
    hedgesUpdatedAt: incomingHedgesAt ?? existingHedgesAt,
  };
}

/** Drop uploaded curves from a sidecar / hedge PATCH so quota and keepalive stay under the limit. */
export function omitMarketRatesFromHedgeBooks(
  hedges: Record<string, EntityHedgeBook> | undefined,
): Record<string, EntityHedgeBook> {
  const out: Record<string, EntityHedgeBook> = {};
  for (const [id, book] of Object.entries(hedges ?? {})) {
    out[id] = { ...book, marketRatesByCcy: {} };
  }
  return out;
}

/**
 * A ledger-only PATCH / sidecar omits market curves. Copy them back from the
 * existing book so wipe-detection does not treat the omit as a reset.
 */
export function fillMarketRatesFromExisting(
  incoming: Record<string, EntityHedgeBook> | undefined,
  existing: Record<string, EntityHedgeBook> | undefined,
): Record<string, EntityHedgeBook> {
  const retained = retainOmittedHedgeEntities(incoming, existing);
  const out: Record<string, EntityHedgeBook> = { ...retained };
  for (const [id, book] of Object.entries(out)) {
    const incMarket = Object.keys(book.marketRatesByCcy ?? {}).length;
    const exMarket = existing?.[id]?.marketRatesByCcy;
    if (incMarket === 0 && exMarket && Object.keys(exMarket).length > 0) {
      out[id] = { ...book, marketRatesByCcy: exMarket };
    }
  }
  return out;
}

function looksLikeRotatedEntityId(id: string): boolean {
  return /^ent_[a-z0-9]{4,}_[a-z0-9]{4,}$/i.test(id);
}

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Map hedge books onto the live workspace when entity ids rotated (NordTech
 * seed used to mint a new `ent_${Date.now()}_…` on every reseed). Group scope
 * is stable. Empty orphan shells are dropped.
 */
export function rebindHedgeBooksToWorkspace(
  hedges: Record<string, EntityHedgeBook> | undefined,
  entities: readonly { id: string; name: string }[],
  preferredEntityId?: string | null,
): Record<string, EntityHedgeBook> {
  const books: Record<string, EntityHedgeBook> = { ...(hedges ?? {}) };
  const liveIds = new Set(entities.map(e => e.id));
  liveIds.add(GROUP_HEDGE_SCOPE);

  const byName = new Map<string, string>();
  for (const entity of entities) {
    const name = normalizeEntityName(entity.name);
    if (name && !byName.has(name)) byName.set(name, entity.id);
  }

  const rebind = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const src = books[fromId];
    if (!src) return;
    books[toId] = mergeHedgeBooksPreservingPrepared(
      { [toId]: books[toId] },
      { [toId]: src },
    )[toId];
    delete books[fromId];
  };

  for (const key of Object.keys(books)) {
    if (liveIds.has(key)) continue;
    const book = books[key];
    if (!hedgeBookHasContent({ [key]: book })) {
      delete books[key];
      continue;
    }
    const ticketName = (book.bookedHedges ?? []).find(
      t => typeof t.entityName === 'string' && t.entityName.trim(),
    )?.entityName;
    const namedId = ticketName
      ? byName.get(normalizeEntityName(ticketName))
      : undefined;
    if (namedId) rebind(key, namedId);
  }

  const leftover = Object.keys(books).filter(
    key =>
      !liveIds.has(key)
      && looksLikeRotatedEntityId(key)
      && hedgeBookHasContent({ [key]: books[key] }),
  );
  if (leftover.length === 1) {
    const preferred =
      preferredEntityId
      && preferredEntityId !== GROUP_HEDGE_SCOPE
      && liveIds.has(preferredEntityId)
        ? preferredEntityId
        : entities[0]?.id;
    if (preferred) rebind(leftover[0], preferred);
  }

  for (const key of Object.keys(books)) {
    if (!liveIds.has(key) && !hedgeBookHasContent({ [key]: books[key] })) {
      delete books[key];
    }
  }
  return books;
}

/** How many contentful hedge books sit on live entity ids (or group). */
export function hedgeWorkspaceFitScore(
  hedges: Record<string, EntityHedgeBook> | undefined,
  entityIds: readonly string[],
): number {
  const ids = new Set(entityIds);
  ids.add(GROUP_HEDGE_SCOPE);
  let n = 0;
  for (const [key, book] of Object.entries(hedges ?? {})) {
    if (!ids.has(key)) continue;
    if (hedgeBookHasContent({ [key]: book })) n += 1;
  }
  return n;
}

/** Parallel localStorage key so a fat workspace blob cannot take the hedge book with it. */
export const HEDGE_SIDECAR_SUFFIX = '::hedges';

export function hedgeSidecarStorageKey(mainKey: string): string {
  return `${mainKey}${HEDGE_SIDECAR_SUFFIX}`;
}

export function serializeHedgeSidecar(
  hedges: Record<string, EntityHedgeBook> | undefined,
  hedgesUpdatedAt?: string,
): string {
  return JSON.stringify({
    version: 1,
    hedgesByEntityId: omitMarketRatesFromHedgeBooks(hedges),
    hedgesUpdatedAt,
  });
}

export function parseHedgeSidecar(raw: string | null | undefined): {
  hedgesByEntityId: Record<string, EntityHedgeBook>;
  hedgesUpdatedAt?: string;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      hedgesByEntityId?: unknown;
      hedgesUpdatedAt?: unknown;
    };
    return {
      hedgesByEntityId: normalizeHedgeBooksMap(parsed.hedgesByEntityId),
      hedgesUpdatedAt:
        typeof parsed.hedgesUpdatedAt === 'string'
          ? parsed.hedgesUpdatedAt
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Union a primary book with the sidecar so quota / parse failures still restore hedges. */
export function mergeHedgesWithSidecar(
  primary: Record<string, EntityHedgeBook> | undefined,
  primaryAt: string | undefined,
  sidecar: ReturnType<typeof parseHedgeSidecar>,
): {
  hedgesByEntityId: Record<string, EntityHedgeBook>;
  hedgesUpdatedAt?: string;
} {
  if (!sidecar) {
    return {
      hedgesByEntityId: primary ?? {},
      hedgesUpdatedAt: primaryAt,
    };
  }
  return pickHedgeBooksForWrite(
    primary,
    sidecar.hedgesByEntityId,
    primaryAt,
    sidecar.hedgesUpdatedAt,
  );
}
