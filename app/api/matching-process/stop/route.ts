import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getMatchingRuntime } from '@/lib/test-mode/matching-process-runtime';

export const runtime = 'nodejs';

/**
 * POST /api/matching-process/stop
 * Stops the in-process Node matching engine.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const runtime = getMatchingRuntime();
    runtime.stop();
    return NextResponse.json({
      success: true,
      ...runtime.heartbeat(session.user.email),
    });
  } catch (error) {
    console.error('Error stopping matching process:', error);
    return NextResponse.json(
      { error: 'Failed to stop matching process' },
      { status: 500 },
    );
  }
}
