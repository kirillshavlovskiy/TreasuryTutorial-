/**
 * Server-side Group FX VaR Optimize package (quant-fx-sigma).
 *
 * Tenor-strip legs, market-spot Individual VaR, hedge-carry, and the
 * carry-vs-diversified-VaR curve run here so the walk prints in the Next.js
 * terminal instead of the browser.
 */

import { CURRENCY_PARAMS, type RowState } from '@/lib/fx-buffer';
import { fwdHedgeCarryFromMarketUsd } from '@/lib/fx-hedge';
import type { ForecastProfileState } from '@/lib/forecast-profile';
import { atlasRiskCorrFor, impliedFxVol } from '@/lib/fx-market-risk';
import {
  resolveMarketRatesForCcy,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import {
  buildFxAtlasLegs,
  fxAtlasMarginalEffects,
  fxAtlasTenorFrontier,
  type FxAtlasLeg,
  type FxAtlasMarginalPoint,
  type FxCarryVarPoint,
} from '@/lib/test-mode/fx-var-frontier';
import {
  isVarConfidencePct,
  type VarConfidencePct,
} from '@/lib/test-mode/var-confidence';

const TAG = '[quant-fx-sigma]';

export const FX_ATLAS_LIMITS = {
  maxRows: 24,
  maxMonths: 24,
} as const;

export type FxAtlasJobRequest = {
  rows: readonly RowState[];
  forecastMonths: number;
  forecastProfile?: ForecastProfileState | null;
  confidencePct: VarConfidencePct;
  rUsd: number;
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  ratesScopeId?: string | null;
  /** Names left open (unchecked in the mix table). Re-solves the frontier on the rest. */
  forceOpenCcys?: readonly string[];
  /**
   * Names removed from the book entirely — no leg, no VaR/correlation
   * contribution, as if the row never existed. Different from
   * `forceOpenCcys`: leaving a name "open" still counts its exposure in
   * the diversified risk pool (just pinned unhedged); excluding it drops
   * that exposure altogether. Needed to reproduce a vendor reference
   * report scoped to a currency SUBSET (e.g. a 3-currency book), which is
   * a smaller portfolio, not the 6-currency book with 3 names forced open.
   */
  excludeCcys?: readonly string[];
};

export type FxAtlasByCcy = {
  carry: Record<string, number>;
  indiv: Record<string, number>;
  usd: Record<string, number>;
  local: Record<string, number>;
};

export type FxAtlasJobResult = {
  legs: FxAtlasLeg[];
  byCcy: FxAtlasByCcy;
  curve: FxCarryVarPoint[];
  sweet: FxCarryVarPoint | null;
  fullyHedged: FxCarryVarPoint | null;
  unhedged: FxCarryVarPoint | null;
  marginal: FxAtlasMarginalPoint[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseRows(v: unknown): RowState[] | string {
  if (!Array.isArray(v)) return 'rows must be an array';
  if (v.length > FX_ATLAS_LIMITS.maxRows) {
    return `rows exceeds ${FX_ATLAS_LIMITS.maxRows}`;
  }
  const rows: RowState[] = [];
  for (const raw of v) {
    const rec = asRecord(raw);
    if (!rec || typeof rec.ccy !== 'string' || rec.ccy.length === 0) {
      return 'rows entries need a ccy';
    }
    rows.push(raw as RowState);
  }
  return rows;
}

function parseCcyList(
  v: unknown,
  rows: readonly RowState[],
): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) return undefined;
  const known = new Set(rows.map(r => r.ccy));
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string' || !known.has(raw) || out.includes(raw)) continue;
    out.push(raw);
  }
  return out.length > 0 ? out.sort() : undefined;
}

export function parseFxAtlasJobRequest(
  body: unknown,
): { request: FxAtlasJobRequest } | { error: string } {
  const rec = asRecord(body);
  if (!rec) return { error: 'Body must be a JSON object' };

  const rows = parseRows(rec.rows);
  if (typeof rows === 'string') return { error: rows };

  const forecastMonths = Number(rec.forecastMonths);
  if (!Number.isFinite(forecastMonths)
    || forecastMonths < 1
    || forecastMonths > FX_ATLAS_LIMITS.maxMonths) {
    return { error: `forecastMonths must be 1–${FX_ATLAS_LIMITS.maxMonths}` };
  }

  const confidencePct = rec.confidencePct;
  if (!isVarConfidencePct(confidencePct)) {
    return { error: 'confidencePct must be 90, 95, or 99' };
  }

  const rUsd = Number(rec.rUsd);
  if (!Number.isFinite(rUsd) || rUsd < -20 || rUsd > 40) {
    return { error: 'rUsd must be a finite rate' };
  }

  const forecastProfile = rec.forecastProfile == null
    ? null
    : asRecord(rec.forecastProfile) as ForecastProfileState;

  const marketRatesByCcy = rec.marketRatesByCcy == null
    ? undefined
    : asRecord(rec.marketRatesByCcy) as Record<string, FxMarketRatesBundle>;

  const ratesScopeId = typeof rec.ratesScopeId === 'string'
    ? rec.ratesScopeId
    : rec.ratesScopeId == null
      ? null
      : undefined;

  const forceOpenCcys = parseCcyList(rec.forceOpenCcys, rows);
  const excludeCcys = parseCcyList(rec.excludeCcys, rows);

  return {
    request: {
      rows,
      forecastMonths,
      forecastProfile,
      confidencePct,
      rUsd,
      marketRatesByCcy,
      ratesScopeId,
      forceOpenCcys,
      excludeCcys,
    },
  };
}

