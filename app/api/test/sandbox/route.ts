import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';
import {
  deleteSandboxProgress,
  getSandboxStorageEnv,
  isSandboxDatabaseAvailable,
  loadSandboxProgress,
  saveSandboxProgress,
} from '@/lib/test-mode/sandbox-service';
import { normalizeSandboxState, seedSandbox } from '@/lib/test-mode/store';

export const runtime = 'nodejs';

function taskIdFrom(searchParams: URLSearchParams, bodyTaskId?: unknown): string {
  const raw =
    (typeof bodyTaskId === 'string' && bodyTaskId.trim())
    || searchParams.get('taskId')
    || '01';
  return raw.trim() || '01';
}

async function requireUserEmail(): Promise<string | NextResponse> {
  const session = await auth();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return email;
}

/** GET — load persisted sandbox progress for the signed-in user. */
export async function GET(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  const { searchParams } = new URL(request.url);
  const taskId = taskIdFrom(searchParams);
  const persistent = isSandboxDatabaseAvailable();

  try {
    if (!persistent) {
      return NextResponse.json({
        state: seedSandbox(taskId),
        updatedAt: new Date(0).toISOString(),
        source: 'seed',
        persistent: false,
        storageEnv: getSandboxStorageEnv(),
      });
    }

    const record = await loadSandboxProgress(emailOrErr, taskId);
    return NextResponse.json({
      state: record.state,
      updatedAt: record.updatedAt,
      source: record.source,
      persistent: true,
      storageEnv: record.storageEnv,
    });
  } catch (err) {
    console.error('[api/test/sandbox] GET failed', err);
    return NextResponse.json(
      { error: 'Failed to load sandbox progress' },
      { status: 500 },
    );
  }
}

/** PUT — upsert sandbox progress for the signed-in user. */
export async function PUT(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  if (!isSandboxDatabaseAvailable()) {
    return NextResponse.json(
      {
        error: 'Database not configured',
        persistent: false,
      },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as { taskId?: string; state?: unknown };
    const taskId = taskIdFrom(new URL(request.url).searchParams, body.taskId);
    if (!body.state || typeof body.state !== 'object') {
      return NextResponse.json({ error: 'Missing state' }, { status: 400 });
    }

    const state = normalizeSandboxState(body.state);
    const record = await saveSandboxProgress(emailOrErr, state, taskId);
    return NextResponse.json({
      state: record.state,
      updatedAt: record.updatedAt,
      source: record.source,
      persistent: true,
      storageEnv: record.storageEnv,
    });
  } catch (err) {
    console.error('[api/test/sandbox] PUT failed', err);
    return NextResponse.json(
      { error: 'Failed to save sandbox progress' },
      { status: 500 },
    );
  }
}

/** DELETE — clear server progress (Reset sandbox). */
export async function DELETE(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  const { searchParams } = new URL(request.url);
  const taskId = taskIdFrom(searchParams);

  try {
    await deleteSandboxProgress(emailOrErr, taskId);
    return NextResponse.json({
      ok: true,
      persistent: isSandboxDatabaseAvailable(),
      storageEnv: getSandboxStorageEnv(),
    });
  } catch (err) {
    console.error('[api/test/sandbox] DELETE failed', err);
    return NextResponse.json(
      { error: 'Failed to reset sandbox progress' },
      { status: 500 },
    );
  }
}
