import {
  REFINITIV_QAS_URL,
  buildQasRequest,
  parseQasResponse,
  type PriceContractsInput,
  type PriceContractsResult,
} from '@/lib/refinitivContracts';
import {
  REFINITIV_FORWARD_CURVES_URL,
  buildForwardCurvesRequest,
  parseForwardCurvesResponse,
  type ForwardCurvesInput,
  type ForwardCurvesResult,
} from '@/lib/refinitivForwardCurves';
import { postRefinitivJson } from '@/lib/refinitivHttp';
import {
  REFINITIV_XCCY_CURVES_URL,
  buildXccyCurvesRequest,
  parseXccyCurvesResponse,
  type XccyCurvesInput,
  type XccyCurvesResult,
} from '@/lib/refinitivCrossCurrencyCurves';
import {
  REFINITIV_XCCY_DEFINITIONS_URL,
  buildXccyDefinitionsRequest,
  parseXccyDefinitionsResponse,
  type XccyDefinitionsInput,
  type XccyDefinitionsResult,
} from '@/lib/refinitivXccyDefinitions';
import {
  REFINITIV_SURFACES_URL,
  buildVolSurfacesRequest,
  parseVolSurfacesResponse,
  type VolSurfacesInput,
  type VolSurfacesResult,
} from '@/lib/refinitivVolSurfaces';
import {
  fetchFxSpotWithRefinitiv,
  type FxSpotQuote,
} from '@/lib/refinitivFxSpot';

export { RefinitivHttpError } from '@/lib/refinitivHttp';
export { fetchFxSpotWithRefinitiv };
export type { FxSpotQuote };

export async function priceFxOptionsWithRefinitiv(
  input: PriceContractsInput,
  accessToken: string,
): Promise<PriceContractsResult> {
  const payload = await postRefinitivJson(
    REFINITIV_QAS_URL,
    accessToken,
    buildQasRequest(input),
  );
  return parseQasResponse(payload, input.valuationDate);
}

export async function fetchForwardCurvesWithRefinitiv(
  input: ForwardCurvesInput,
  accessToken: string,
): Promise<ForwardCurvesResult> {
  const payload = await postRefinitivJson(
    REFINITIV_FORWARD_CURVES_URL,
    accessToken,
    buildForwardCurvesRequest(input),
  );
  return parseForwardCurvesResponse(payload);
}

export async function fetchXccyCurvesWithRefinitiv(
  input: XccyCurvesInput,
  accessToken: string,
): Promise<XccyCurvesResult> {
  const payload = await postRefinitivJson(
    REFINITIV_XCCY_CURVES_URL,
    accessToken,
    buildXccyCurvesRequest(input),
  );
  return parseXccyCurvesResponse(payload);
}

export async function fetchXccyDefinitionsWithRefinitiv(
  input: XccyDefinitionsInput,
  accessToken: string,
): Promise<XccyDefinitionsResult> {
  const payload = await postRefinitivJson(
    REFINITIV_XCCY_DEFINITIONS_URL,
    accessToken,
    buildXccyDefinitionsRequest(input),
  );
  return parseXccyDefinitionsResponse(payload);
}

export async function fetchVolSurfacesWithRefinitiv(
  input: VolSurfacesInput,
  accessToken: string,
): Promise<VolSurfacesResult> {
  const payload = await postRefinitivJson(
    REFINITIV_SURFACES_URL,
    accessToken,
    buildVolSurfacesRequest(input),
  );
  return parseVolSurfacesResponse(payload);
}
