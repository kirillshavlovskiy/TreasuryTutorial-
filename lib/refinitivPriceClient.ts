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

export const PRICE_API_PATH = '/api/price';
export const FORWARD_CURVES_API_PATH = '/api/forward-curves';
export const SURFACES_API_PATH = '/api/surfaces';
export const REFINITIV_TOKEN_STORAGE_KEY = 'fx-test.refinitivToken';

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
    const trimmed = token.trim();
    if (trimmed) sessionStorage.setItem(REFINITIV_TOKEN_STORAGE_KEY, trimmed);
    else sessionStorage.removeItem(REFINITIV_TOKEN_STORAGE_KEY);
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
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `Request failed (${res.status})`;
    throw new Error(message);
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
