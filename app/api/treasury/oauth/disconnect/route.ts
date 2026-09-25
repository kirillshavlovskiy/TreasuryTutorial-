import { NextResponse } from 'next/server';
import { getServerSession } from '@/auth';
import { treasuryCanonicalOrigin } from '@/lib/treasury/okta-client';
import { disconnectTreasury } from '@/lib/treasury/token-store';

export const runtime = 'nodejs';

/** POST — drop the stored Treasury OAuth link for the signed-in user. */
export async function POST(request: Request) {
  const session = await getServerSession();
  const email = session?.user?.email?.trim();
  if (!email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await disconnectTreasury(email);
  console.info('[treasury/oauth/disconnect] link removed', { email, at: new Date().toISOString() });
  // 303, not the redirect() default of 307: the form POSTs here, and the
  // target is a page route with no POST handler — 307 would preserve the
  // method and re-POST into a 405 instead of rendering the workspace.
  return NextResponse.redirect(
    new URL('/workspace?treasury=disconnected', treasuryCanonicalOrigin(request)),
    { status: 303 },
  );
}
