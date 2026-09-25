/**
 * Desk icon set from Entity Dashboard Create UI.
 * Stroke currentColor, 24×24. Use DeskIcon — names match the zip filenames.
 */
import type { ReactNode, SVGProps } from 'react';

export type DeskIconName =
  | 'action-add'
  | 'action-book'
  | 'action-configure'
  | 'action-dashboard'
  | 'action-dual-monitors'
  | 'action-dealer'
  | 'action-edit'
  | 'action-entity'
  | 'action-find-ticker'
  | 'action-forecast-profile'
  | 'action-limit-warning'
  | 'action-reset'
  | 'action-send-rfq'
  | 'asset-commodities'
  | 'asset-currencies'
  | 'asset-deposits-investments'
  | 'asset-loans-bonds'
  | 'asset-real-assets'
  | 'instr-buffer-layer'
  | 'instr-bullet'
  | 'instr-forward'
  | 'instr-option'
  | 'instr-strip'
  | 'instr-swap'
  | 'metric-cfar'
  | 'metric-ear'
  | 'metric-evar'
  | 'metric-liquidity'
  | 'metric-var'
  | 'opt-carry'
  | 'opt-greeks'
  | 'opt-hedge-cost'
  | 'opt-hedge-ratio'
  | 'opt-nwc'
  | 'status-working';

type DeskIconProps = {
  name: DeskIconName;
  className?: string;
  title?: string;
  strokeWidth?: number;
} & Omit<SVGProps<SVGSVGElement>, 'name' | 'strokeWidth'>;

