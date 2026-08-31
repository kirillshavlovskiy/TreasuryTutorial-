import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  computeFxAtlasJob,
  parseFxAtlasJobRequest,
} from '@/lib/test-mode/fx-atlas-job';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST — run Group FX VaR Optimize (quant-fx-sigma tenor strip + frontier)
 * on the server.
 */
export async function POST(request: Request) {
  const session = await auth();
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

  const parsed = parseFxAtlasJobRequest(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = computeFxAtlasJob(parsed.request, { log: true });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store, no-transform' },
    });
  } catch (err) {
    console.error('[quant-fx-sigma] compute failed', err);
    return NextResponse.json(
      { error: 'Frontier calculation failed' },
      { status: 500 },
    );
  }
}
