import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  isProgressDatabaseAvailable,
  listUserProgress,
  listUserProgressEvents,
  loadUserProgress,
} from '@/lib/db/progress-service';
import { getSandboxStorageEnv } from '@/lib/db/storage-env';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

export const runtime = 'nodejs';

async function requireUserEmail(): Promise<string | NextResponse> {
  const session = await auth();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return email;
}

/** GET — list curriculum/practice progress, or one task plus its event log. */
export async function GET(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId')?.trim() ?? '';
  const persistent = isProgressDatabaseAvailable();
  const storageEnv = getSandboxStorageEnv();

  try {
    if (!persistent) {
      return NextResponse.json({
        tasks: [],
        events: [],
        persistent: false,
        storageEnv,
      });
    }

    if (taskId) {
      const [record, events] = await Promise.all([
        loadUserProgress(emailOrErr, taskId),
        listUserProgressEvents(emailOrErr, taskId),
      ]);
      return NextResponse.json({
        task: record,
        tasks: record ? [record] : [],
        events,
        persistent: true,
        storageEnv,
      });
    }

    const tasks = await listUserProgress(emailOrErr);
    return NextResponse.json({
      tasks,
      events: [],
      persistent: true,
      storageEnv,
    });
  } catch (err) {
    console.error('[api/test/progress] GET failed', err);
    return NextResponse.json(
      { error: 'Failed to load user progress' },
      { status: 500 },
    );
  }
}
