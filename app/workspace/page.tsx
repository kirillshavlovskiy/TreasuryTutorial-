import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { isTestModeEnabled } from '@/lib/test-mode/enabled';
import { WorkspaceApp } from './WorkspaceApp';

export default async function WorkspacePage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/');
  }

  const { name, email, image } = session.user;
  const userKey = email ?? name ?? 'default';
  const sandboxEnabled = isTestModeEnabled();

  return (
    <WorkspaceApp
      userKey={userKey}
      userName={name ?? email ?? 'there'}
      sandboxEnabled={sandboxEnabled}
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
