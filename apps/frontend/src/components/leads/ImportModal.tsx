import { useRef, useState } from 'react';
import { Download, Upload, X } from 'lucide-react';
import { Alert, Badge, Button, Card, Input, Label } from '../ui';
import {
  downloadImportErrors,
  useCommitImportJob,
  useImportJob,
  useImportJobRows,
  useUpdateImportMapping,
  useUploadImport,
} from '../../hooks/useImportJobs';
import { useCreateLeadList, useLeadLists } from '../../hooks/useLeadLists';
import { IMPORTABLE_LEAD_FIELDS, type LeadList } from '@shivanshconnect/shared';
import { ApiClientError } from '../../lib/apiClient';

const PROCESSING_STATUSES = ['pending', 'parsing', 'validating', 'committing'];

/** Importing a CSV/XLSX always lands the rows in a specific list (the
 * backend endpoint is POST /lead-lists/:leadListId/import - there's no
 * "list-less" import the way Paste numbers allows). When this modal is
 * opened without a leadListId already chosen (e.g. from the main Leads
 * page rather than a list-filtered view), it asks for one first instead
 * of the Import option simply not being there. */
function ChooseListStep({ onChosen }: { onChosen: (leadListId: string) => void }): JSX.Element {
  const listsQuery = useLeadLists(1, 200);
  const createList = useCreateLeadList();
  const [selectedId, setSelectedId] = useState('');
  const [newListName, setNewListName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lists = listsQuery.data?.data ?? [];

  async function handleCreateAndUse(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await createList.mutateAsync({ name: newListName });
      onChosen((created as LeadList).id);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create this list.');
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-ink-500">Imported leads need to go into a list. Choose an existing one, or create a new one.</p>
      {error && <Alert>{error}</Alert>}

      {lists.length > 0 && !creating && (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="import_list">Existing list</Label>
            <select
              id="import_list"
              className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">Select a list...</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <Button disabled={!selectedId} onClick={() => onChosen(selectedId)}>
            Continue
          </Button>
        </div>
      )}

      {!creating ? (
        <button type="button" className="text-xs font-medium text-gold-700 underline" onClick={() => setCreating(true)}>
          {lists.length === 0 ? 'Create a list to import into' : 'Or create a new list instead'}
        </button>
      ) : (
        <form className="flex items-end gap-2" onSubmit={handleCreateAndUse}>
          <div className="flex-1">
            <Label htmlFor="new_list_name">New list name</Label>
            <Input id="new_list_name" value={newListName} onChange={(e) => setNewListName(e.target.value)} required minLength={1} autoFocus />
          </div>
          <Button type="submit" disabled={createList.isPending || !newListName.trim()}>
            {createList.isPending ? 'Creating...' : 'Create & continue'}
          </Button>
        </form>
      )}
    </div>
  );
}

export function ImportModal({ leadListId, onClose }: { leadListId?: string; onClose: () => void }): JSX.Element {
  const [chosenListId, setChosenListId] = useState<string | undefined>(leadListId);
  const [jobId, setJobId] = useState<string | null>(null);
  const upload = useUploadImport();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const jobQuery = useImportJob(jobId ?? undefined, { poll: true });
  const job = jobQuery.data;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !chosenListId) return;
    setUploadError(null);
    try {
      const created = await upload.mutateAsync({ leadListId: chosenListId, file });
      setJobId(created.id);
    } catch (err) {
      setUploadError(err instanceof ApiClientError ? err.message : 'Could not upload this file.');
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <Card className="relative w-full max-w-3xl">
        <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-ink-900">Import leads</h2>

        {!chosenListId && <ChooseListStep onChosen={setChosenListId} />}

        {chosenListId && !jobId && (
          <div className="mt-4 space-y-3">
            {uploadError && <Alert>{uploadError}</Alert>}
            <p className="text-sm text-ink-500">
              Upload a CSV or XLSX file. Phone is required; first name, last name, email and address
              columns are detected automatically, and you can adjust the mapping before anything is imported.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xlsm"
              onChange={handleFileChange}
              disabled={upload.isPending}
              className="block w-full text-sm text-ink-700 file:mr-4 file:rounded-md file:border-0 file:bg-ink-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-ink-800"
            />
            {upload.isPending && <p className="text-sm text-ink-500">Uploading...</p>}
          </div>
        )}

        {jobId && job && PROCESSING_STATUSES.includes(job.status) && (
          <div className="mt-8 flex flex-col items-center py-10 text-center">
            <Upload className="h-8 w-8 animate-pulse text-ink-400" />
            <p className="mt-3 text-sm font-medium text-ink-700">
              {job.status === 'pending' && 'Starting import...'}
              {job.status === 'parsing' && 'Parsing file...'}
              {job.status === 'validating' && 'Validating rows and checking for duplicates / DNC matches...'}
              {job.status === 'committing' && 'Importing leads...'}
            </p>
          </div>
        )}

        {jobId && job && job.status === 'failed' && (
          <div className="mt-4">
            <Alert>{job.error_message ?? 'This import failed.'}</Alert>
          </div>
        )}

        {jobId && job && job.status === 'ready_for_review' && <ReviewStep job={job} />}

        {jobId && job && job.status === 'completed' && (
          <div className="mt-6 space-y-4">
            <Alert variant="success">
              Import complete. {job.imported_rows} lead{job.imported_rows === 1 ? '' : 's'} added to this list.
            </Alert>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="success">{job.valid_rows} valid</Badge>
              <Badge tone="warning">{job.duplicate_rows} duplicate</Badge>
              <Badge tone="danger">{job.invalid_rows} invalid</Badge>
              <Badge tone="danger">{job.dnc_rows} on DNC list</Badge>
            </div>
            {job.invalid_rows + job.duplicate_rows + job.dnc_rows > 0 && (
              <Button variant="secondary" onClick={() => downloadImportErrors(job.id)}>
                <Download className="h-4 w-4" /> Download skipped rows
              </Button>
            )}
            <div>
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function ReviewStep({ job }: { job: NonNullable<ReturnType<typeof useImportJob>['data']> }): JSX.Element {
  const updateMapping = useUpdateImportMapping();
  const commit = useCommitImportJob();
  const [mapping, setMapping] = useState<Record<string, string>>(job.column_mapping);
  const [commitError, setCommitError] = useState<string | null>(null);
  const previewRows = useImportJobRows(job.id);

  const headers = Object.keys(job.column_mapping);

  function updateHeader(header: string, target: string) {
    setMapping((prev) => {
      const next = { ...prev };
      if (target) next[header] = target;
      else delete next[header];
      return next;
    });
  }

  async function applyMapping() {
    await updateMapping.mutateAsync({ id: job.id, column_mapping: mapping });
  }

  async function handleCommit() {
    setCommitError(null);
    try {
      await commit.mutateAsync(job.id);
    } catch (err) {
      setCommitError(err instanceof ApiClientError ? err.message : 'Could not commit this import.');
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge>{job.total_rows} rows</Badge>
        <Badge tone="success">{job.valid_rows} valid</Badge>
        <Badge tone="warning">{job.duplicate_rows} duplicate</Badge>
        <Badge tone="danger">{job.invalid_rows} invalid</Badge>
        <Badge tone="danger">{job.dnc_rows} on DNC list</Badge>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Column mapping</p>
        <div className="mt-2 grid max-h-48 grid-cols-2 gap-2 overflow-y-auto rounded-md border border-ink-200 p-3 sm:grid-cols-3">
          {headers.map((header) => (
            <label key={header} className="flex flex-col text-xs text-ink-700">
              <span className="truncate font-medium">{header}</span>
              <select
                className="mt-1 rounded border border-ink-300 bg-white px-2 py-1"
                value={mapping[header] ?? ''}
                onChange={(e) => updateHeader(header, e.target.value)}
              >
                <option value="">(ignore)</option>
                {IMPORTABLE_LEAD_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <Button
          variant="secondary"
          className="mt-2"
          onClick={applyMapping}
          disabled={updateMapping.isPending}
        >
          {updateMapping.isPending ? 'Re-validating...' : 'Apply mapping & re-validate'}
        </Button>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Preview</p>
        <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-ink-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-ink-50 text-ink-500">
              <tr>
                <th className="px-3 py-2">Row</th>
                <th className="px-3 py-2">Result</th>
                <th className="px-3 py-2">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {(previewRows.data ?? []).slice(0, 50).map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-1.5">{r.row_number}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={r.result === 'valid' ? 'success' : r.result === 'duplicate' ? 'warning' : 'danger'}>
                      {r.result}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-ink-500">
                    {Object.values(r.raw_data).filter(Boolean).join(', ')}
                    {r.error_message ? ` — ${r.error_message}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {commitError && <Alert>{commitError}</Alert>}
      <Button onClick={handleCommit} disabled={commit.isPending || job.valid_rows === 0}>
        {commit.isPending ? 'Importing...' : `Import ${job.valid_rows} lead${job.valid_rows === 1 ? '' : 's'}`}
      </Button>
    </div>
  );
}
