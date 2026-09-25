import {
  buildQasRequest,
  type PriceContractsInput,
  type PriceContractsResult,
} from '@/lib/refinitivContracts';
import {
  buildForwardCurvesRequest,
  type ForwardCurvesInput,
  type ForwardCurvesResult,
} from '@/lib/refinitivForwardCurves';
import {
  buildVolSurfacesRequest,
  type VolSurfacesInput,
  type VolSurfacesResult,
} from '@/lib/refinitivVolSurfaces';
import {
  buildXccyCurvesRequest,
  type XccyCurvesInput,
  type XccyCurvesResult,
} from '@/lib/refinitivCrossCurrencyCurves';
import {
  buildXccyDefinitionsRequest,
  type XccyDefinitionsInput,
  type XccyDefinitionsResult,
} from '@/lib/refinitivXccyDefinitions';
import type { FxSpotQuote } from '@/lib/refinitivFxSpot';
import {
  isSpotDayCandle,
  type SpotDayCandlesPayload,
} from '@/lib/test-mode/tape-candles';

export const PRICE_API_PATH = '/api/price';
export const FORWARD_CURVES_API_PATH = '/api/forward-curves';
export const SURFACES_API_PATH = '/api/surfaces';
export const XCCY_CURVES_API_PATH = '/api/cross-currency-curves';
export const XCCY_DEFINITIONS_API_PATH = '/api/cross-currency-curve-definitions';
export const FX_SPOT_API_PATH = '/api/fx-spot';
export const REFINITIV_TOKEN_STORAGE_KEY = 'fx-test.refinitivToken';
export const REFINITIV_TOKEN_EXPIRED_EVENT = 'fx-test.refinitiv-token-expired';
export const REFINITIV_TOKEN_SAVED_EVENT = 'fx-test.refinitiv-token-saved';

export function stripRefinitivBearer(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, '').trim();
}

export function isRefinitivTokenExpiredMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('access token has expired')
    || m.includes('paste a fresh bearer')
    || (m.includes('token') && m.includes('expired'))
  );
}

export function requestRefinitivTokenModal(reason?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(REFINITIV_TOKEN_EXPIRED_EVENT, { detail: reason ?? '' }),
  );
}

export function readSessionRefinitivToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return sessionStorage.getItem(REFINITIV_TOKEN_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function writeSessionRefinitivToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = stripRefinitivBearer(token);
    if (trimmed) sessionStorage.setItem(REFINITIV_TOKEN_STORAGE_KEY, trimmed);
    else sessionStorage.removeItem(REFINITIV_TOKEN_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(REFINITIV_TOKEN_SAVED_EVENT));
  } catch {
    /* ignore quota / private mode */
  }
}

export async function fetchRefinitivAuthStatus(): Promise<{
  authConfigured: boolean;
  tokenExpired: boolean;
}> {
  const res = await fetch(FORWARD_CURVES_API_PATH, { cache: 'no-store' });
  if (!res.ok) return { authConfigured: false, tokenExpired: false };
  const body = (await res.json()) as {
    authConfigured?: boolean;
    tokenExpired?: boolean;
  };
  return {
    authConfigured: Boolean(body.authConfigured),
    tokenExpired: Boolean(body.tokenExpired),
  };
}

function throwRefinitivClientError(
  status: number,
  payload: { error?: string; tokenExpired?: boolean } | null,
  fallback = 'Request failed',
): never {
  const message =
    payload && typeof payload === 'object' && typeof payload.error === 'string'
      ? payload.error
      : `${fallback} (${status})`;
  throw new Error(message);
}

async function postMarketJson<T extends object>(
  path: string,
  body: unknown,
  accessToken: string | undefined,
  guard: (payload: unknown) => payload is T,
  missing: string,
): Promise<T> {
  const token = (accessToken ?? readSessionRefinitivToken()).trim();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | { error?: string }
    | null;
  if (!res.ok) {
    throwRefinitivClientError(res.status, payload);
  }
  if (!guard(payload)) throw new Error(missing);
  return payload;
}

export async function priceWithRefinitiv(
  input: PriceContractsInput,
  accessToken?: string,
): Promise<PriceContractsResult> {
  return postMarketJson(
    PRICE_API_PATH,
    buildQasRequest(input),
    accessToken,
    (payload): payload is PriceContractsResult =>
      Boolean(
        payload
        && typeof payload === 'object'
        && 'quotes' in payload
        && Array.isArray(payload.quotes),
      ),
    'Pricing response was missing quotes',
  );
}

