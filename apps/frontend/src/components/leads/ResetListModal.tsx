import { useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { NEVER_RESET_OUTCOMES, type LeadListWithCounts, type LeadResetResult } from '@shivanshconnect/shared';
import { useLeadBulkAction } from '../../hooks/useLeads';
import { useDispositions } from '../../hooks/useDispositions';
import { Alert, Button, Card } from '../ui';
import { ApiClientError } from '../../lib/apiClient';
import { describeResetResult, RESET_EXCLUSION_NOTE } from './resetLeads';

/**
 * Reset a lead list for redial: every lead in it, or only leads whose last
 * outcome is one of the ones ticked. Reset leads are dialed again as fresh
 * leads in the campaigns the list is attached to. Specific numbers are
 * picked on the list's leads page instead (select them, then Reset).
 */
export function ResetListModal({ list, onClose }: { list: LeadListWithCounts; onClose: () => void }): JSX.Element {
  const bulkAction = useLeadBulkAction();
  const dispositionsQuery = useDispositions(1, 100);
  const outcomes = Array.from(new Set((dispositionsQuery.data?.data ?? []).map((d) => d.name)))
    .filter((name) => !NEVER_RESET_OUTCOMES.includes(name))
    .sort();
  const [scope, setScope] = useState<'all' | 'outcomes'>('outcomes');
  const [picked, setPicked] = useState<Set<string>>(new Set(['Voicemail']));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function toggle(name: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleReset() {
    setError(null);
    try {
      const filters = scope === 'all' ? [{ lead_list_id: list.id }] : Array.from(picked).map((name) => ({ lead_list_id: list.id, last_disposition: name }));
      const total: LeadResetResult = { reset: 0, skipped_excluded: 0, skipped_on_call: 0, campaign_entries_reset: 0 };
      for (const filter of filters) {
        const result = await bulkAction.mutateAsync({ action: 'reset', filter });
        total.reset += result.reset ?? 0;
        total.skipped_excluded += result.skipped_excluded ?? 0;
        total.skipped_on_call += result.skipped_on_call ?? 0;
        total.campaign_entries_reset += result.campaign_entries_reset ?? 0;
      }
      setDone(describeResetResult(total));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not reset this list.');
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <Card className="relative w-full max-w-lg">
        <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold text-ink-900">Reset "{list.name}" for redial</h2>
        <p className="mt-1 text-sm text-ink-500">Reset leads are dialed again as fresh leads in the campaigns this list is attached to. Their call history stays.</p>

        {done ? (
          <>
            <div className="mt-4">
              <Alert variant="success">{done}</Alert>
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-4 space-y-3 text-sm text-ink-700">
              <label className="flex items-center gap-2">
                <input type="radio" checked={scope === 'outcomes'} onChange={() => setScope('outcomes')} />
                Only leads whose last outcome was:
              </label>
              {scope === 'outcomes' && (
                <div className="ml-6 grid grid-cols-2 gap-1">
                  {outcomes.map((name) => (
                    <label key={name} className="flex items-center gap-2">
                      <input type="checkbox" className="h-4 w-4 rounded border-ink-300" checked={picked.has(name)} onChange={() => toggle(name)} />
                      {name}
                    </label>
                  ))}
                </div>
              )}
              <label className="flex items-center gap-2">
                <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
                All {list.lead_count} leads in this list
              </label>
              <p className="text-xs text-ink-500">
                To reset only certain numbers,{' '}
                <Link to={`/leads?lead_list_id=${list.id}`} className="underline">
                  open the list's leads
                </Link>
                , tick them and press Reset for redial.
              </p>
              <p className="text-xs text-ink-500">{RESET_EXCLUSION_NOTE}</p>
            </div>
            {error && (
              <div className="mt-3">
                <Alert>{error}</Alert>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleReset} disabled={bulkAction.isPending || (scope === 'outcomes' && picked.size === 0)}>
                {bulkAction.isPending ? 'Resetting...' : 'Reset leads'}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
