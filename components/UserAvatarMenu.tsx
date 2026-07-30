'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { signOutToHome } from '@/app/test/sign-out';

type UserAvatarMenuProps = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  sandboxEnabled?: boolean;
};

const itemCls =
  'block w-full px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800';

export function UserAvatarMenu({
  name,
  email,
  image,
  sandboxEnabled = true,
}: UserAvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const initial = (name ?? email ?? '?').charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="rounded-full outline-none ring-offset-2 ring-offset-slate-950 focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={name ?? email ?? 'Account'}
            className="h-8 w-8 rounded-full border border-slate-700 object-cover"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 bg-blue-500/20 text-sm font-semibold text-blue-300">
            {initial}
          </div>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 min-w-[12rem] overflow-hidden rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl"
        >
          {(name || email) && (
            <div className="border-b border-slate-800 px-3 py-2">
              {name && (
                <div className="truncate text-xs font-medium text-white">{name}</div>
              )}
              {email && (
                <div className="truncate text-[11px] text-slate-500">{email}</div>
              )}
            </div>
          )}
          <Link href="/" role="menuitem" className={itemCls} onClick={() => setOpen(false)}>
            Home · choose mode
          </Link>
          {sandboxEnabled && (
            <Link
              href="/test"
              role="menuitem"
              className={itemCls}
              onClick={() => setOpen(false)}
            >
              Sandbox · practice
            </Link>
          )}
          <Link
            href="/workspace"
            role="menuitem"
            className={itemCls}
            onClick={() => setOpen(false)}
          >
            Workbench · live desk
          </Link>
          <div className="my-1 border-t border-slate-800" />
          <form action={signOutToHome}>
            <button type="submit" role="menuitem" className={itemCls}>
              Log out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
