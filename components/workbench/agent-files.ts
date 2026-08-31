/**
 * Client-side parsing of raw data files attached to the AI Agent chat.
 * Excel goes through exceljs (already a dependency for FXOCalculator
 * workbooks); CSV is parsed directly — exceljs has no browser-friendly
 * universal reader the way the xlsx package did. Output is a small
 * headers + rows table capped at MAX_ATTACHED_ROWS so the payload stays
 * inside the free-tier token budget.
 */

import ExcelJS from 'exceljs';
import {
  MAX_ATTACHED_ROWS,
  type AttachedDataFile,
} from '@/lib/agent/desk-context';

export const AGENT_FILE_ACCEPT = '.csv,.xlsx,.xls';

function toCell(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Unwrap exceljs cell shapes (formula results, rich text, dates) to plain values. */
function cellRawValue(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    const obj = v as { result?: unknown; richText?: { text?: string }[]; text?: unknown };
    if ('result' in obj) return cellRawValue(obj.result);
    if (Array.isArray(obj.richText)) return obj.richText.map(r => r.text ?? '').join('');
    if (typeof obj.text === 'string') return obj.text;
  }
  return v;
}

/**
 * Minimal RFC 4180 CSV parser — quoted fields, embedded commas/newlines, and
 * doubled-quote escaping. A flat table is all this feature needs, so a small
 * dependency-free parser beats pulling in a CSV library for one call site.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function gridFromCsv(file: File): Promise<{ grid: unknown[][]; sheetName?: string }> {
  const text = await file.text();
  return { grid: parseCsv(text) };
}

async function gridFromExcel(file: File): Promise<{ grid: unknown[][]; sheetName?: string }> {
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  // exceljs's `load()` is typed as taking a `Buffer`, but its own docs for
  // this method say "load from an array buffer" — it genuinely accepts one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buf as any);
  const sheet = wb.worksheets[0];
  if (!sheet) {
    throw new Error(`"${file.name}" has no readable sheets`);
  }
  const grid: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = row.values as unknown[];
    const out: unknown[] = [];
    for (let c = 1; c < values.length; c++) {
      out[c - 1] = cellRawValue(values[c]);
    }
    grid[rowNumber - 1] = out;
  });
  return { grid, sheetName: sheet.name };
}

export async function parseAgentFile(file: File): Promise<AttachedDataFile> {
  const isCsv = /\.csv$/i.test(file.name);
  const { grid, sheetName } = isCsv ? await gridFromCsv(file) : await gridFromExcel(file);

  // First row with any content is the header row.
  const headerIdx = grid.findIndex(row =>
    row.some(c => c != null && String(c).trim() !== ''),
  );
  if (headerIdx < 0) {
    throw new Error(`"${file.name}" appears to be empty`);
  }
  const headers = grid[headerIdx]!.map(c => String(c ?? '').trim());
  const dataRows = grid
    .slice(headerIdx + 1)
    .filter(row => row.some(c => c != null && String(c).trim() !== ''));
  return {
    name: file.name,
    kind: isCsv ? 'csv' : 'xlsx',
    sheetName,
    headers,
    rows: dataRows.slice(0, MAX_ATTACHED_ROWS).map(row => row.map(toCell)),
    totalRows: dataRows.length,
  };
}
