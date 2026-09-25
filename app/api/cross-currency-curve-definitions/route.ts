import { NextRequest } from 'next/server';
import { fetchXccyDefinitionsWithRefinitiv } from '@/lib/refinitivMarket';
import { parseXccyDefinitionsRequest } from '@/lib/refinitivXccyDefinitions';
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
    const input = parseXccyDefinitionsRequest(parsed.body);
    const token = await resolveRequestToken(req);
    const result = await fetchXccyDefinitionsWithRefinitiv(input, token);
    return Response.json(result);
  } catch (err) {
    return refinitivErrorResponse(err);
  }
}
