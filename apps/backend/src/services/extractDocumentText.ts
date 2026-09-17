import { parse as parseCsv } from 'csv-parse/sync';
import type { KnowledgeDocumentFileType } from '@shivanshconnect/shared';

/** Infers the knowledge_documents.file_type value from an uploaded file's
 * name. Returns null for anything not in the supported set - the caller
 * rejects the upload rather than guessing. */
export function inferFileType(fileName: string): KnowledgeDocumentFileType | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.txt')) return 'txt';
  return null;
}

/** Flattens a CSV buffer into plain text: one line per row, formatted as
 * "column: value" pairs joined by " | ", so it reads sensibly once
 * chunked and embedded rather than as a raw delimited blob. */
function csvBufferToText(buffer: Buffer): string {
  const records: Record<string, string>[] = parseCsv(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  return records
    .map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(' | '))
    .join('\n');
}

/**
 * Extracts plain text from an uploaded document buffer, per file type:
 * pdf-parse for PDF, mammoth for DOCX, plain UTF-8 decode for TXT/MD,
 * CSV-to-text flattening for CSV. Throws on a genuinely unreadable file
 * (e.g. corrupt PDF) rather than returning empty text silently -
 * processKnowledgeDocument.ts maps that to knowledge_documents.status =
 * 'failed' with the thrown message as error_message.
 */
export async function extractDocumentText(buffer: Buffer, fileType: KnowledgeDocumentFileType): Promise<string> {
  switch (fileType) {
    case 'txt':
    case 'md':
      return buffer.toString('utf-8');
    case 'csv':
      return csvBufferToText(buffer);
    case 'docx': {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case 'pdf': {
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = (pdfParseModule as any).default ?? pdfParseModule;
      const result = await pdfParse(buffer);
      return result.text as string;
    }
    default:
      throw new Error(`Unsupported document type: ${fileType}`);
  }
}
