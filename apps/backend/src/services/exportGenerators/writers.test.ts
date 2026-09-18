/**
 * Phase 14: the shared writeCsv/writeXlsx utility, unit-tested once here
 * on a generic fixture shape - every export type's own test file (leads/
 * SMS messages/email messages/CDR) exercises its own row-shaping logic
 * on top of this, without re-testing the file-writing mechanics again.
 */
import { describe, expect, it } from 'vitest';
import { writeCsv, writeXlsx } from './writers.js';

interface Fixture {
  id: string;
  name: string;
  count: number;
}

const COLUMNS = [
  { key: 'id' as const, header: 'ID' },
  { key: 'name' as const, header: 'Name' },
  { key: 'count' as const, header: 'Count' },
];

describe('exportGenerators/writers - shared CSV/XLSX file writing', () => {
  it('writeCsv produces a header row plus one row per input row', () => {
    const csv = writeCsv<Fixture>([{ id: '1', name: 'Alice', count: 2 }, { id: '2', name: 'Bob', count: 5 }], COLUMNS);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('ID,Name,Count');
    expect(lines[1]).toBe('1,Alice,2');
    expect(lines[2]).toBe('2,Bob,5');
  });

  it('writeCsv escapes commas, quotes and newlines per RFC4180', () => {
    const csv = writeCsv<Fixture>([{ id: '1', name: 'Smith, "Big" Deal\nLine 2', count: 1 }], COLUMNS);
    expect(csv).toContain('"Smith, ""Big"" Deal\nLine 2"');
  });

  it('writeCsv on an empty row set produces only the header row', () => {
    const csv = writeCsv<Fixture>([], COLUMNS);
    expect(csv.trim()).toBe('ID,Name,Count');
  });

  it('writeCsv renders null/undefined as an empty cell', () => {
    const csv = writeCsv<Record<string, unknown>>([{ id: '1', name: null, count: undefined }], [
      { key: 'id', header: 'ID' },
      { key: 'name', header: 'Name' },
      { key: 'count', header: 'Count' },
    ]);
    expect(csv).toContain('1,,');
  });

  it('writeXlsx produces a real, readable workbook with matching row count and values', async () => {
    const rows: Fixture[] = [{ id: '1', name: 'Alice', count: 2 }, { id: '2', name: 'Bob', count: 5 }];
    const buffer = await writeXlsx('Sheet1', rows, COLUMNS);
    expect(buffer.length).toBeGreaterThan(0);

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Sheet1')!;
    expect(sheet.rowCount).toBe(3); // header + 2 data rows
    expect(sheet.getRow(1).getCell(1).value).toBe('ID');
    expect(sheet.getRow(2).getCell(2).value).toBe('Alice');
    expect(sheet.getRow(3).getCell(3).value).toBe(5);
  });
});
