import { usdMarketPair } from '@/lib/fx-market-rates';
import {
  asFiniteNumber,
  asString,
  getRefinitivJson,
  isRecord,
  RefinitivHttpError,
} from '@/lib/refinitivHttp';

/** RW Mobile FX spot (the desk's live print). RIC is path-encoded, e.g. EUR=. */
export const REFINITIV_FX_SPOT_URL =
  'https://api.refinitiv.com/user-framework/mobile/fx-service/v1/fx/spot/price';

/** Documented RDP snapshot — used when the mobile FX service is not entitled. */
export const REFINITIV_PRICING_SNAPSHOTS_URL =
  'https://api.refinitiv.com/data/pricing/snapshots/v1';

export type FxSpotQuote = {
  ric: string;
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  asOf: string | null;
  source: 'fx-service' | 'pricing-snapshot' | 'exchangerate-dev' | 'exchangerate-fun' | 'frankfurter' | 'open-er-api';
  /** True when bid/ask are a Brownian walk around the last overlay print. */
  simulated?: boolean;
};

const BID_KEYS = [
  'bid',
  'bidprice',
  'bidrate',
  'bidpx',
  'bid_price',
  'bestbid',
];
const ASK_KEYS = [
  'ask',
  'askprice',
  'askrate',
  'askpx',
  'ask_price',
  'offer',
  'bestask',
  'bestoffer',
];
const MID_KEYS = [
  'mid',
  'midprice',
  'mid_price',
  'midrate',
  'primact_1',
  'last',
  'close',
];

/** Spot RIC vs USD: EURUSD → EUR=, USDPLN → PLN=. */
export function fxSpotRicForCcy(ccyOrPair: string): string {
  const raw = ccyOrPair.trim().toUpperCase().replace(/[^A-Z0-9=]/g, '');
  if (!raw) return 'EUR=';
  if (raw.endsWith('=')) return raw;
  if (raw.length === 6) {
    const a = raw.slice(0, 3);
    const b = raw.slice(3, 6);
    if (b === 'USD' && a !== 'USD') return `${a}=`;
    if (a === 'USD' && b !== 'USD') return `${b}=`;
  }
  if (raw === 'USD') return 'EUR=';
  return `${raw.slice(0, 3)}=`;
}

export function parseFxSpotRequest(input: {
  ccy?: string;
  ric?: string;
  pair?: string;
}): { ric: string; pair: string; ccy: string } {
  const ricIn = asString(input.ric);
  const ccyIn = asString(input.ccy);
  const pairIn = asString(input.pair);
  const ric = fxSpotRicForCcy(ricIn || ccyIn || pairIn || 'EUR');
  const fcy = ric.replace(/=+$/, '').slice(0, 3);
  const pair = pairIn?.replace('/', '').toUpperCase() || usdMarketPair(fcy);
  return { ric, pair, ccy: fcy };
}

function pipFor(mid: number): number {
  return mid >= 20 ? 0.01 : 0.0001;
}

function completeQuote(
  bid: number | undefined,
  ask: number | undefined,
  mid: number | undefined,
): { bid: number; ask: number; mid: number } | null {
  let b = bid;
  let a = ask;
  let m = mid;
  if (m == null && b != null && a != null) m = (b + a) / 2;
  if (m == null && b != null) m = b;
  if (m == null && a != null) m = a;
  if (m == null || !(m > 0)) return null;
  const pip = pipFor(m);
  if (b == null) b = a != null && a > 0 ? Math.min(a, m) : m - pip;
  if (a == null) a = b > 0 ? Math.max(b, m) : m + pip;
  if (!(b > 0) || !(a > 0)) return null;
  if (a < b) {
    const swap = a;
    a = b;
    b = swap;
  }
  return { bid: b, ask: a, mid: m };
}

function keyNorm(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function numFromKeys(
  rec: Record<string, unknown>,
  names: readonly string[],
): number | undefined {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(rec)) map.set(keyNorm(k), v);
  for (const name of names) {
    const n = asFiniteNumber(map.get(name));
    if (n != null && n > 0) return n;
  }
  return undefined;
}

function asOfFrom(rec: Record<string, unknown>): string | null {
  for (const key of [
    'asOf',
    'asOfDate',
    'timestamp',
    'time',
    'quoteTime',
    'valueDate',
    'tradedTime',
  ]) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v) && v > 1e12) {
      return new Date(v).toISOString();
    }
  }
  return null;
}

function quoteFromRecord(
  rec: Record<string, unknown>,
): { bid: number; ask: number; mid: number; asOf: string | null } | null {
  const fields = isRecord(rec.fields)
    ? rec.fields
    : isRecord(rec.Fields)
      ? rec.Fields
      : rec;
  const completed = completeQuote(
    numFromKeys(fields, BID_KEYS),
    numFromKeys(fields, ASK_KEYS),
    numFromKeys(fields, MID_KEYS),
  );
  if (!completed) return null;
  return { ...completed, asOf: asOfFrom(rec) ?? asOfFrom(fields) };
}

/** Walk a few nested objects/arrays for bid/ask — mobile + snapshot payloads. */
export function parseFxSpotPrice(
  payload: unknown,
  ric: string,
  pair: string,
  source: FxSpotQuote['source'],
): FxSpotQuote {
  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur == null || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur.slice(0, 12)) queue.push(item);
      continue;
    }
    if (!isRecord(cur)) continue;
    const hit = quoteFromRecord(cur);
    if (hit) {
      return {
        ric: asString(cur.ric) || asString(cur.RIC) || ric,
        pair,
        bid: hit.bid,
        ask: hit.ask,
        mid: hit.mid,
        asOf: hit.asOf,
        source,
      };
    }
    for (const key of [
      'data',
      'Data',
      'quote',
      'Quote',
      'price',
      'Price',
      'prices',
      'spot',
      'Spot',
      'universe',
      'headers',
    ]) {
      if (key in cur) queue.push(cur[key]);
    }
    if (seen.size > 40) break;
  }
  throw new Error(`Refinitiv FX spot for ${ric} had no bid/ask`);
}

export async function fetchFxSpotWithRefinitiv(
  input: { ccy?: string; ric?: string; pair?: string },
  accessToken: string,
): Promise<FxSpotQuote> {
  const { ric, pair } = parseFxSpotRequest(input);
  const mobileUrl = `${REFINITIV_FX_SPOT_URL}/${encodeURIComponent(ric)}`;
  try {
    const payload = await getRefinitivJson(mobileUrl, accessToken);
    return parseFxSpotPrice(payload, ric, pair, 'fx-service');
  } catch (err) {
    const snapshotUrl =
      `${REFINITIV_PRICING_SNAPSHOTS_URL}/${encodeURIComponent(ric)}`
      + '?fields=BID,ASK,MID_PRICE';
    try {
      const payload = await getRefinitivJson(snapshotUrl, accessToken);
      return parseFxSpotPrice(payload, ric, pair, 'pricing-snapshot');
    } catch (fallback) {
      if (err instanceof RefinitivHttpError) throw err;
      throw fallback;
    }
  }
}
