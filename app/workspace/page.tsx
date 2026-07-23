import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';
import { WorkspaceApp } from './WorkspaceApp';

export default async function WorkspacePage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/');
  }

  const { name, email, image } = session.user;
  const userKey = email ?? name ?? 'default';

  const accountMenu = (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={name ?? 'User'}
            className="h-8 w-8 rounded-full border border-slate-700"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/20 text-sm font-semibold text-blue-300">
            {(name ?? email ?? '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div className="hidden sm:block leading-tight">
          <div className="text-sm font-medium text-white">{name ?? 'Signed in'}</div>
          <div className="text-xs text-slate-400">{email}</div>
        </div>
      </div>
      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/' });
        }}
      >
        <button
          type="submit"
          className="rounded-md border border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          Sign out
        </button>
      </form>
    </div>
  );

  return (
    <WorkspaceApp
      userKey={userKey}
      userName={name ?? email ?? 'there'}
      accountMenu={accountMenu}
    />
  );
}
