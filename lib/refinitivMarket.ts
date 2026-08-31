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
  REFINITIV_SURFACES_URL,
  buildVolSurfacesRequest,
  parseVolSurfacesResponse,
  type VolSurfacesInput,
  type VolSurfacesResult,
} from '@/lib/refinitivVolSurfaces';

export { RefinitivHttpError } from '@/lib/refinitivHttp';

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
