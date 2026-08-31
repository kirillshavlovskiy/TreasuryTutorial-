import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { isTestModeEnabled } from '@/lib/test-mode/enabled';
import { MAX_PAIRS } from '@/lib/treasury/fx-rates';
import { isOktaConfigured } from '@/lib/treasury/okta-client';
import { RatesApp } from './RatesApp';

/** PoC: live FX market rates via the Treasury Finance MCP (fx_rate_lookup).
 *  See docs/architecture.md and lib/treasury/fx-rates.ts. */
export default async function TreasuryRatesPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/');
  }

  const { name, email, image } = session.user;
  const sandboxEnabled = isTestModeEnabled();

  return (
    <RatesApp
      sandboxEnabled={sandboxEnabled}
      treasuryAvailable={Boolean(email && isOktaConfigured())}
      maxPairs={MAX_PAIRS}
      accountMenu={
        <UserAvatarMenu name={name} email={email} image={image} sandboxEnabled={sandboxEnabled} />
      }
    />
  );
}
