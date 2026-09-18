/**
 * Phase 14: the ONE shared file-writing layer every export type (CDR,
 * leads, SMS messages, email messages) uses. Extracted out of Phase 9's
 * `cdrExport.ts`, which was already CDR-specific but structurally
 * generic (a fixed `{ key, header }` column list driving both a CSV
 * writer and an exceljs XLSX writer) - this module is that same logic
 * made reusable, not a rewrite. `cdrExport.ts` now calls into this
 * module and its own `rowsToCsv`/`rowsToXlsxBuffer` exports keep their
 * exact original signatures/behavior (see its own header comment and
 * `cdrExport.test.ts`, which is unchanged and must keep passing).
 */
import ExcelJS from 'exceljs';

export interface ExportColumn<T> {
  key: keyof T;
  header: string;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** Pure, directly-unit-testable: turns any row/column shape into a real
 * RFC4180 CSV string (header row + one data row per input row). */
export function writeCsv<T extends Record<string, unknown>>(rows: T[], columns: ExportColumn<T>[]): string {
  const header = columns.map((c) => csvEscape(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(','));
  return [header, ...lines].join('\r\n') + (rows.length > 0 ? '\r\n' : '');
}

/** Pure, directly-unit-testable: turns any row/column shape into a real
 * .xlsx workbook buffer via exceljs. */
export async function writeXlsx<T extends Record<string, unknown>>(
  sheetName: string,
  rows: T[],
  columns: ExportColumn<T>[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key as string, width: 20 }));
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
