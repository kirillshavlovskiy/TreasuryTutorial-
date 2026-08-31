/**
 * FX implied vol and pair correlation used by Group FX VaR Optimize.
 *
 * Seeded from Goldman Sachs Capital Markets Atlas (as of 27-Aug-2026):
 * implied vol by CCY×tenor, daily pair corr, and a tenor-decay so
 * adjacent tenors are not treated as ρ = 1. Uploaded Atlas reports
 * replace the seed on the market-data book.
 */

import * as XLSX from 'xlsx';
import type { WorkBook } from 'xlsx';
import atlasCorrSeed from '@/data/fx-market-rates/atlas-corr.json';
import atlasVolSeed from '@/data/fx-market-rates/atlas-implied-vol.json';
import { CORR_CURRENCIES, CORR_MATRIX, CURRENCY_PARAMS } from '@/lib/fx-buffer';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';

function deskPairCorr(a: string, b: string): number {
  if (a === b) return 1;
  const i = CORR_CURRENCIES.indexOf(a);
  const j = CORR_CURRENCIES.indexOf(b);
  if (i < 0 || j < 0) return 0;
  return CORR_MATRIX[i]![j]!;
}

export const ATLAS_RISK_AS_OF = atlasCorrSeed.asOf;
export const ATLAS_TENOR_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export type ImpliedVolByTenor = Record<string, number>;

export type FxCorrMatrix = {
  asOf?: string;
  source?: string;
  ccys: string[];
  matrix: number[][];
  /** ρ(i,j) *= exp(−k |T_i − T_j| / 12). Fitted to Atlas book Div VaR. */
  tenorDecay?: number;
};

export type UsdRiskLeg = {
  ccy: string;
  usdM: number;
  tenorMonths?: number;
};

export const ATLAS_IMPLIED_VOL: Record<string, number[]> = atlasVolSeed.byCcy;
export const ATLAS_CORR: FxCorrMatrix = {
  asOf: atlasCorrSeed.asOf,
  source: atlasCorrSeed.source,
  ccys: atlasCorrSeed.ccys,
  matrix: atlasCorrSeed.matrix,
  tenorDecay: atlasCorrSeed.tenorDecay,
};
export const ATLAS_TENOR_DECAY = atlasCorrSeed.tenorDecay;

export function impliedVolRecord(ccy: string): ImpliedVolByTenor | undefined {
  const row = ATLAS_IMPLIED_VOL[ccy.toUpperCase()];
  if (!row) return undefined;
  const out: ImpliedVolByTenor = {};
  ATLAS_TENOR_MONTHS.forEach((m, i) => {
    const v = row[i];
    if (Number.isFinite(v)) out[String(m)] = v;
  });
  return out;
}

export function deskAnnVol(ccy: string): number {
  const daily = CURRENCY_PARAMS[ccy]?.σ_daily;
  return daily > 0 ? daily * Math.sqrt(252) : 0.025 * Math.sqrt(12);
}

function volFromRecord(
  rec: ImpliedVolByTenor | undefined,
  tenorMonths: number,
): number | null {
  if (!rec) return null;
  const exact = rec[String(tenorMonths)] ?? rec[String(Math.round(tenorMonths))];
  if (Number.isFinite(exact) && (exact as number) > 0) return exact as number;
  const months = ATLAS_TENOR_MONTHS.filter(m => Number.isFinite(rec[String(m)]));
  if (months.length === 0) return null;
  const lo = [...months].reverse().find(m => m <= tenorMonths);
  const hi = months.find(m => m >= tenorMonths);
  if (lo != null && hi != null && lo !== hi) {
    const a = rec[String(lo)]!;
    const b = rec[String(hi)]!;
    const t = (tenorMonths - lo) / (hi - lo);
    return a + (b - a) * t;
  }
  const nearest = months.reduce((best, m) =>
    Math.abs(m - tenorMonths) < Math.abs(best - tenorMonths) ? m : best,
  );
  const v = rec[String(nearest)];
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : null;
}

