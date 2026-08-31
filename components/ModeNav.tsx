'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type ModeNavProps = {
  /**
   * Hides the Sandbox link when the `/test` gate is closed. Required so callers
   * must pass `isTestModeEnabled()` instead of silently defaulting to visible.
   */
  sandboxEnabled: boolean;
};

const linkBase =
  'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors';

export function ModeNav({ sandboxEnabled }: ModeNavProps) {
  const pathname = usePathname() ?? '';
  const onHome = pathname === '/';
  const onSandbox = pathname.startsWith('/test');
  const onWorkbench = pathname.startsWith('/workspace');
  const onRates = pathname.startsWith('/treasury/rates');

  const active = (on: boolean) =>
    on
      ? `${linkBase} bg-slate-800 text-white`
      : `${linkBase} text-slate-400 hover:bg-slate-800/60 hover:text-slate-200`;

  return (
    <nav
      aria-label="App mode"
      className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-950/40 p-0.5"
    >
      <Link href="/" className={active(onHome)} title="Landing — choose mode">
        Home
      </Link>
      {sandboxEnabled && (
        <Link
          href="/test"
          className={active(onSandbox)}
          title="Sandbox · curriculum & self practice"
        >
          Sandbox
        </Link>
      )}
      <Link
        href="/workspace"
        className={active(onWorkbench)}
        title="Live Treasury Workbench"
      >
        Workbench
      </Link>
      <Link
        href="/treasury/rates"
        className={active(onRates)}
        title="Live FX rates via Treasury MCP (PoC)"
      >
        FX Rates
      </Link>
    </nav>
  );
}
