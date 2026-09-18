import { useState } from 'react';
import { History } from 'lucide-react';
import { useExportHistory } from '../../hooks/useExports';
import { ExportHistoryList } from '../../components/exports/ExportHistoryList';
import { Button, Card } from '../../components/ui';
import type { ExportType } from '@shivanshconnect/shared';

const TYPE_FILTERS: Array<{ value: ExportType | ''; label: string }> = [
  { value: '', label: 'All types' },
  { value: 'cdr_csv', label: 'CDR (CSV)' },
  { value: 'cdr_xlsx', label: 'CDR (Excel)' },
  { value: 'leads_csv', label: 'Leads (CSV)' },
  { value: 'leads_xlsx', label: 'Leads (Excel)' },
  { value: 'sms_messages_csv', label: 'SMS Messages (CSV)' },
  { value: 'sms_messages_xlsx', label: 'SMS Messages (Excel)' },
  { value: 'email_messages_csv', label: 'Email Messages (CSV)' },
  { value: 'email_messages_xlsx', label: 'Email Messages (Excel)' },
];

const PAGE_SIZE = 25;

/**
 * Phase 14: the unified Export History view (spec section 65's "show
 * export history" requirement, made complete across every module
 * instead of CDR-only). One `exports` table backs every export type
 * (CDR, leads, SMS/email campaign messages) - this page is simply that
 * table's full history, filterable by type, reusing the exact same
 * `ExportHistoryList` row renderer every per-module export panel uses.
 */
export function ExportHistorySettingsPage(): JSX.Element {
  const [page, setPage] = useState(1);
  const [type, setType] = useState<ExportType | ''>('');

  const exportsQuery = useExportHistory(page, PAGE_SIZE, type || undefined);
  const exportsList = exportsQuery.data?.data ?? [];
  const pagination = exportsQuery.data?.pagination;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink-900">Export history</h2>
          <p className="mt-1 text-sm text-ink-500">
            Every background export this organization has queued - CDR, leads, SMS and email campaign messages -
            in one place.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          className="rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900"
          value={type}
          onChange={(e) => {
            setType(e.target.value as ExportType | '');
            setPage(1);
          }}
        >
          {TYPE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <Card className="mt-4">
        {exportsQuery.isLoading && <p className="text-sm text-ink-500">Loading export history...</p>}

        {!exportsQuery.isLoading && exportsList.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <History className="h-10 w-10 text-ink-300" />
            <p className="mt-3 text-sm font-medium text-ink-700">No exports yet</p>
            <p className="mt-1 text-sm text-ink-500">
              Export buttons on Leads, Lead Lists, CDR and Messaging queue background jobs that show up here.
            </p>
          </div>
        )}

        {!exportsQuery.isLoading && exportsList.length > 0 && <ExportHistoryList exports={exportsList} />}
      </Card>

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>
            Page {pagination.page} of {pagination.total_pages} ({pagination.total} exports)
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="secondary" disabled={page >= pagination.total_pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