/** Atlas implied vol (decimal). Bundle upload wins, then seed, then desk σ√252. */
export function impliedFxVol(
  ccy: string,
  tenorMonths = 12,
  bundle?: FxMarketRatesBundle | null,
): number {
  const fromBundle = volFromRecord(bundle?.impliedVolByTenor, tenorMonths);
  if (fromBundle != null) return fromBundle;
  const fromSeed = volFromRecord(impliedVolRecord(ccy), tenorMonths);
  if (fromSeed != null) return fromSeed;
  return deskAnnVol(ccy);
}

export function isFxCorrMatrix(v: unknown): v is FxCorrMatrix {
  if (!v || typeof v !== 'object') return false;
  const rec = v as FxCorrMatrix;
  return Array.isArray(rec.ccys) && Array.isArray(rec.matrix)
    && rec.ccys.length > 0
    && rec.matrix.length === rec.ccys.length;
}

export function resolveFxCorrMatrix(
  marketRatesByCcy?: Record<string, FxMarketRatesBundle> | null,
): FxCorrMatrix {
  for (const bundle of Object.values(marketRatesByCcy ?? {})) {
    const raw = bundle.parameters?.atlasCorr;
    if (isFxCorrMatrix(raw)) {
      return {
        ...raw,
        tenorDecay: Number.isFinite(raw.tenorDecay)
          ? raw.tenorDecay
          : ATLAS_TENOR_DECAY,
      };
    }
  }
  return ATLAS_CORR;
}

export function atlasPairCorr(
  a: string,
  b: string,
  matrix: FxCorrMatrix = ATLAS_CORR,
): number {
  if (a === b) return 1;
  const i = matrix.ccys.indexOf(a);
  const j = matrix.ccys.indexOf(b);
  if (i < 0 || j < 0) return deskPairCorr(a, b);
  const v = matrix.matrix[i]?.[j];
  return Number.isFinite(v) ? v! : deskPairCorr(a, b);
}

export function atlasTenorCorr(
  monthsA: number | undefined,
  monthsB: number | undefined,
  decay = ATLAS_TENOR_DECAY,
): number {
  if (monthsA == null || monthsB == null || !Number.isFinite(decay)) return 1;
  return Math.exp(-decay * Math.abs(monthsA - monthsB) / 12);
}

export function atlasRiskCorr(
  a: UsdRiskLeg,
  b: UsdRiskLeg,
  matrix: FxCorrMatrix = ATLAS_CORR,
): number {
  return atlasPairCorr(a.ccy, b.ccy, matrix)
    * atlasTenorCorr(a.tenorMonths, b.tenorMonths, matrix.tenorDecay ?? ATLAS_TENOR_DECAY);
}

export function atlasRiskCorrFor(
  marketRatesByCcy?: Record<string, FxMarketRatesBundle> | null,
): (a: UsdRiskLeg, b: UsdRiskLeg) => number {
  const matrix = resolveFxCorrMatrix(marketRatesByCcy);
  return (a, b) => atlasRiskCorr(a, b, matrix);
}