export function emptyFxAtlasJobResult(): FxAtlasJobResult {
  return {
    legs: [],
    byCcy: { carry: {}, indiv: {}, usd: {}, local: {} },
    curve: [],
    sweet: null,
    fullyHedged: null,
    unhedged: null,
    marginal: [],
  };
}

export function computeFxAtlasJob(
  request: FxAtlasJobRequest,
  opts: { log?: boolean } = {},
): FxAtlasJobResult {
  const started = Date.now();
  const corr = atlasRiskCorrFor(request.marketRatesByCcy);
  const exclude = request.excludeCcys?.length
    ? new Set(request.excludeCcys)
    : undefined;
  // A truly excluded name never becomes a leg — no VaR, no correlation
  // contribution, as if the row were never in the book. Distinct from
  // forceOpenCcys, which keeps the exposure in the risk pool and only
  // pins its own hedge ratio.
  const bookRows = exclude
    ? request.rows.filter(row => !exclude.has(row.ccy))
    : request.rows;
  const legs = buildFxAtlasLegs({
    rows: bookRows,
    forecastMonths: request.forecastMonths,
    forecastProfile: request.forecastProfile,
    confidencePct: request.confidencePct,
    rUsd: request.rUsd,
    volFor: (ccy, months) => impliedFxVol(
      ccy,
      months,
      resolveMarketRatesForCcy(
        request.marketRatesByCcy,
        ccy,
        request.ratesScopeId,
      ),
    ),
    // Locked carry = Tf swap points / CIP on each name's Target (the
    // 12M bullet Book trades). Unhedged carry is 0. Market points used
    // only when they price a real differential — a 0 / EUR-pip USDMXN
    // curve must not report MXN as $0.
    priceHedgeCarry: (ccy, hedgeTrade, months) => {
      const book = bookRows.find(row => row.ccy === ccy);
      return fwdHedgeCarryFromMarketUsd(
        hedgeTrade,
        ccy,
        book?.r_FCY ?? CURRENCY_PARAMS[ccy]?.carry ?? 0,
        request.rUsd,
        months,
        resolveMarketRatesForCcy(
          request.marketRatesByCcy,
          ccy,
          request.ratesScopeId,
        ),
      );
    },
  });
  const forceOpen = request.forceOpenCcys?.length
    ? new Set(request.forceOpenCcys)
    : undefined;
  const frontier = fxAtlasTenorFrontier(
    legs,
    corr,
    forceOpen ? { forceOpenCcys: forceOpen } : undefined,
  );
  const byCcy: FxAtlasByCcy = { carry: {}, indiv: {}, usd: {}, local: {} };
  for (const l of legs) {
    byCcy.carry[l.ccy] = (byCcy.carry[l.ccy] ?? 0) + l.hedgeCarryUsdM;
    byCcy.indiv[l.ccy] = (byCcy.indiv[l.ccy] ?? 0) + Math.abs(l.signedVarUsdM);
    byCcy.usd[l.ccy] = (byCcy.usd[l.ccy] ?? 0) + l.exposureUsdM;
    byCcy.local[l.ccy] = (byCcy.local[l.ccy] ?? 0) + l.exposureLocalM;
  }
  const result: FxAtlasJobResult = {
    legs,
    byCcy,
    curve: frontier.curve,
    sweet: frontier.sweet,
    fullyHedged: frontier.fullyHedged,
    unhedged: frontier.unhedged,
    marginal: fxAtlasMarginalEffects(legs, undefined, corr),
  };
  if (opts.log) {
    const mix = frontier.sweet?.hedgeByCcy ?? {};
    const ccys = [...new Set(legs.map(l => l.ccy))];
    const leaveOpen = ccys.filter(c => forceOpen?.has(c));
    const included = ccys.filter(c => !forceOpen?.has(c));
    console.log(
      `${TAG} request rUsd=${request.rUsd} forecastMonths=${request.forecastMonths} `
      + `confidencePct=${request.confidencePct} ratesScopeId=${request.ratesScopeId ?? '—'} `
      + `legs=${legs.length} ccys=${ccys.join(',')} `
      + `leaveOpen=${leaveOpen.join(',') || '—'} `
      + `excluded=${request.excludeCcys?.join(',') || '—'}`,
    );
    console.log(
      `${TAG} mix-filter included=${included.join(',') || '—'} `
      + `leaveOpen=${leaveOpen.join(',') || '—'} `
      + `${leaveOpen.length > 0 ? '(re-solve on selected set)' : '(full book)'}`,
    );
    console.log(
      `${TAG} raw marketRatesByCcy keys received: `
      + `${Object.keys(request.marketRatesByCcy ?? {}).join(',') || '(none)'}`,
    );
    for (const ccy of ccys) {
      const raw = request.marketRatesByCcy?.[ccy];
      console.log(
        `${TAG}   raw[${ccy}]: `
        + `present=${raw != null} `
        + `deposits=${raw?.deposits?.length ?? '—'} `
        + `pair=${raw?.pair ?? '—'} baseCcy=${raw?.baseCcy ?? '—'} quoteCcy=${raw?.quoteCcy ?? '—'} `
        + `sourceFile=${raw?.sourceFile ?? '—'}`,
      );
    }
    for (const ccy of ccys) {
      const bundle = resolveMarketRatesForCcy(
        request.marketRatesByCcy,
        ccy,
        request.ratesScopeId,
      );
      const hasCurve = (bundle.deposits?.length ?? 0) > 0;
      const book = bookRows.find(r => r.ccy === ccy);
      const w = mix[ccy];
      console.log(
        `${TAG}   ${ccy}: `
        + `pricedVia=${hasCurve ? `bundle(${bundle.sourceFile ?? '?'})` : 'flat r_FCY fallback'} `
        + `r_FCY=${book?.r_FCY ?? CURRENCY_PARAMS[ccy]?.carry ?? 0} `
        + `carry=$${(byCcy.carry[ccy] ?? 0).toFixed(4)}mm `
        + `indivVar=$${(byCcy.indiv[ccy] ?? 0).toFixed(4)}mm `
        + `sweetHedge=${w != null ? `${(w * 100).toFixed(1)}%` : '—'} `
        + `dustPinned=${frontier.dustPinnedCcys.includes(ccy)}`,
      );
      // Per-tenor leg detail: exposure -> VaR and carry rate -> hedge
      // carry, plus this leg's own hedge % at Recommended. A leg-level
      // bug (wrong sign, wrong spot, wrong tenor scaling) shows up here
      // even when the currency-level aggregate looks plausible.
      const legsForCcy = legs.filter(l => l.ccy === ccy).sort((a, b) => a.tenorMonths - b.tenorMonths);
      for (const l of legsForCcy) {
        const legKey = `${l.ccy}:${l.tenorMonths}`;
        const legW = frontier.sweet?.hedgeByLeg?.[legKey];
        console.log(
          `${TAG}     ${l.tenorMonths}m: `
          + `localM=${l.exposureLocalM.toFixed(4)} `
          + `usdM=${l.exposureUsdM.toFixed(4)} `
          + `signedVar=$${l.signedVarUsdM.toFixed(5)}mm `
          + `hedgeCarry=$${l.hedgeCarryUsdM.toFixed(5)}mm `
          + `sweetHedge=${legW != null ? `${(legW * 100).toFixed(1)}%` : '—'}`,
        );
      }
    }
    console.log(
      `${TAG} fullyHedged: var=$${(frontier.fullyHedged?.divVarUsdM ?? 0).toFixed(4)}mm `
      + `carry=$${(frontier.fullyHedged?.carryUsdYrM ?? 0).toFixed(4)}mm`,
    );
    console.log(
      `${TAG} unhedged: var=$${(frontier.unhedged?.divVarUsdM ?? 0).toFixed(4)}mm`,
    );
    console.log(
      `${TAG} sweet (Recommended): var=$${(frontier.sweet?.divVarUsdM ?? 0).toFixed(4)}mm `
      + `carry=$${(frontier.sweet?.carryUsdYrM ?? 0).toFixed(4)}mm `
      + `curvePoints=${frontier.curve.length} dustPinned=${frontier.dustPinnedCcys.join(',') || '—'} `
      + `${Date.now() - started}ms`,
    );
  }
  return result;
}
