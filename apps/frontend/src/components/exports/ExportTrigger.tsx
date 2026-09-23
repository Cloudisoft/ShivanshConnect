import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { Button } from '../ui';
import { ApiClientError } from '../../lib/apiClient';
import type { ExportType } from '@shivanshconnect/shared';

/**
 * Phase 14: the ONE "queue a background export" button UI - a format
 * picker (CSV/XLSX) plus a trigger that reports queued/error inline.
 * Generalizes Phase 9's CdrPage-only export button so Leads, Lead Lists
 * and SMS/Email campaign message panels all reuse this exact component
 * rather than each re-implementing the same select+button+inline-status
 * pattern.
 */
export function ExportTrigger({
  csvType,
  xlsxType,
  onExport,
  pending,
}: {
  csvType: ExportType;
  xlsxType: ExportType;
  onExport: (type: ExportType) => Promise<unknown>;
  pending: boolean;
}): JSX.Element {
  const [type, setType] = useState<ExportType>(csvType);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function trigger() {
    setError(null);
    setDone(false);
    try {
      await onExport(type);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not queue this export.');
    }
  }

  return (
    <div className="flex items-center gap-2">
      <select
        className="rounded-md border border-ink-300 bg-white px-2 py-2 text-sm text-ink-900"
        value={type}
        onChange={(e) => setType(e.target.value as ExportType)}
      >
        <option value={csvType}>CSV</option>
        <option value={xlsxType}>Excel (.xlsx)</option>
      </select>
      <Button variant="secondary" onClick={trigger} disabled={pending}>
        <Download className="h-4 w-4" /> {pending ? 'Queuing...' : 'Export'}
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
      {done && !error && (
        <span className="text-xs text-green-700">
          Export queued - it isn't a direct download.{' '}
          <Link to="/settings/exports" className="font-medium underline">
            Open Export History
          </Link>{' '}
          once it's ready to download the file.
        </span>
      )}
    </div>
  );
}
