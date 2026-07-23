import Link from 'next/link';

type BrandMarkProps = {
  /** Optional label next to the mark (e.g. "Treasury Workbench"). */
  label?: string;
  /** Href when the mark should navigate; omit for a non-link mark. */
  href?: string;
  /** Light page headers use dark text; dark shells use muted slate. */
  tone?: 'dark' | 'light';
  /** Logo box size in Tailwind units (default h-9 w-9). */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

const SIZE: Record<NonNullable<BrandMarkProps['size']>, string> = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
  lg: 'h-11 w-11',
};

/**
 * Shared Simple Sigma brand mark — dark σₛ on white rounded frame.
 */
export function BrandMark({
  label,
  href,
  tone = 'dark',
  size = 'md',
  className = '',
}: BrandMarkProps) {
  const labelCls =
    tone === 'light' ? 'text-xs text-gray-500' : 'text-xs text-slate-400';

  const inner = (
    <>
      <img
        src="/simple-sigma-logo.png?v=framed"
        alt="Simple Sigma"
        width={44}
        height={44}
        className={`${SIZE[size]} shrink-0 rounded-lg object-contain shadow-sm ring-1 ring-black/5`}
      />
      {label ? <span className={labelCls}>{label}</span> : null}
    </>
  );

  const wrapCls = `inline-flex items-center gap-3 ${className}`.trim();

  if (href) {
    return (
      <Link href={href} className={`${wrapCls} hover:opacity-90 transition-opacity`}>
        {inner}
      </Link>
    );
  }

  return <div className={wrapCls}>{inner}</div>;
}
