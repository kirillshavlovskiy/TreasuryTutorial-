import { NextResponse } from 'next/server';
import { getServerSession } from '@/auth';
import {
  appendDeskAction,
  isDeskDatabaseAvailable,
  listDeskActions,
} from '@/lib/db/desk-service';
import { WORKBENCH_DESK_SCOPE, type DeskActionInput, type DeskModule } from '@/lib/desk/types';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

export const runtime = 'nodejs';

const MODULES = new Set<DeskModule>(['workspace', 'fx', 'liquidity', 'analytics', 'hedging']);

async function requireUserEmail(): Promise<string | NextResponse> {
  const session = await getServerSession();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return email;
}

export async function GET(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get('scope')?.trim() || WORKBENCH_DESK_SCOPE;
  const moduleRaw = searchParams.get('module');
  const deskModule = MODULES.has(moduleRaw as DeskModule) ? (moduleRaw as DeskModule) : undefined;
  const limit = Number(searchParams.get('limit') ?? 100);

  try {
    const actions = await listDeskActions(emailOrErr, scope, { module: deskModule, limit });
    return NextResponse.json({
      scope,
      actions,
      persistent: isDeskDatabaseAvailable(),
    });
  } catch (err) {
    console.error('[api/desk/actions] GET failed', err);
    return NextResponse.json({ error: 'Failed to list desk actions' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  if (!isDeskDatabaseAvailable()) {
    return NextResponse.json({ error: 'Database not configured', persistent: false }, { status: 503 });
  }

  try {
    const body = (await request.json()) as DeskActionInput & { scope?: string };
    if (!body.module || !MODULES.has(body.module) || !body.action?.trim()) {
      return NextResponse.json({ error: 'module and action are required' }, { status: 400 });
    }
    const scope = body.scope?.trim() || WORKBENCH_DESK_SCOPE;
    await appendDeskAction(emailOrErr, scope, {
      module: body.module,
      action: body.action.trim(),
      dashboardId: body.dashboardId,
      scopeId: body.scopeId,
      payload: body.payload,
    });
    return NextResponse.json({ ok: true, scope });
  } catch (err) {
    console.error('[api/desk/actions] POST failed', err);
    return NextResponse.json({ error: 'Failed to record desk action' }, { status: 500 });
  }
}
