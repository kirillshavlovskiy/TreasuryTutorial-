import { NextRequest } from 'next/server';
import { fetchVolSurfacesWithRefinitiv } from '@/lib/refinitivMarket';
import { parseVolSurfacesRequest } from '@/lib/refinitivVolSurfaces';
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
    const input = parseVolSurfacesRequest(parsed.body);
    const token = await resolveRequestToken(req);
    const result = await fetchVolSurfacesWithRefinitiv(input, token);
    return Response.json(result);
  } catch (err) {
    return refinitivErrorResponse(err);
  }
}
