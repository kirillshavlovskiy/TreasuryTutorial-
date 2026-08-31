/**
 * Write NordTech Task 02 unhedged exposures as a CCY × month strip
 * for pasting into GS Capital Markets Atlas (Input Exposures).
 */
import ExcelJS from 'exceljs';
import { ccySpotRate } from '../lib/fx-buffer';
import { monthlyFxFlowSeriesLocalM } from '../lib/forecast-profile';
import { fxBookNetLocalM } from '../lib/fx-buffer';
import { marketSpotUsd } from '../lib/test-mode/fixtures/nordtech-var';
import {
  simSeedForEntity,
  task02ForecastProfile,
} from '../lib/test-mode/nordtech-sim-seed';
import { fxHedgeTargetLocalM } from '../lib/test-mode/hedge-var';
import type { Entity } from '../lib/workspace-store';

const TENORS = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '9m',
  '10m',
  '11m',
  '1y',
] as const;

const OUT =
  'C:/Users/KirillShavlovskiy/Downloads/NordTech Atlas Input Exposures.xlsx';

function entity(id: string, name: string, baseCurrency: string): Entity {
  return {
    id,
    name,
    baseCurrency,
    description: '',
    createdAt: '',
    dashboards: [],
  };
}

function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

async function main() {
  const seeds = [
    simSeedForEntity(entity('de', 'NordTech GmbH Frankfurt', 'EUR'), '02'),
    simSeedForEntity(entity('pl', 'NordTech Poland Krakow', 'PLN'), '02'),
    simSeedForEntity(entity('us', 'NordTech US Hub', 'USD'), '02'),
  ];
  const profile = task02ForecastProfile();
  const rows = seeds.flatMap(s => s.rows).filter(r => r.ccy !== 'USD');
  const T = 12;

  const books = rows.map(row => {
    const stock = fxBookNetLocalM(row);
    const flows = monthlyFxFlowSeriesLocalM(row, T, profile);
    const dated = flows.map((f, i) => (i === 0 ? r6(stock + f) : r6(f)));
    const standing = flows.map((_, i) =>
      r6(stock + flows.slice(0, i + 1).reduce((s, f) => s + f, 0)),
    );
    const target = fxHedgeTargetLocalM(row, T, profile);
    const spotDesk = marketSpotUsd(row.ccy);
    const spotTms = ccySpotRate(row.ccy);
    return {
      ccy: row.ccy,
      stock,
      flows,
      dated,
      standing,
      target,
      spotDesk,
      spotTms,
      rFcy: row.r_FCY,
    };
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'NordTech Task 02';
  wb.created = new Date();

  const how = wb.addWorksheet('How to paste');
  how.columns = [{ width: 110 }];
  const howLines = [
    'Paste the Atlas_Input sheet into Capital Markets Atlas → Input Exposures.',
    '',
    'Settings to match this book',
    '  Base currency: USD',
    '  Analysis mode: Basic',
    '  Percentile: 5% (z ≈ 1.645)',
    '  Tenors: 1m, 2m, 3m, 4m, 5m, 6m, 7m, 8m, 9m, 10m, 11m, 1y',
    '  Currencies: EUR, GBP, PLN, MXN, JPY, TRY',
    '',
    'What the numbers are',
    '  Units: local currency millions (mm). Sign: long +, short −.',
    '  1m = opening Net FX stock + month-1 FX flow.',
    '  2m…1y = that month’s FX-changing flow only (AR collect / debt repay already in stock are stripped).',
    '  Atlas sums the twelve buckets. That sum = our hedge Target (stock + Σ FX flow).',
    '',
    'Do not paste Monthly_standing into Atlas — those are path-end levels and would double-count stock.',
    'Atlas will apply its own spots / implied vol / carry. Desk_USD is only for our side-by-side check.',
    '',
    'Source: NordTech Task 02 consolidated desk (GmbH + Poland + US). Forecast Tf = 12m.',
  ];
  howLines.forEach((line, i) => {
    how.getCell(i + 1, 1).value = line;
  });

  const atlas = wb.addWorksheet('Atlas_Input');
  atlas.getCell('A1').value = 'Input Exposures';
  atlas.getCell('A2').value = 'Source: NordTech Task 02 desk — unhedged local mm';
  atlas.getCell('A3').value = 'Base Currency: USD';
  atlas.getCell('A4').value = 'Analysis Mode: Basic';
  atlas.getCell('A6').value = 'Unhedged Exposures (mm)';
  const atlasHeader = ['Exposure Currency', ...TENORS];
  atlasHeader.forEach((h, i) => {
    atlas.getCell(7, i + 1).value = h;
    atlas.getCell(7, i + 1).font = { bold: true };
  });
  books.forEach((b, r) => {
    atlas.getCell(8 + r, 1).value = b.ccy;
    b.dated.forEach((v, i) => {
      atlas.getCell(8 + r, 2 + i).value = v;
      atlas.getCell(8 + r, 2 + i).numFmt = '0.000';
    });
  });
  atlas.columns = [{ width: 22 }, ...TENORS.map(() => ({ width: 12 }))];

  const stand = wb.addWorksheet('Monthly_standing');
  stand.getCell('A1').value =
    'Path exposure at month-end (local mm) = stock + cumulative FX flow. Do not paste into Atlas.';
  const standHeader = ['Exposure Currency', 'Stock t=0', ...TENORS, 'Target'];
  standHeader.forEach((h, i) => {
    stand.getCell(3, i + 1).value = h;
    stand.getCell(3, i + 1).font = { bold: true };
  });
  books.forEach((b, r) => {
    stand.getCell(4 + r, 1).value = b.ccy;
    stand.getCell(4 + r, 2).value = b.stock;
    b.standing.forEach((v, i) => {
      stand.getCell(4 + r, 3 + i).value = v;
    });
    stand.getCell(4 + r, 15).value = b.target;
    for (let c = 2; c <= 15; c++) stand.getCell(4 + r, c).numFmt = '0.000';
  });
  stand.columns = [{ width: 22 }, { width: 12 }, ...TENORS.map(() => ({ width: 12 })), { width: 12 }];

  const flow = wb.addWorksheet('Monthly_FX_flow');
  flow.getCell('A1').value =
    'FX-changing flow each month (local mm). AR collect / debt repay already sitting in Stock are stripped.';
  const flowHeader = ['Exposure Currency', ...TENORS, 'Σ flow', 'Stock', 'Target'];
  flowHeader.forEach((h, i) => {
    flow.getCell(3, i + 1).value = h;
    flow.getCell(3, i + 1).font = { bold: true };
  });
  books.forEach((b, r) => {
    flow.getCell(4 + r, 1).value = b.ccy;
    b.flows.forEach((v, i) => {
      flow.getCell(4 + r, 2 + i).value = v;
    });
    flow.getCell(4 + r, 14).value = r6(b.flows.reduce((s, f) => s + f, 0));
    flow.getCell(4 + r, 15).value = b.stock;
    flow.getCell(4 + r, 16).value = b.target;
    for (let c = 2; c <= 16; c++) flow.getCell(4 + r, c).numFmt = '0.000';
  });
  flow.columns = [{ width: 22 }, ...TENORS.map(() => ({ width: 12 })), { width: 12 }, { width: 12 }, { width: 12 }];

  const usd = wb.addWorksheet('Desk_USD');
  usd.getCell('A1').value =
    'USD mm at TMS / market spots (same unit Atlas uses). Task 01 curriculum pins are not used here.';
  const usdHeader = [
    'CCY',
    'Spot desk',
    'Spot TMS',
    'Stock local',
    'Target local',
    'Stock USD mm',
    'Target USD mm',
    'r_FCY %',
  ];
  usdHeader.forEach((h, i) => {
    usd.getCell(3, i + 1).value = h;
    usd.getCell(3, i + 1).font = { bold: true };
  });
  books.forEach((b, r) => {
    const row = 4 + r;
    usd.getCell(row, 1).value = b.ccy;
    usd.getCell(row, 2).value = b.spotDesk;
    usd.getCell(row, 3).value = b.spotTms;
    usd.getCell(row, 4).value = b.stock;
    usd.getCell(row, 5).value = b.target;
    usd.getCell(row, 6).value = r6(b.stock * b.spotDesk);
    usd.getCell(row, 7).value = r6(b.target * b.spotDesk);
    usd.getCell(row, 8).value = b.rFcy;
    for (let c = 2; c <= 8; c++) usd.getCell(row, c).numFmt = c === 8 ? '0.00' : '0.0000';
  });
  usd.columns = usdHeader.map(() => ({ width: 16 }));

  await wb.xlsx.writeFile(OUT);
  const summary = books.map(b => ({
    ccy: b.ccy,
    stock: b.stock,
    dated: b.dated,
    target: b.target,
  }));
  console.log(JSON.stringify({ out: OUT, summary }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
