import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';

export const runtime = 'nodejs';

/**
 * POST /api/tape-load — test capture sink. The ticket panel reports exactly
 * which chart it resolved (source path, key, points shift, story window,
 * point count, time span, mid range) and this prints it in the DEV SERVER
 * TERMINAL, where the desk is watching, next to the [fx-exec] lines it
 * correlates with. Dev-only diagnostics: production accepts and drops.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body: unknown = await request.json();
    if (process.env.NODE_ENV !== 'production') {
      console.info('[tape-load]', JSON.stringify(body));
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Bad payload' }, { status: 400 });
  }
}
