import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { spotDayCandlesFor } from '@/lib/fx-spot-tape';
import { parseFxSpotRequest } from '@/lib/refinitivFxSpot';
import {
  SPOT_DAY_MAX_WINDOW_MS,
  SPOT_DAY_RECORD_BAR_SEC,
  SPOT_DAY_SOURCE,
  isSpotDayStoreBarSec,
  type SpotDayCandlesPayload,
  type SpotDayStoreBarSec,
} from '@/lib/test-mode/tape-candles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/fx-spot/candles?ccy=EUR&fromMs=<unix ms>&toMs=<unix ms>&barSec=1|5|15|30|60
 *
 * OHLC day record of the shared spot tape for one currency — the same series
 * /api/fx-spot serves and the matcher fills against — over a window of at
 * most 48h. `barSec` defaults to 60 (1m). Rates are INTERNAL data: session
 * first, and the query carries only a currency code, a time window and a
 * bar length.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = request.nextUrl.searchParams;
  const ccy = (params.get('ccy') ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(ccy) || ccy === 'USD') {
    return NextResponse.json(
      { error: 'ccy must be a three-letter currency code other than USD' },
      { status: 400 },
    );
  }
  const fromMs = Number(params.get('fromMs'));
  const toRaw = params.get('toMs');
  const toMs = toRaw == null ? Date.now() : Number(toRaw);
  if (
    !Number.isSafeInteger(fromMs)
    || !Number.isSafeInteger(toMs)
    || fromMs <= 0
    || toMs <= fromMs
    || toMs - fromMs > SPOT_DAY_MAX_WINDOW_MS
  ) {
    return NextResponse.json(
      { error: 'fromMs/toMs must be unix milliseconds spanning at most 48 hours' },
      { status: 400 },
    );
  }
  const barSecRaw = params.get('barSec');
  let barSec: SpotDayStoreBarSec = SPOT_DAY_RECORD_BAR_SEC;
  if (barSecRaw != null && barSecRaw !== '') {
    const parsed = Number(barSecRaw);
    if (!isSpotDayStoreBarSec(parsed)) {
      return NextResponse.json(
        { error: 'barSec must be 1, 5, 15, 30 or 60' },
        { status: 400 },
      );
    }
    barSec = parsed;
  }
  try {
    const { pair } = parseFxSpotRequest({ ccy });
    const record = await spotDayCandlesFor(pair, fromMs, toMs, barSec);
    const body: SpotDayCandlesPayload = {
      pair,
      currency: ccy,
      barSec,
      source: SPOT_DAY_SOURCE,
      fromMs,
      toMs,
      candles: record.candles,
      forming: record.forming,
      serverNowMs: Date.now(),
      persisted: record.persisted,
      warning: record.warning,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(
      `[fx-spot] day record read failed for ${ccy}`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: 'Day record unavailable' }, { status: 500 });
  }
}
