import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isTestModeEnabled, TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';
import { Task01AppLoader } from '@/app/test/tasks/Task01AppLoader';

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  if (!isTestModeEnabled()) redirect('/');
  const session = await auth();
  const email = session?.user?.email ?? '';
  // Practice sandbox requires a real Google login (no guest).
  if (!email || email === TEST_GUEST_EMAIL) redirect('/test');

  const { taskId } = await params;
  if (taskId !== '01') notFound();

  const sp = await searchParams;
  const practice = sp.mode === 'practice';
  const mode = practice ? 'practice' : 'curriculum';
  // Separate local + server slots so curriculum Validate progress stays intact.
  const storageTaskId = practice ? 'practice' : '01';
  const userKey = practice ? `test:${email}:practice` : `test:${email}`;

  return (
    <Task01AppLoader userKey={userKey} mode={mode} taskId={storageTaskId} />
  );
}
