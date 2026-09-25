import { NextResponse } from 'next/server';
import { getServerSession } from '@/auth';
import {
  computeEfficientFrontier,
  parseEfficientFrontierRequest,
} from '@/lib/test-mode/efficient-frontier-job';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST — run the Liquidity efficient-frontier package on the server.
 *
 * The Σ⁻¹μ overlay, book-scale arm, Total-Carry lift, and per-regime remaps
 * used to run in the browser. They live here so the calc walk prints in the
 * Next.js terminal (`[efficient-frontier] …`).
 */
export async function POST(request: Request) {
  const session = await getServerSession();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const parsed = parseEfficientFrontierRequest(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = computeEfficientFrontier(parsed.request, { log: true });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store, no-transform' },
    });
  } catch (err) {
    console.error('[api/test/efficient-frontier] compute failed', err);
    return NextResponse.json(
      { error: 'Efficient frontier calculation failed' },
      { status: 500 },
    );
  }
}
