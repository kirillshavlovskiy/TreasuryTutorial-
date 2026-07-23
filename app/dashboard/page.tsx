import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';
import { Simulator } from './Simulator';

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/');
  }

  const { name, email, image } = session.user;

  const accountMenu = (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={name ?? 'User'}
            className="h-8 w-8 rounded-full border border-gray-200"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
            {(name ?? email ?? '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div className="hidden sm:block leading-tight">
          <div className="text-sm font-medium text-gray-900">{name ?? 'Signed in'}</div>
          <div className="text-xs text-gray-400">{email}</div>
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
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
        >
          Sign out
        </button>
      </form>
    </div>
  );

  return <Simulator accountMenu={accountMenu} />;
}
