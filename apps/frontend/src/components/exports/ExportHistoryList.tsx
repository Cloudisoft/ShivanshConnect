import { Download } from 'lucide-react';
import { Badge, Button } from '../ui';
import { downloadExportFile } from '../../hooks/useExports';
import type { ExportWithDownload } from '@shivanshconnect/shared';

const TYPE_LABELS: Record<string, string> = {
  cdr_csv: 'CDR (CSV)',
  cdr_xlsx: 'CDR (Excel)',
  leads_csv: 'Leads (CSV)',
  leads_xlsx: 'Leads (Excel)',
  sms_messages_csv: 'SMS Messages (CSV)',
  sms_messages_xlsx: 'SMS Messages (Excel)',
  email_messages_csv: 'Email Messages (CSV)',
  email_messages_xlsx: 'Email Messages (Excel)',
};

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'warning',
  processing: 'warning',
  ready: 'success',
  failed: 'danger',
};

/**
 * Phase 14: the ONE export-history row renderer, shared by every place
 * export history shows up - the CDR page's history panel and the
 * unified, all-module Export History page - rather than a second copy
 * of the same status-badge/download-button markup.
 */
export function ExportHistoryList({ exports }: { exports: ExportWithDownload[] }): JSX.Element {
  if (exports.length === 0) {
    return <p className="text-sm text-ink-500">No exports yet.</p>;
  }

  return (
    <div className="space-y-3">
      {exports.map((exp) => {
        const extension = exp.type.endsWith('xlsx') ? 'xlsx' : 'csv';
        return (
          <div key={exp.id} className="flex items-center justify-between gap-3 rounded-md border border-ink-200 p-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-ink-900">{TYPE_LABELS[exp.type] ?? exp.type}</p>
              <p className="text-xs text-ink-500">
                {new Date(exp.created_at).toLocaleString()}
                {exp.row_count != null ? ` - ${exp.row_count} row${exp.row_count === 1 ? '' : 's'}` : ''}
              </p>
              {exp.status === 'failed' && <p className="mt-1 text-xs text-red-700">{exp.failure_reason}</p>}
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <Badge tone={STATUS_TONE[exp.status] ?? 'neutral'}>{exp.status}</Badge>
              {exp.status === 'ready' && (
                <Button variant="secondary" onClick={() => downloadExportFile(exp.id, `${exp.type}-${exp.id}.${extension}`)}>
                  <Download className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
