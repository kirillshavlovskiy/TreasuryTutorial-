import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isTestModeEnabled, TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';
import { Task01AppLoader } from '@/app/test/tasks/Task01AppLoader';

export default async function TaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  if (!isTestModeEnabled()) redirect('/');
  const session = await auth();
  const email = session?.user?.email ?? '';
  // Practice sandbox requires a real Google login (no guest).
  if (!email || email === TEST_GUEST_EMAIL) redirect('/test');

  const { taskId } = await params;
  if (taskId !== '01') notFound();

  return <Task01AppLoader userKey={`test:${email}`} />;
}
