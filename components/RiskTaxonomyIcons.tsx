/**
 * Icons for the desk taxonomy — risk asset · protect goal · optimize framework
 * · ticker. Single source of truth on purpose: the create-dashboard wizard, the
 * guided structure wizard and the summary chips all read from here, so a desk
 * shows the same mark wherever it appears.
 */

import {
  ArrowLeftRight,
  Banknote,
  BarChart3,
  Building2,
  CalendarClock,
  Coins,
  CreditCard,
  Droplets,
  Factory,
  Gem,
  Globe2,
  Handshake,
  Landmark,
  LineChart,
  Percent,
  PiggyBank,
  Repeat,
  Scale,
  Shield,
  Sigma,
  Split,
  TrendingUp,
  Vault,
  Waves,
} from 'lucide-react';
import type {
  OptimizeFrameworkId,
  ProtectGoalId,
  RateInstrumentKind,
  RiskAssetId,
} from '@/lib/workspace-store';

type TaxonomyIconProps = { className?: string; strokeWidth?: number };

const DEFAULT_ICON = 'h-7 w-7';

export function RiskAssetIcon({
  id,
  className = DEFAULT_ICON,
  strokeWidth = 1.75,
}: TaxonomyIconProps & { id: RiskAssetId }) {
  const p = { className, strokeWidth };
  switch (id) {
    case 'currencies':
      return <ArrowLeftRight {...p} />;
    case 'interestRates':
      return <Percent {...p} />;
    case 'bonds':
      return <Landmark {...p} />;
    case 'investments':
      return <TrendingUp {...p} />;
    case 'commodities':
      return <Gem {...p} />;
    case 'realAssets':
      return <Building2 {...p} />;
    default:
      return <Coins {...p} />;
  }
}

export function ProtectGoalIcon({
  id,
  className = DEFAULT_ICON,
  strokeWidth = 1.75,
}: TaxonomyIconProps & { id: ProtectGoalId }) {
  const p = { className, strokeWidth };
  switch (id) {
    case 'assetValue':
      return <Shield {...p} />;
    case 'cashFlow':
      return <Waves {...p} />;
    case 'liquidity':
      return <Droplets {...p} />;
    case 'credit':
      return <CreditCard {...p} />;
    case 'earnings':
      return <PiggyBank {...p} />;
  }
}

export function OptimizeFrameworkIcon({
  id,
  className = DEFAULT_ICON,
  strokeWidth = 1.75,
}: TaxonomyIconProps & { id: OptimizeFrameworkId }) {
  const p = { className, strokeWidth };
  switch (id) {
    case 'var':
      return <Sigma {...p} />;
    case 'cfar':
      return <Banknote {...p} />;
    case 'ear':
      return <LineChart {...p} />;
    case 'dv01':
      return <Percent {...p} />;
    case 'greeks':
      return <Scale {...p} />;
    case 'factorModel':
      return <Factory {...p} />;
    case 'credit':
      return <CreditCard {...p} />;
    case 'hedgeCarry':
      return <BarChart3 {...p} />;
  }
}

export function RateInstrumentIcon({
  id,
  className = DEFAULT_ICON,
  strokeWidth = 1.75,
}: TaxonomyIconProps & { id: RateInstrumentKind }) {
  const p = { className, strokeWidth };
  switch (id) {
    case 'timeDeposit':
      return <Vault {...p} />;
    case 'loan':
      return <Handshake {...p} />;
    case 'moneyMarketFund':
      return <PiggyBank {...p} />;
    case 'irs':
      return <Repeat {...p} />;
    case 'swaption':
      return <Split {...p} />;
    case 'fra':
      return <CalendarClock {...p} />;
    case 'crossCurrencySwap':
      return <Globe2 {...p} />;
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', CHF: '₣',
  AUD: '$', CAD: '$', NZD: '$', SGD: '$', HKD: '$', MXN: '$',
  SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł', CZK: 'Kč',
  INR: '₹', KRW: '₩', TRY: '₺', BRL: 'R$', ZAR: 'R', ILS: '₪',
  RUB: '₽', THB: '฿', PHP: '₱', VND: '₫', NGN: '₦', UAH: '₴',
};

/**
 * Ticker mark for a currency chip. A glyph beats an SVG at chip size — a drawn
 * currency mark blurs at 10px where the character stays crisp. Non-currency
 * tickers (SOFR, XAU, …) fall back to a coin.
 */
export function TickerGlyph({
  code,
  className = 'w-2.5 text-center',
}: {
  code: string;
  className?: string;
}) {
  const symbol = CURRENCY_SYMBOLS[code.trim().toUpperCase()];
  if (!symbol) return <Coins className="h-3 w-3 shrink-0" strokeWidth={1.75} />;
  return (
    <span aria-hidden className={`shrink-0 leading-none ${className}`}>
      {symbol}
    </span>
  );
}