export async function fetchForwardCurves(
  input: ForwardCurvesInput,
  accessToken?: string,
): Promise<ForwardCurvesResult> {
  return postMarketJson(
    FORWARD_CURVES_API_PATH,
    buildForwardCurvesRequest(input),
    accessToken,
    (payload): payload is ForwardCurvesResult =>
      Boolean(
        payload
        && typeof payload === 'object'
        && 'curves' in payload
        && Array.isArray(payload.curves),
      ),
    'Forward-curves response was missing curves',
  );
}

export async function fetchXccyDefinitions(
  input: XccyDefinitionsInput,
  accessToken?: string,
): Promise<XccyDefinitionsResult> {
  return postMarketJson(
    XCCY_DEFINITIONS_API_PATH,
    buildXccyDefinitionsRequest(input),
    accessToken,
    (payload): payload is XccyDefinitionsResult =>
      Boolean(
        payload
        && typeof payload === 'object'
        && 'rows' in payload
        && Array.isArray(payload.rows),
      ),
    'Curve-definitions response was missing rows',
  );
}

export async function fetchXccyCurves(
  input: XccyCurvesInput,
  accessToken?: string,
): Promise<XccyCurvesResult> {
  return postMarketJson(
    XCCY_CURVES_API_PATH,
    buildXccyCurvesRequest(input),
    accessToken,
    (payload): payload is XccyCurvesResult =>
      Boolean(
        payload
        && typeof payload === 'object'
        && 'curves' in payload
        && Array.isArray(payload.curves),
      ),
    'Cross-currency-curves response was missing curves',
  );
}

export async function fetchVolSurfaces(
  input: VolSurfacesInput,
  accessToken?: string,
): Promise<VolSurfacesResult> {
  return postMarketJson(
    SURFACES_API_PATH,
    buildVolSurfacesRequest(input),
    accessToken,
    (payload): payload is VolSurfacesResult =>
      Boolean(
        payload
        && typeof payload === 'object'
        && 'surfaces' in payload
        && Array.isArray(payload.surfaces),
      ),
    'Surfaces response was missing surfaces',
  );
}

export async function fetchFxSpot(
  input: { ccy?: string; ric?: string; pair?: string },
  accessToken?: string,
): Promise<FxSpotQuote> {
  const token = (accessToken ?? readSessionRefinitivToken()).trim();
  const params = new URLSearchParams();
  if (input.ccy) params.set('ccy', input.ccy);
  if (input.ric) params.set('ric', input.ric);
  if (input.pair) params.set('pair', input.pair);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FX_SPOT_API_PATH}?${params.toString()}`, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  const payload = (await res.json().catch(() => null)) as
    | (FxSpotQuote & { error?: string })
    | { error?: string }
    | null;
  if (!res.ok) {
    throwRefinitivClientError(res.status, payload, 'Live FX spot failed');
  }
  if (
    !payload
    || typeof payload !== 'object'
    || typeof (payload as FxSpotQuote).bid !== 'number'
    || typeof (payload as FxSpotQuote).ask !== 'number'
  ) {
    throw new Error('Live FX spot response was missing bid/ask');
  }
  return payload as FxSpotQuote;
}

export const FX_SPOT_CANDLES_API_PATH = '/api/fx-spot/candles';

/** Today's spot day record for one currency — see GET /api/fx-spot/candles. */
export async function fetchFxSpotDayCandles(input: {
  ccy: string;
  fromMs: number;
  toMs: number;
  barSec?: number;
}): Promise<SpotDayCandlesPayload> {
  const params = new URLSearchParams({
    ccy: input.ccy,
    fromMs: String(Math.floor(input.fromMs)),
    toMs: String(Math.floor(input.toMs)),
  });
  if (input.barSec != null) params.set('barSec', String(input.barSec));
  const res = await fetch(`${FX_SPOT_CANDLES_API_PATH}?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const payload = (await res.json().catch(() => null)) as
    | (SpotDayCandlesPayload & { error?: string })
    | { error?: string }
    | null;
  if (!res.ok) {
    throw new Error(
      payload?.error || `Day record request failed (${res.status})`,
    );
  }
  if (
    !payload
    || typeof payload !== 'object'
    || !Array.isArray((payload as SpotDayCandlesPayload).candles)
  ) {
    throw new Error('Day record response was missing candles');
  }
  const record = payload as SpotDayCandlesPayload;
  // A bar that does not parse is dropped, never the whole record — the chart
  // must keep drawing what is sound.
  return {
    ...record,
    candles: record.candles.filter(isSpotDayCandle),
    forming:
      record.forming != null && isSpotDayCandle(record.forming)
        ? record.forming
        : null,
  };
}
