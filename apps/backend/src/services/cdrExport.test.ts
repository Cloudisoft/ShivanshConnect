import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { CDR_EXPORT_COLUMNS, rowsToCsv, rowsToXlsxBuffer } from './cdrExport.js';
import type { CdrRow } from '@shivanshconnect/shared';

function fixtureRow(overrides: Partial<CdrRow> = {}): CdrRow {
  return {
    call_id: 'call-1',
    provider_call_id: 'vapi-call-1',
    campaign_id: 'campaign-1',
    campaign_name: 'Spring Outreach',
    lead_id: 'lead-1',
    lead_name: 'Jane Doe',
    caller_number: '+15005550001',
    destination_number: '+15005550002',
    direction: 'outbound',
    ai_agent_id: 'agent-1',
    ai_agent_name: 'Sales Agent',
    voice_id: 'voice-1',
    voice_name: 'Aria',
    started_at: '2026-01-01T10:00:00.000Z',
    answered_at: '2026-01-01T10:00:05.000Z',
    ended_at: '2026-01-01T10:02:00.000Z',
    duration_seconds: 120,
    talk_duration_seconds: 110,
    status: 'completed',
    disposition_code: 'CALL_CONNECTED',
    disposition_name: 'Call Connected',
    ended_reason: 'customer-ended-call',
    transfer_status: null,
    has_recording: true,
    has_transcript: true,
    has_summary: false,
    cost: 0.42,
    engine: 'vapi',
    created_at: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('cdrExport - row-to-file correctness on a small fixture set', () => {
  it('rowsToCsv produces a header row plus one row per call, in the spec-21 column order', () => {
    const csv = rowsToCsv([fixtureRow(), fixtureRow({ call_id: 'call-2', lead_name: 'Bob Smith', has_recording: false })]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(CDR_EXPORT_COLUMNS.map((c) => c.header).join(','));
    expect(lines[1]).toContain('call-1');
    expect(lines[1]).toContain('Jane Doe');
    expect(lines[2]).toContain('Bob Smith');
  });

  it('rowsToCsv correctly escapes values containing commas, quotes or newlines (RFC4180)', () => {
    const csv = rowsToCsv([fixtureRow({ campaign_name: 'Q1, "Big" Push\nPhase 2' })]);
    const [, dataLine] = csv.trim().split('\r\n');
    expect(dataLine).toContain('"Q1, ""Big"" Push\nPhase 2"');
  });

  it('rowsToCsv on an empty fixture set produces only the header row', () => {
    const csv = rowsToCsv([]);
    expect(csv.trim().split('\r\n')).toHaveLength(1);
  });

  it('rowsToXlsxBuffer produces a real, readable .xlsx workbook with matching row count and values', async () => {
    const rows = [fixtureRow(), fixtureRow({ call_id: 'call-2', lead_name: 'Bob Smith' })];
    const buffer = await rowsToXlsxBuffer(rows);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('CDR');
    expect(sheet).toBeDefined();
    // header row + 2 data rows
    expect(sheet!.rowCount).toBe(3);
    expect(sheet!.getRow(1).getCell(1).value).toBe('Call ID');
    expect(sheet!.getRow(2).getCell(1).value).toBe('call-1');
    expect(sheet!.getRow(3).getCell(1).value).toBe('call-2');
  });
});
