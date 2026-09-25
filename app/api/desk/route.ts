import { NextResponse } from 'next/server';
import { getServerSession } from '@/auth';
import {
  isDeskDatabaseAvailable,
  loadDeskState,
  saveDeskState,
} from '@/lib/db/desk-service';
import { getSandboxStorageEnv } from '@/lib/db/storage-env';
import { WORKBENCH_DESK_SCOPE, type DeskPutInput } from '@/lib/desk/types';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

export const runtime = 'nodejs';

async function requireUserEmail(): Promise<string | NextResponse> {
  const session = await getServerSession();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return email;
}

function scopeFrom(searchParams: URLSearchParams, bodyScope?: unknown): string {
  const raw =
    (typeof bodyScope === 'string' && bodyScope.trim())
    || searchParams.get('scope')
    || WORKBENCH_DESK_SCOPE;
  return raw.trim() || WORKBENCH_DESK_SCOPE;
}

/** GET — load FX / liquidity / analytics / hedge snapshots for this user. */
export async function GET(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  const { searchParams } = new URL(request.url);
  const scope = scopeFrom(searchParams);

  try {
    const snapshot = await loadDeskState(emailOrErr, scope);
    return NextResponse.json({
      ...snapshot,
      persistent: isDeskDatabaseAvailable() && snapshot.persistent,
    });
  } catch (err) {
    console.error('[api/desk] GET failed', err);
    return NextResponse.json({ error: 'Failed to load desk state' }, { status: 500 });
  }
}

/** PUT — upsert one or more desk modules and optionally append an action. */
export async function PUT(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  if (!isDeskDatabaseAvailable()) {
    return NextResponse.json(
      { error: 'Database not configured', persistent: false, storageEnv: getSandboxStorageEnv() },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as DeskPutInput & { scope?: string };
    const scope = scopeFrom(new URL(request.url).searchParams, body.scope);
    const snapshot = await saveDeskState(emailOrErr, scope, body);
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error('[api/desk] PUT failed', err);
    return NextResponse.json({ error: 'Failed to save desk state' }, { status: 500 });
  }
}
