'use client';

import dynamic from 'next/dynamic';

const Task01App = dynamic(
  () => import('@/app/test/tasks/Task01App').then((m) => m.Task01App),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading task…
      </div>
    ),
  },
);

export function Task01AppLoader({ userKey }: { userKey: string }) {
  return <Task01App userKey={userKey} />;
}
