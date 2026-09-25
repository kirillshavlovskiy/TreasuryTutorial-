import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { fetchAndWalkFxSpot, markFxSpotInterest } from '@/lib/fx-spot-tape';
import { parseFxSpotRequest } from '@/lib/refinitivFxSpot';
import { authStatusJson } from '@/lib/refinitivRoute';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // This route now feeds the shared walk the matcher fills against (and
  // drives outbound live-feed fetches) — session first.
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const ccy = req.nextUrl.searchParams.get('ccy') ?? undefined;
  const ric = req.nextUrl.searchParams.get('ric') ?? undefined;
  const pair = req.nextUrl.searchParams.get('pair') ?? undefined;
  if (!ccy && !ric && !pair) return authStatusJson();
  try {
    const input = parseFxSpotRequest({ ccy, ric, pair });
    // An open ticket polling here keeps the pair's live refresh on the fast cadence.
    markFxSpotInterest(input.pair);
    return Response.json(await fetchAndWalkFxSpot(input));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Live FX spot failed';
    return Response.json({ error: message }, { status: 502 });
  }
}