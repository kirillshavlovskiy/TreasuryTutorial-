'use client';

import dynamic from 'next/dynamic';
import type { SandboxPlayMode } from '@/app/test/tasks/Task01App';

const Task01App = dynamic(
  () => import('@/app/test/tasks/Task01App').then((m) => m.Task01App),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading sandbox…
      </div>
    ),
  },
);

export function Task01AppLoader({
  userKey,
  mode = 'curriculum',
  taskId = '01',
}: {
  userKey: string;
  mode?: SandboxPlayMode;
  taskId?: string;
}) {
  return <Task01App userKey={userKey} mode={mode} taskId={taskId} />;
}
