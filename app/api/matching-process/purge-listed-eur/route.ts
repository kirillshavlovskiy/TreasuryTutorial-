import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getMatchingRuntime } from '@/lib/test-mode/matching-process-runtime';
import { purgeListedEurOrdersFromDb } from '@/lib/test-mode/purge-listed-eur-db';

export const runtime = 'nodejs';

/**
 * POST /api/matching-process/purge-listed-eur
 * Strip the resurrecting EUR strip / option / TP-SL stack from Postgres
 * and the in-process matcher.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const runtime = getMatchingRuntime();
    const dropped =
      typeof runtime.dropListedEurOrders === 'function'
        ? runtime.dropListedEurOrders()
        : { dropped: 0, ids: [] as string[] };
    const db = await purgeListedEurOrdersFromDb();
    return NextResponse.json({
      ok: true,
      matcher: dropped,
      db,
    });
  } catch (error) {
    console.error('Error purging listed EUR orders:', error);
    return NextResponse.json(
      { error: 'Failed to purge listed EUR orders' },
      { status: 500 },
    );
  }
}
