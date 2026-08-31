import { NextRequest } from 'next/server';
import { parseForwardCurvesRequest } from '@/lib/refinitivForwardCurves';
import { fetchForwardCurvesWithRefinitiv } from '@/lib/refinitivMarket';
import {
  authStatusJson,
  readJsonBody,
  refinitivErrorResponse,
  resolveRequestToken,
} from '@/lib/refinitivRoute';

export const maxDuration = 60;

export async function GET() {
  return authStatusJson();
}

export async function POST(req: NextRequest) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  try {
    const input = parseForwardCurvesRequest(parsed.body);
    const token = await resolveRequestToken(req);
    const result = await fetchForwardCurvesWithRefinitiv(input, token);
    return Response.json(result);
  } catch (err) {
    return refinitivErrorResponse(err);
  }
}