const ICONS: Record<DeskIconName, { strokeWidth: number; children: ReactNode }> = {
  'action-add': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M12 5.4v13.2">
        </path>
        <path d="M5.4 12h13.2">
        </path>
      </>
    ),
  },
  'action-book': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4.5 6.4A2 2 0 0 1 6.5 4.4h8.6l4.4 4.4v11.2H6.5a2 2 0 0 1-2-2z">
        </path>
        <path d="M14.6 4.4v4.6h4.9">
        </path>
        <path d="M8.6 14.4l2.4 2.4 4-4.8">
        </path>
      </>
    ),
  },
  'action-configure': {
    strokeWidth: 1.5,
    children: (
      <>
        <circle cx={12} cy={12} r={2.8}>
        </circle>
        <path d="M12 3.4v2.4M12 18.2v2.4M4.6 12H7m10 0h2.4M6.7 6.7l1.7 1.7m7.2 7.2 1.7 1.7M17.3 6.7l-1.7 1.7m-7.2 7.2-1.7 1.7">
        </path>
      </>
    ),
  },
  'action-dashboard': {
    strokeWidth: 1.5,
    children: (
      <>
        <rect x={4} y={4} width={7} height={7} rx={1.6}>
        </rect>
        <rect x={13} y={4} width={7} height={4.5} rx={1.4}>
        </rect>
        <rect x={4} y={13} width={7} height={7} rx={1.6}>
        </rect>
        <rect x={13} y={10.5} width={7} height={9.5} rx={1.6}>
        </rect>
      </>
    ),
  },
  'action-dual-monitors': {
    strokeWidth: 2,
    children: (
      <>
        <g transform="translate(-0.5 0.2) scale(0.62)">
          <rect width={20} height={14} x={2} y={3} rx={2} />
          <line x1={8} x2={16} y1={21} y2={21} />
          <line x1={12} x2={12} y1={17} y2={21} />
        </g>
        <g transform="translate(8.6 7.4) scale(0.62)">
          <rect width={20} height={14} x={2} y={3} rx={2} />
          <line x1={8} x2={16} y1={21} y2={21} />
          <line x1={12} x2={12} y1={17} y2={21} />
        </g>
      </>
    ),
  },
  'action-dealer': {
    strokeWidth: 1.5,
    children: (
      <>
        <rect x={3.5} y={6} width={17} height={12} rx={2}>
        </rect>
        <path d="M3.5 10.4h17">
        </path>
        <circle cx={8} cy={14} r={1.2}>
        </circle>
      </>
    ),
  },
  'action-edit': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M14.6 5.4 18.6 9.4">
        </path>
        <path d="M16.4 3.6a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L8.8 19.2 4 20l.8-4.8z">
        </path>
      </>
    ),
  },
  'action-entity': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 20V6.4L11 4v16">
        </path>
        <path d="M11 20h9V10.4L11 8.2">
        </path>
        <path d="M4 20h16">
        </path>
        <path d="M14.4 13h2.4">
        </path>
        <path d="M14.4 16.4h2.4">
        </path>
      </>
    ),
  },
  'action-find-ticker': {
    strokeWidth: 1.5,
    children: (
      <>
        <circle cx={10.8} cy={10.8} r={6.4}>
        </circle>
        <path d="M15.6 15.6 20.4 20.4">
        </path>
      </>
    ),
  },
  'action-forecast-profile': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 19.6V4.6">
        </path>
        <path d="M4 19.6h16">
        </path>
        <path d="M7.2 16.4V12">
        </path>
        <path d="M11.4 16.4V8.8">
        </path>
        <path d="M15.6 16.4v-2.6">
        </path>
        <path d="M19.8 16.4V6.4">
        </path>
        <path d="M7.2 9.6 11.4 6l4.2 4.6L19.8 3.6" strokeDasharray="2.4 2.2">
        </path>
      </>
    ),
  },
  'action-limit-warning': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M12 4.2 20.6 19H3.4z">
        </path>
        <path d="M12 9.6v4.4">
        </path>
        <path d="M12 16.6h.01">
        </path>
      </>
    ),
  },
  'action-reset': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M19.6 12a7.6 7.6 0 1 1-2.4-5.6">
        </path>
        <path d="M19.8 4.4v4.6h-4.6">
        </path>
      </>
    ),
  },
  'action-send-rfq': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M3.6 12.4 20.4 5l-7.4 15.2-1.8-6.6z">
        </path>
        <path d="M11.2 13.6 20.4 5">
        </path>
      </>
    ),
  },
  'asset-commodities': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M12 3.6 20.2 8v8L12 20.4 3.8 16V8z">
        </path>
        <path d="M3.8 8 12 12.4 20.2 8">
        </path>
        <path d="M12 12.4v8">
        </path>
      </>
    ),
  },
  'asset-currencies': {
    strokeWidth: 2.6,
    children: (
      <>
        <g transform="translate(-0.4 0.6) scale(0.6)">
        <path d="M4 10h12">
        </path>
        <path d="M4 14h9">
        </path>
        <path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2">
        </path>
        </g>
        <g transform="translate(10.6 9.4) scale(0.6)">
        <line x1="12" x2="12" y1="2" y2="22">
        </line>
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6">
        </path>
        </g>
      </>
    ),
  },
  'asset-deposits-investments': {
    strokeWidth: 2,
    children: (
      <>
        <path d="M12 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5">
        </path>
        <path d="M18 12h.01">
        </path>
        <path d="M19 22v-6">
        </path>
        <path d="m22 19-3-3-3 3">
        </path>
        <path d="M6 12h.01">
        </path>
        <circle cx={12} cy={12} r={2}>
        </circle>
      </>
    ),
  },
  'asset-loans-bonds': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4.6 6.4A1.8 1.8 0 0 1 6.4 4.6h8l4.6 4.6v9.8a1.8 1.8 0 0 1-1.8 1.8H6.4a1.8 1.8 0 0 1-1.8-1.8z">
        </path>
        <path d="M13.8 4.6v4.6h5">
        </path>
        <path d="M8.2 13.4h7">
        </path>
        <path d="M8.2 16.8h4.4">
        </path>
      </>
    ),
  },
  'asset-real-assets': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4.4 19.6h15.2">
        </path>
        <path d="M6.4 19.6V7.4l6-3.2 6 3.2v12.2">
        </path>
        <path d="M9.8 11h1.6">
        </path>
        <path d="M13.4 11H15">
        </path>
        <path d="M9.8 14.6h1.6">
        </path>
        <path d="M13.4 14.6H15">
        </path>
      </>
    ),
  },
  'instr-buffer-layer': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4.5 17.5V11c0-2.8 3.4-5 7.5-5s7.5 2.2 7.5 5v6.5">
        </path>
        <path d="M3 17.5h18">
        </path>
        <path d="M12 6V3.4">
        </path>
      </>
    ),
  },
  'instr-bullet': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 20h16">
        </path>
        <path d="M17.4 20V5.5">
        </path>
        <path d="M14.6 8.3 17.4 5.5l2.8 2.8">
        </path>
      </>
    ),
  },
  'instr-forward': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 12h14">
        </path>
        <path d="M14.4 8.4 18 12l-3.6 3.6">
        </path>
        <path d="M20.5 6.5v11">
        </path>
      </>
    ),
  },
  'instr-option': {
    strokeWidth: 2,
    children: (
      <>
        <path d="M14.828 14.828 21 21">
        </path>
        <path d="M21 16v5h-5">
        </path>
        <path d="m21 3-9 9-4-4-6 6">
        </path>
        <path d="M21 8V3h-5">
        </path>
      </>
    ),
  },
  'instr-strip': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 20h16">
        </path>
        <path d="M6.6 20v-4">
        </path>
        <path d="M11 20v-6.6">
        </path>
        <path d="M15.4 20v-9.2">
        </path>
        <path d="M19.8 20v-11.8">
        </path>
      </>
    ),
  },
  'instr-swap': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 9h13.5">
        </path>
        <path d="M14.6 5.8 17.8 9l-3.2 3.2">
        </path>
        <path d="M20 15H6.5">
        </path>
        <path d="M9.4 11.8 6.2 15l3.2 3.2">
        </path>
      </>
    ),
  },
  'metric-cfar': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M3 11c3-5.5 6 5.5 9 0s6 5.5 9 0">
        </path>
        <path d="M12 15.5v4.5">
        </path>
        <path d="M9.6 17.8 12 20.2l2.4-2.4">
        </path>
      </>
    ),
  },
  'metric-ear': {
    strokeWidth: 2,
    children: (
      <>
        <path d="M12 16v5">
        </path>
        <path d="M16 14.639V21">
        </path>
        <path d="M20 10.656V21">
        </path>
        <path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15">
        </path>
        <path d="M4 18.463V21">
        </path>
        <path d="M8 14.656V21">
        </path>
      </>
    ),
  },
  'metric-evar': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M12 3.2 19 6v6.2c0 4.4-2.9 7-7 8.6-4.1-1.6-7-4.2-7-8.6V6z">
        </path>
        <path d="M8.6 12.2l2.6 2.6 4.2-5.2">
        </path>
      </>
    ),
  },
  'metric-liquidity': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M12 3.4 17 11a5.6 5.6 0 1 1-10 0z">
        </path>
        <path d="M6.6 15.4h10.8">
        </path>
      </>
    ),
  },
  'metric-var': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 20V4">
        </path>
        <path d="M4 20h16">
        </path>
        <path d="M7.5 16.5c2.6 0 3.4-9 5.4-9s2.4 6 6.1 6">
        </path>
        <path d="M7.5 16.5V20">
        </path>
        <path d="M7.5 16.5 6 18.6">
        </path>
      </>
    ),
  },
  'opt-carry': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M4 20h16">
        </path>
        <path d="M7 20v-4.5">
        </path>
        <path d="M11.6 20v-8">
        </path>
        <path d="M16.4 20v-6">
        </path>
        <path d="M14.6 6.6h5.4">
        </path>
        <path d="M17.3 4v5.2">
        </path>
      </>
    ),
  },
  'opt-greeks': {
    strokeWidth: 1.5,
    children: (
      <>
        <path d="M3.5 15.5c3.4 0 4.2-8.5 8.5-8.5s5.1 8.5 8.5 8.5">
        </path>
        <path d="M12 7v13">
        </path>
        <path d="M9.6 18.4 12 20.8l2.4-2.4">
        </path>
      </>
    ),
  },
  'opt-hedge-cost': {
    strokeWidth: 2,
    children: (
      <>
        <path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17">
        </path>
        <path d="m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9">
        </path>
        <path d="m2 16 6 6">
        </path>
        <circle cx={16} cy={9} r={2.9}>
        </circle>
        <circle cx={6} cy={5} r={3}>
        </circle>
      </>
    ),
  },
  'opt-hedge-ratio': {
    strokeWidth: 1.5,
    children: (
      <>
        <circle cx={8.4} cy={8.4} r={2.6}>
        </circle>
        <circle cx={15.6} cy={15.6} r={2.6}>
        </circle>
        <path d="M18.4 5.6 5.6 18.4">
        </path>
      </>
    ),
  },
  'opt-nwc': {
    strokeWidth: 2.6,
    children: (
      <>
        <g transform="translate(0.4 1.2) scale(0.58)">
        <line x1="12" x2="12" y1="2" y2="22">
        </line>
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6">
        </path>
        </g>
        <g transform="translate(9.8 9.4) scale(0.58)">
        <path d="M16 7h6v6">
        </path>
        <path d="m22 7-8.5 8.5-5-5L2 17">
        </path>
        </g>
      </>
    ),
  },
  'status-working': {
    strokeWidth: 1.8,
    children: (
      <>
        <path d="M12 3.4a8.6 8.6 0 1 1-8.6 8.6">
        </path>
        <path d="M12 7.4V12l3.2 2">
        </path>
      </>
    ),
  },
};

/** Bound mark for wizard step lists that expect a className-only icon. */
export function bindDeskIcon(name: DeskIconName) {
  function BoundDeskIcon({
    className,
    strokeWidth,
  }: {
    className?: string;
    strokeWidth?: number;
  }) {
    return <DeskIcon name={name} className={className} strokeWidth={strokeWidth} />;
  }
  BoundDeskIcon.displayName = `DeskIcon(${name})`;
  return BoundDeskIcon;
}

export function DeskIcon({
  name,
  className = 'h-5 w-5 shrink-0',
  title,
  strokeWidth,
  ...rest
}: DeskIconProps) {
  const def = ICONS[name];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? def.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {def.children}
    </svg>
  );
}
