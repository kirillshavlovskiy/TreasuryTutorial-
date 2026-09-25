import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getTapeTickModel } from '@/lib/db/models/tape-tick';
import { Op } from 'sequelize';

export const runtime = 'nodejs';

/**
 * GET /api/tape-history?ccy=EUR&since=<timestamp>&limit=1000
 * Returns tape history (bid/ask/mid quotes) for a specific currency.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const TapeTick = await getTapeTickModel();
    if (!TapeTick) {
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 503 },
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const ccy = searchParams.get('ccy');
    const sinceStr = searchParams.get('since');
    const limitStr = searchParams.get('limit') || '1000';

    if (!ccy) {
      return NextResponse.json(
        { error: 'Missing required query parameter: ccy' },
        { status: 400 },
      );
    }

    const limit = Math.min(parseInt(limitStr), 10000);
    const where: Record<string, unknown> = { ccy };

    if (sinceStr) {
      const since = parseInt(sinceStr);
      if (!Number.isNaN(since)) {
        where.timestamp = { [Op.gte]: since };
      }
    }

    const ticks = await TapeTick.findAll({
      where,
      order: [['timestamp', 'ASC']],
      limit,
      raw: true,
    });

    return NextResponse.json({
      ccy,
      count: ticks.length,
      ticks: ticks.map((t) => ({
        timestamp: t.timestamp,
        bid: parseFloat(String(t.bid)),
        ask: parseFloat(String(t.ask)),
        mid: parseFloat(String(t.mid)),
      })),
    });
  } catch (error) {
    console.error('Error fetching tape history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tape history' },
      { status: 500 },
    );
  }
}
