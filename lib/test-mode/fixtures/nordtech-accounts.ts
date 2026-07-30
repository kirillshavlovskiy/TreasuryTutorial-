import type { TestAccount, TestDashboardLabel, TestEntity, TestWorkspace } from '@/lib/test-mode/types';

/** Stable entity ids — scoring matches seedKey → expected entity code. */
export const NORDTECH_ENTITY_IDS = {
  us: 'ent-nordtech-us',
  de: 'ent-nordtech-gmbh',
  pl: 'ent-nordtech-poland',
} as const;

export const NORDTECH_ENTITIES: TestEntity[] = [
  {
    id: NORDTECH_ENTITY_IDS.us,
    code: 'US',
    legalName: 'NordTech US',
    functionalCurrency: 'USD',
    role: 'Parent · reporting currency USD',
    description: 'USD hub — settles group cash',
  },
  {
    id: NORDTECH_ENTITY_IDS.de,
    code: 'DE',
    legalName: 'NordTech GmbH',
    functionalCurrency: 'EUR',
    role: 'Frankfurt · EUR operating hub',
    description: 'EUR book · debt · EU billing',
  },
  {
    id: NORDTECH_ENTITY_IDS.pl,
    code: 'PL',
    legalName: 'NordTech Poland',
    functionalCurrency: 'PLN',
    role: 'Kraków · PLN payroll entity',
    description: 'PLN payroll',
  },
];

/**
 * NordTech sample book from Sigma Task 01 guide.
 * Ladder / Net FX stock EUR = cash + receivables − venture debt = +€1.9M.
 */
export const NORDTECH_ACCOUNTS: TestAccount[] = [
  {
    id: 'acc-us-cash',
    seedKey: 'us-cash',
    entityId: NORDTECH_ENTITY_IDS.us,
    name: 'Cash · US operating',
    kind: 'asset',
    currency: 'USD',
    amount: 6.0,
    cadence: 'stock',
    ladderLayer: 'stock',
  },
  {
    id: 'acc-us-payroll',
    seedKey: 'us-payroll',
    entityId: NORDTECH_ENTITY_IDS.us,
    name: 'Payroll obligation · US',
    kind: 'flow',
    currency: 'USD',
    amount: -0.8,
    cadence: 'monthly',
    ladderLayer: 'flow',
  },
  {
    id: 'acc-de-cash',
    seedKey: 'de-cash-frankfurt',
    entityId: NORDTECH_ENTITY_IDS.de,
    name: 'Cash · Frankfurt',
    kind: 'asset',
    currency: 'EUR',
    amount: 2.5,
    cadence: 'stock',
    ladderLayer: 'stock',
  },
  {
    id: 'acc-de-receivables',
    seedKey: 'de-receivables-eu',
    entityId: NORDTECH_ENTITY_IDS.de,
    name: 'Receivables · EU (quarter outstanding)',
    kind: 'asset',
    currency: 'EUR',
    amount: 2.4,
    cadence: 'stock',
    ladderLayer: 'stock',
  },
  {
    id: 'acc-de-debt',
    seedKey: 'de-venture-debt',
    entityId: NORDTECH_ENTITY_IDS.de,
    name: 'Venture debt',
    kind: 'liability',
    currency: 'EUR',
    amount: -3.0,
    cadence: 'stock',
    // Included in Net FX / ladder stock (short EUR).
    ladderLayer: 'stock',
  },
  {
    id: 'acc-de-gbp-stake',
    seedKey: 'de-uk-stake',
    entityId: NORDTECH_ENTITY_IDS.de,
    name: 'UK reseller stake',
    kind: 'asset',
    currency: 'GBP',
    amount: 0.5,
    cadence: 'stock',
    ladderLayer: 'none',
  },
  {
    id: 'acc-de-revenue',
    seedKey: 'de-revenue-eu',
    entityId: NORDTECH_ENTITY_IDS.de,
    name: 'Revenue pipe · EU billing',
    kind: 'flow',
    currency: 'EUR',
    amount: 1.2,
    cadence: 'monthly',
    ladderLayer: 'flow',
  },
  {
    id: 'acc-pl-payroll',
    seedKey: 'pl-payroll',
    entityId: NORDTECH_ENTITY_IDS.pl,
    name: 'Payroll obligation · Kraków',
    kind: 'flow',
    currency: 'PLN',
    amount: -1.8,
    cadence: 'monthly',
    // Guide ladder stock for PLN is the −zł1.8M payroll accrual (short).
    ladderLayer: 'stock',
  },
];

/** Expected seedKey → entity code for scoring (exact match, no tolerance). */
export const NORDTECH_ACCOUNT_ENTITY_MAP: Record<string, string> = {
  'us-cash': 'US',
  'us-payroll': 'US',
  'de-cash-frankfurt': 'DE',
  'de-receivables-eu': 'DE',
  'de-venture-debt': 'DE',
  'de-uk-stake': 'DE',
  'de-revenue-eu': 'DE',
  'pl-payroll': 'PL',
};

export const NORDTECH_DASHBOARDS: TestDashboardLabel[] = [
  { id: 'dash-group-fx', name: 'Group FX', purpose: 'Group-wide FX exposure' },
  { id: 'dash-eur-debt', name: 'EUR debt maturity', purpose: 'GmbH euro debt profile' },
  { id: 'dash-payroll', name: 'Payroll runway', purpose: 'USD + PLN payroll deadlines' },
];

export function buildNordtechWorkspace(): TestWorkspace {
  return {
    group: {
      id: 'grp-nordtech',
      name: 'NordTech Group',
      reportingCurrency: 'USD',
    },
    entities: NORDTECH_ENTITIES.map(e => ({ ...e })),
    accounts: NORDTECH_ACCOUNTS.map(a => ({ ...a })),
    dashboards: NORDTECH_DASHBOARDS.map(d => ({ ...d })),
  };
}
