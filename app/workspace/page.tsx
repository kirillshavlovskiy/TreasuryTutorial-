import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { isTestModeEnabled } from '@/lib/test-mode/enabled';
import { getTreasurySnapshotForUser } from '@/lib/treasury/snapshot';
import { isOktaConfigured } from '@/lib/treasury/okta-client';
import { WorkspaceApp } from './WorkspaceApp';

export default async function WorkspacePage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/');
  }

  const { name, email, image } = session.user;
  const userKey = email ?? name ?? 'default';
  const sandboxEnabled = isTestModeEnabled();

  // Treasury connection is additive to the Google sign-in above — a user who
  // never connects Treasury sees exactly the static book as before.
  const treasury = email && isOktaConfigured()
    ? await getTreasurySnapshotForUser(email)
    : null;

  return (
    <WorkspaceApp
      userKey={userKey}
      userName={name ?? email ?? 'there'}
      sandboxEnabled={sandboxEnabled}
      treasuryAvailable={Boolean(email && isOktaConfigured())}
      treasury={treasury}
      accountMenu={
        <UserAvatarMenu
          name={name}
          email={email}
          image={image}
          sandboxEnabled={sandboxEnabled}
        />
      }
    />
  );
}
