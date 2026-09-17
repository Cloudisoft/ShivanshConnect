import { useState } from 'react';
import { X } from 'lucide-react';
import { Alert, Badge, Button, Card } from '../ui';
import { useBulkAddLeads, type BulkAddResult } from '../../hooks/useLeads';
import { ApiClientError } from '../../lib/apiClient';

export function PasteNumbersModal({
  leadListId,
  onClose,
}: {
  leadListId?: string;
  onClose: () => void;
}): JSX.Element {
  const bulkAdd = useBulkAddLeads();
  const [rawText, setRawText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkAddResult | null>(null);

  async function handleSubmit() {
    setError(null);
    try {
      const res = await bulkAdd.mutateAsync({ raw_text: rawText, lead_list_id: leadListId ?? null });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not add these leads.');
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <Card className="relative w-full max-w-2xl">
        <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-ink-900">Paste numbers</h2>
        <p className="mt-1 text-xs text-ink-500">
          One entry per line. Each line can be just a phone number, or{' '}
          <code className="rounded bg-ink-100 px-1">First,Last,Phone</code>. Numbers are normalized, deduped and
          checked against the Do Not Call list before anything is added.
        </p>

        {!result ? (
          <div className="mt-4 space-y-3">
            {error && <Alert>{error}</Alert>}
            <textarea
              className="h-48 w-full rounded-md border border-ink-300 bg-white px-3 py-2 font-mono text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              placeholder={'John,Smith,4845551234\n(484) 555-5678\n484-555-9012'}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
            />
            <Button onClick={handleSubmit} disabled={bulkAdd.isPending || !rawText.trim()}>
              {bulkAdd.isPending ? 'Adding...' : 'Add leads'}
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="success">{result.added} added</Badge>
              <Badge tone="warning">{result.duplicate} duplicate</Badge>
              <Badge tone="danger">{result.invalid} invalid</Badge>
              <Badge tone="danger">{result.dnc} on DNC list</Badge>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border border-ink-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-ink-50 text-ink-500">
                  <tr>
                    <th className="px-3 py-2">Input</th>
                    <th className="px-3 py-2">Result</th>
                    <th className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {result.results.map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 font-mono">{r.input}</td>
                      <td className="px-3 py-1.5">
                        <Badge
                          tone={
                            r.status === 'added' ? 'success' : r.status === 'duplicate' ? 'warning' : 'danger'
                          }
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-ink-500">{r.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button onClick={onClose}>Done</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
