import { parseToIsoDate, todayIso } from './isoDates';
import {
  parseFxSpotRequest,
  type FxSpotQuote,
} from './refinitivFxSpot';

/** Primary live majors (~60s). Pair legs go in the path and `symbols`. */
export const EXCHANGERATE_DEV_LATEST_URL =
  'https://api.exchangerate.dev/v1/latest';

/**
 * Lazy undici load for the corp-TLS fallback only.
 * Never top-level-import undici@8 — on Node <24 it throws
 * `markAsUncloneable` during module evaluation and 500s /api/fx-spot.
 */
type UndiciAgent = { connect?: { rejectUnauthorized?: boolean } };
type UndiciMod = {
  Agent: new (opts: { connect: { rejectUnauthorized: boolean } }) => UndiciAgent;
  fetch: (
    url: string,
    init?: Record<string, unknown>,
  ) => Promise<unknown>;
};
let undiciMod: UndiciMod | null | undefined;
let overlayTlsAgent: UndiciAgent | undefined;

function nodeMajorAtLeast(min: number): boolean {
  const major = Number(process.versions.node.split('.')[0]);
  return Number.isFinite(major) && major >= min;
}

function loadUndici(): UndiciMod {
  if (undiciMod) return undiciMod;
  if (undiciMod === null) {
    throw new Error(
      'undici failed to load earlier (need Node >= 24 for undici 8). Restart with nvm use 24.',
    );
  }
  if (!nodeMajorAtLeast(24)) {
    undiciMod = null;
    throw new Error(
      `undici@8 needs Node >= 24 (running ${process.versions.node}). Restart with: nvm use 24`,
    );
  }
  try {
    const id = 'undici';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    undiciMod = require(/* webpackIgnore: true */ id) as UndiciMod;
    return undiciMod;
  } catch (err) {
    undiciMod = null;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `undici unavailable (${detail}). Live FX overlay TLS fallback needs Node >= 24 (package engines).`,
    );
  }
}

function isCorporateTlsBlock(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
}

/** Public overlay hosts; retry without leaf verify after a corp TLS-inspect failure. */
async function overlayFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await globalThis.fetch(url, init);
  } catch (err) {
    if (!isCorporateTlsBlock(err)) throw err;
    const { Agent, fetch: undiciFetch } = loadUndici();
    if (!overlayTlsAgent) {
      overlayTlsAgent = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
    return (await undiciFetch(url, {
      method: init?.method,
      headers: init?.headers as HeadersInit,
      body: init?.body == null ? undefined : (init.body as BodyInit),
      signal: init?.signal,
      dispatcher: overlayTlsAgent,
    })) as unknown as Response;
  }
}



export type OverlayFxSource =
  | 'exchangerate-dev'
  | 'exchangerate-fun'
  | 'frankfurter'
  | 'open-er-api';

export interface LiveFxQuote {
  spot: number;
  base: string;
  quote: string;
  asOfDate: string;
  asOfTime?: string;
  source: OverlayFxSource;
}

export const FX_SOURCE_LABEL: Record<OverlayFxSource, string> = {
  'exchangerate-dev': 'exchangerate.dev',
  'exchangerate-fun': 'exchangerate.fun',
  frankfurter: 'Frankfurter (ECB)',
  'open-er-api': 'open.er-api.com',
};

/** GBPUSD → { base: GBP, quote: USD }; USDMXN → { base: USD, quote: MXN }. */
export function marketPairLegs(pair: string): { base: string; quote: string } {
  const raw = pair.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (raw.length !== 6) {
    throw new Error(`FX pair must be six letters, got ${pair}`);
  }
  return { base: raw.slice(0, 3), quote: raw.slice(3, 6) };
}

function getExchangeRateDevKey(): string | undefined {
  const key =
    process.env.EXCHANGERATE_DEV_API_KEY?.trim()
    || process.env.NEXT_PUBLIC_EXCHANGERATE_DEV_API_KEY?.trim();
  return key || undefined;
}

function pipFor(mid: number): number {
  return mid >= 20 ? 0.01 : 0.0001;
}

function fromUnixSeconds(sec: number): { asOfDate: string; asOfTime: string } {
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid FX timestamp');
  }
  return { asOfDate: d.toISOString().slice(0, 10), asOfTime: d.toISOString() };
}

function rateFromRecord(
  rates: Record<string, unknown> | undefined,
  quote: string,
): number {
  const spot = rates?.[quote];
  if (typeof spot !== 'number' || !(spot > 0)) {
    throw new Error(`missing ${quote} rate`);
  }
  return spot;
}

