import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ensureMatchingProcess } from '@/lib/test-mode/matching-process-runtime';

export const runtime = 'nodejs';

/**
 * POST /api/matching-process/start
 * Starts the in-process Node matching engine (tape + fills).
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const runtime = await ensureMatchingProcess();
    return NextResponse.json({
      success: true,
      ...runtime.heartbeat(session.user.email),
    });
  } catch (error) {
    console.error('Error starting matching process:', error);
    return NextResponse.json(
      { error: 'Failed to start matching process' },
      { status: 500 },
    );
  }
}
