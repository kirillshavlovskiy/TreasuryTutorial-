import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ensureMatchingProcess } from '@/lib/test-mode/matching-process-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/matching-process/status
 * Live Node matching engine + last persisted tape tick.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const runtime = await ensureMatchingProcess();
    const hb = runtime.heartbeat(session.user.email);
    return NextResponse.json(hb);
  } catch (error) {
    console.error('Error fetching matching process status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch status' },
      { status: 500 },
    );
  }
}