async function fromExchangeRateDev(
  base: string,
  quote: string,
): Promise<LiveFxQuote> {
  const headers: Record<string, string> = {};
  const apiKey = getExchangeRateDevKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await overlayFetch(
    `${EXCHANGERATE_DEV_LATEST_URL}/${encodeURIComponent(base)}?symbols=${encodeURIComponent(quote)}`,
    { cache: 'no-store', headers },
  );
  if (!res.ok) throw new Error(`exchangerate.dev ${res.status}`);
  const data = (await res.json()) as {
    result?: string;
    rates?: Record<string, number>;
    data_updated_at?: string;
    timestamp?: string;
  };
  if (data.result !== 'success') {
    throw new Error('exchangerate.dev missing rate');
  }
  const spot = rateFromRecord(data.rates, quote);
  const stamped = data.data_updated_at ?? data.timestamp;
  const asOfDate = parseToIsoDate(stamped) ?? todayIso();
  const asOfTime = stamped
    ? new Date(stamped).toISOString()
    : new Date().toISOString();
  if (Number.isNaN(new Date(asOfTime).getTime())) {
    throw new Error('exchangerate.dev invalid timestamp');
  }
  return { spot, base, quote, asOfDate, asOfTime, source: 'exchangerate-dev' };
}

async function fromExchangeRateFun(
  base: string,
  quote: string,
): Promise<LiveFxQuote> {
  const res = await overlayFetch(
    `https://api.exchangerate.fun/latest?base=${encodeURIComponent(base)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`exchangerate.fun ${res.status}`);
  const data = (await res.json()) as {
    timestamp?: number;
    rates?: Record<string, number>;
  };
  const spot = rateFromRecord(data.rates, quote);
  if (typeof data.timestamp !== 'number') {
    throw new Error('exchangerate.fun missing timestamp');
  }
  return {
    spot,
    base,
    quote,
    ...fromUnixSeconds(data.timestamp),
    source: 'exchangerate-fun',
  };
}

async function fromOpenErApi(
  base: string,
  quote: string,
): Promise<LiveFxQuote> {
  const res = await overlayFetch(
    `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`open.er-api ${res.status}`);
  const data = (await res.json()) as {
    result?: string;
    time_last_update_unix?: number;
    time_last_update_utc?: string;
    rates?: Record<string, number>;
  };
  if (data.result !== 'success') {
    throw new Error('open.er-api missing rate');
  }
  const spot = rateFromRecord(data.rates, quote);
  const stamped =
    typeof data.time_last_update_unix === 'number'
      ? fromUnixSeconds(data.time_last_update_unix)
      : {
          asOfDate: parseToIsoDate(data.time_last_update_utc) ?? todayIso(),
          asOfTime: undefined as string | undefined,
        };
  return { spot, base, quote, ...stamped, source: 'open-er-api' };
}

async function fromFrankfurter(
  base: string,
  quote: string,
): Promise<LiveFxQuote> {
  const res = await overlayFetch(
    `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const data = (await res.json()) as {
    date?: string;
    rates?: Record<string, number>;
  };
  const spot = rateFromRecord(data.rates, quote);
  if (!data.date) throw new Error('Frankfurter missing date');
  return {
    spot,
    base,
    quote,
    asOfDate: parseToIsoDate(data.date) ?? data.date,
    source: 'frankfurter',
  };
}

function sslHint(err: unknown): string | null {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'Network SSL blocked external FX APIs (corporate proxy).';
  }
  return null;
}

/**
 * Live FX mid from the overlay handover chain.
 * exchangerate.dev → exchangerate.fun → open.er-api.com → Frankfurter.
 */
export async function fetchLiveFxQuote(pair: string): Promise<LiveFxQuote> {
  const { base, quote } = marketPairLegs(pair);
  if (base === quote) {
    return {
      spot: 1,
      base,
      quote,
      asOfDate: todayIso(),
      asOfTime: new Date().toISOString(),
      source: 'exchangerate-dev',
    };
  }
  const attempts: Array<{ name: string; fn: () => Promise<LiveFxQuote> }> = [
    { name: 'exchangerate-dev', fn: () => fromExchangeRateDev(base, quote) },
    { name: 'exchangerate-fun', fn: () => fromExchangeRateFun(base, quote) },
    { name: 'open-er-api', fn: () => fromOpenErApi(base, quote) },
    { name: 'frankfurter', fn: () => fromFrankfurter(base, quote) },
  ];
  const errors: string[] = [];
  for (const { name, fn } of attempts) {
    try {
      return await fn();
    } catch (err) {
      const hint = sslHint(err);
      errors.push(hint ?? `${name}: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }
  throw new Error(`Live ${base}/${quote} unavailable. ${errors.join(' · ')}`);
}

export function quoteFromLiveSpot(
  live: LiveFxQuote,
  input: { ccy?: string; ric?: string; pair?: string },
): FxSpotQuote {
  const parsed = parseFxSpotRequest(input);
  const pip = pipFor(live.spot);
  return {
    ric: parsed.ric,
    pair: parsed.pair,
    bid: live.spot - pip,
    ask: live.spot + pip,
    mid: live.spot,
    asOf: live.asOfTime ?? live.asOfDate,
    source: live.source,
  };
}