function sheetToMatrix(wb: WorkBook, name: string): unknown[][] {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function asStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function pairCcy(label: string): string {
  return label.replace(/^USD\//i, '').replace(/USD$/i, '').toUpperCase();
}

export function isAtlasMarketRiskWorkbook(wb: WorkBook): boolean {
  return wb.SheetNames.some(n => /volatility/i.test(n))
    && wb.SheetNames.some(n => /correlation/i.test(n));
}

export type AtlasMarketRiskParse = {
  asOf: string;
  sourceFile: string;
  volByCcy: Record<string, ImpliedVolByTenor>;
  corr: FxCorrMatrix;
};

function parseVolSheet(rows: unknown[][]): Record<string, ImpliedVolByTenor> {
  const out: Record<string, ImpliedVolByTenor> = {};
  let header: unknown[] | null = null;
  for (const row of rows) {
    const labels = row.map(c => String(c ?? '').toLowerCase());
    if (labels.some(c => c === '1m') && labels.some(c => c === '1y' || c === '12m')) {
      header = row;
      continue;
    }
    if (!header) continue;
    const ccy = asStr(row[2]) ?? asStr(row[1]);
    if (!ccy || ccy === 'USD' || /currency|base/i.test(ccy)) continue;
    const rec: ImpliedVolByTenor = {};
    header.forEach((cell, col) => {
      const label = String(cell ?? '').trim().toLowerCase();
      const months = label === '1y' || label === '12m' ? 12 : /^(\d+)m$/.test(label)
        ? Number(RegExp.$1)
        : null;
      if (months == null) return;
      const v = asNum(row[col]);
      if (v == null) return;
      rec[String(months)] = Math.abs(v) > 1.5 ? v / 100 : v;
    });
    if (Object.keys(rec).length > 0) out[ccy.toUpperCase()] = rec;
  }
  return out;
}

function parseCorrSheet(rows: unknown[][]): FxCorrMatrix | null {
  for (let i = 0; i < rows.length; i++) {
    const hdr = (rows[i] ?? [])
      .map((c, col) => ({ ccy: pairCcy(String(c ?? '')), col }))
      .filter(x => x.ccy.length === 3 && x.ccy !== 'USD' && x.col > 0);
    if (hdr.length < 3) continue;
    const matrix: number[][] = [];
    const ccys = hdr.map(h => h.ccy);
    for (let r = i + 1; r <= i + hdr.length; r++) {
      const row = rows[r] ?? [];
      const label = pairCcy(String(row[0] ?? ''));
      const idx = ccys.indexOf(label);
      if (idx < 0) continue;
      const line = hdr.map(h => {
        const v = asNum(row[h.col]);
        return v == null ? (h.ccy === label ? 1 : 0) : v;
      });
      matrix[idx] = line;
    }
    if (matrix.filter(Boolean).length === ccys.length) {
      return {
        asOf: ATLAS_RISK_AS_OF,
        source: 'Market-risk upload',
        ccys,
        matrix,
        tenorDecay: ATLAS_TENOR_DECAY,
      };
    }
  }
  return null;
}

/** Parse Atlas report Volatility + Correlation Matrix sheets. */
export function parseAtlasMarketRiskWorkbook(
  data: ArrayBuffer,
  fileName: string,
): AtlasMarketRiskParse | null {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  if (!isAtlasMarketRiskWorkbook(wb)) return null;
  const volName = wb.SheetNames.find(n => /volatility/i.test(n));
  const corrName = wb.SheetNames.find(n => /correlation/i.test(n));
  if (!volName || !corrName) return null;
  const volByCcy = parseVolSheet(sheetToMatrix(wb, volName));
  const corr = parseCorrSheet(sheetToMatrix(wb, corrName));
  if (Object.keys(volByCcy).length === 0 || !corr) return null;
  const asOfRow = sheetToMatrix(wb, wb.SheetNames[0] ?? volName)
    .map(r => asStr(r[0]))
    .find(s => s && /as of/i.test(s));
  return {
    asOf: asOfRow?.replace(/^.*as of\s+/i, '') ?? ATLAS_RISK_AS_OF,
    sourceFile: fileName,
    volByCcy,
    corr,
  };
}

export function stampAtlasRiskOnBundle(
  bundle: FxMarketRatesBundle,
  risk: AtlasMarketRiskParse,
  ccy: string,
): FxMarketRatesBundle {
  const key = ccy.toUpperCase();
  return {
    ...bundle,
    impliedVolByTenor: risk.volByCcy[key] ?? bundle.impliedVolByTenor ?? impliedVolRecord(key),
    parameters: {
      ...(bundle.parameters ?? {}),
      atlasCorr: risk.corr,
      atlasCorrAsOf: risk.asOf,
      atlasRiskFile: risk.sourceFile,
    },
  };
}

export function applyAtlasMarketRisk(
  marketRatesByCcy: Record<string, FxMarketRatesBundle>,
  risk: AtlasMarketRiskParse,
  ccys: readonly string[],
  _emptyFor: (ccy: string) => FxMarketRatesBundle,
): Record<string, FxMarketRatesBundle> {
  const next = { ...marketRatesByCcy };
  for (const ccy of ccys) {
    if (ccy === 'USD') continue;
    const existing = next[ccy];
    // Don't plant an LP shell — that shadows a real FXO upload sitting in
    // scoped storage (GBPUSD.xlsx) and the server job then prices flat r_FCY.
    if (!existing) continue;
    next[ccy] = stampAtlasRiskOnBundle(existing, risk, ccy);
  }
  return next;
}

function appendCorrCcy(matrix: FxCorrMatrix, ccy: string): FxCorrMatrix {
  if (matrix.ccys.includes(ccy)) return matrix;
  const ccys = [...matrix.ccys, ccy];
  const rows = matrix.matrix.map(row => [...row, 0]);
  rows.push(ccys.map((_, j) => (j === ccys.length - 1 ? 1 : 0)));
  return { ...matrix, ccys, matrix: rows };
}

export function ensureCorrHasCcys(
  matrix: FxCorrMatrix,
  ccys: readonly string[],
): FxCorrMatrix {
  let next = matrix;
  for (const ccy of ccys) {
    if (ccy === 'USD') continue;
    next = appendCorrCcy(next, ccy.toUpperCase());
  }
  return next;
}

/** Symmetric write. Diagonal stays 1. */
export function setCorrPair(
  matrix: FxCorrMatrix,
  a: string,
  b: string,
  rho: number,
): FxCorrMatrix {
  const filled = ensureCorrHasCcys(matrix, [a, b]);
  const i = filled.ccys.indexOf(a.toUpperCase());
  const j = filled.ccys.indexOf(b.toUpperCase());
  if (i < 0 || j < 0) return filled;
  const v = i === j ? 1 : Math.max(-1, Math.min(1, rho));
  const next = filled.matrix.map(row => [...row]);
  next[i]![j] = v;
  next[j]![i] = v;
  return { ...filled, matrix: next };
}

export function stampImpliedVolOnBook(
  marketRatesByCcy: Record<string, FxMarketRatesBundle>,
  ccy: string,
  impliedVolByTenor: ImpliedVolByTenor,
  emptyFor: (ccy: string) => FxMarketRatesBundle,
): Record<string, FxMarketRatesBundle> {
  const key = ccy.toUpperCase();
  const bundle = marketRatesByCcy[key] ?? emptyFor(key);
  return {
    ...marketRatesByCcy,
    [key]: { ...bundle, impliedVolByTenor },
  };
}

export function stampFxCorrOnBook(
  marketRatesByCcy: Record<string, FxMarketRatesBundle>,
  corr: FxCorrMatrix,
  ccys: readonly string[],
  _emptyFor: (ccy: string) => FxMarketRatesBundle,
): Record<string, FxMarketRatesBundle> {
  const next = { ...marketRatesByCcy };
  for (const ccy of ccys) {
    if (ccy === 'USD') continue;
    const bundle = next[ccy];
    if (!bundle) continue;
    next[ccy] = {
      ...bundle,
      parameters: {
        ...(bundle.parameters ?? {}),
        atlasCorr: corr,
        atlasCorrAsOf: corr.asOf,
        atlasRiskFile:
          typeof bundle.parameters?.atlasRiskFile === 'string'
            ? bundle.parameters.atlasRiskFile
            : (corr.source ?? 'Market data edit'),
      },
    };
  }
  return next;
}
