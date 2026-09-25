import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getOrderExecutionModel } from '@/lib/db/models/order-execution';
import { normalizeOwnerEmail } from '@/lib/execution-log-store';

export const runtime = 'nodejs';

/**
 * GET /api/order-execution?orderId=<id>&taskId=<task>
 * One call audits one executed order: its execution prints, the ticket as
 * it was at fill time (snapshot on the execution row — the sandbox book is
 * current-state and cannot answer for cleared orders), and the recorded
 * tape for the ticket's own key over the order's story window
 * (placement instant → last fill + tail).
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const searchParams = request.nextUrl.searchParams;
    const orderId = searchParams.get('orderId');
    if (!orderId) {
      return NextResponse.json(
        { error: 'Missing required query parameter: orderId' },
        { status: 400 },
      );
    }
    const taskIdRaw = searchParams.get('taskId') ?? 'workspace';
    const taskId = /^[A-Za-z0-9_-]{1,32}$/.test(taskIdRaw)
      ? taskIdRaw
      : 'workspace';
    const { loadExecutedOrderDetail } = await import(
      '@/lib/test-mode/matching-process-persist'
    );
    const detail = await loadExecutedOrderDetail(
      normalizeOwnerEmail(session.user.email),
      taskId,
      orderId,
    );
    if (!detail) {
      return NextResponse.json(
        {
          error:
            'No execution recorded for that orderId on your desk. Executions '
            + 'recorded before 2026-09-23 carry no owner and are not shown.',
        },
        { status: 404 },
      );
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error('Error fetching order execution:', error);
    return NextResponse.json(
      { error: 'Failed to fetch order execution' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/order-execution
 * Records an order execution (called by the matching service).
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const OrderExecution = await getOrderExecutionModel();
    if (!OrderExecution) {
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 503 },
      );
    }

    const body = await request.json();
    const { orderId, executedAt, price, fill } = body;

    if (!orderId || executedAt === undefined || price === undefined || !fill) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 },
      );
    }

    if (typeof executedAt !== 'number' || typeof price !== 'number') {
      return NextResponse.json(
        { error: 'Invalid field types' },
        { status: 400 },
      );
    }

    if (fill !== 'bid' && fill !== 'ask') {
      return NextResponse.json(
        { error: 'fill must be "bid" or "ask"' },
        { status: 400 },
      );
    }

    // Use upsert for idempotency: if (orderId, executedAt) already exists for
    // this desk, return the existing record. The owner comes from the session,
    // never the body, so a caller can only ever write rows it can read back.
    const [execution, created] = await OrderExecution.findOrCreate({
      where: {
        orderId,
        executedAt,
        userEmail: normalizeOwnerEmail(session.user.email),
      },
      defaults: { price, fill },
    });

    return NextResponse.json({ success: true, executionId: execution.id, created });
  } catch (error) {
    console.error('Error recording order execution:', error);
    return NextResponse.json(
      { error: 'Failed to record order execution' },
      { status: 500 },
    );
  }
}
