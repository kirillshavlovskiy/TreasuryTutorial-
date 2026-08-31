import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isTokenEncryptionConfigured } from '@/lib/treasury/crypto';
import { getTreasuryFxRatesForUser, parsePairsInput } from '@/lib/treasury/fx-rates';
import { isTreasuryMcpConfigured } from '@/lib/treasury/mcp-client';
import { isOktaConfigured } from '@/lib/treasury/okta-client';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

export const runtime = 'nodejs';

/** POST — look up live FX market rates via the Treasury Finance MCP
 *  (`fx_rate_lookup`, market pairs mode). PoC endpoint: no caching, one
 *  MCP connection per request. Requires an existing Treasury OAuth link —
 *  see app/api/treasury/oauth/connect/route.ts. */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isOktaConfigured() || !isTokenEncryptionConfigured()) {
    return NextResponse.json({ error: 'Treasury OAuth is not configured' }, { status: 501 });
  }
  // Not covered by the check above — the OAuth link can be fully configured
  // while TREASURY_MCP_URL itself is unset, which would otherwise surface
  // as a silent 'not_connected' status instead of an honest 501.
  if (!isTreasuryMcpConfigured()) {
    return NextResponse.json({ error: 'Treasury MCP is not configured (TREASURY_MCP_URL)' }, { status: 501 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const pairsInput = body && typeof body === 'object' ? (body as Record<string, unknown>).pairs : undefined;
  const parsed = parsePairsInput(pairsInput);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  return NextResponse.json(await getTreasuryFxRatesForUser(email, parsed));
}
