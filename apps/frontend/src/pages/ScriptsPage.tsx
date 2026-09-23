import { useRef, useState } from 'react';
import { FileText, Plus, Trash2, Upload } from 'lucide-react';
import { PROMPT_VARIABLES } from '@shivanshconnect/shared';
import { useAuth } from '../hooks/useAuth';
import {
  useCreateScript,
  useDeleteScript,
  useScriptTemplates,
  useScripts,
  useUpdateScript,
  useUploadScript,
} from '../hooks/useScripts';
import { Alert, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';
import { handlePlaceholderPaste } from '../lib/placeholderPaste';

export function ScriptsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const [page, setPage] = useState(1);
  const scriptsQuery = useScripts(page, 50);
  const deleteScript = useDeleteScript();
  const uploadScript = useUploadScript();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const scripts = scriptsQuery.data?.data ?? [];
  const pagination = scriptsQuery.data?.pagination;

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploadNotice(null);
    try {
      const { message } = await uploadScript.mutateAsync(file);
      // Placeholders like [First Name] or <Phone Number> get auto-converted
      // to {{first_name}} etc. on upload (see normalizePlaceholders in
      // @shivanshconnect/shared) - the message names what changed, if
      // anything, so the user knows to double-check unmapped ones.
      if (message && message !== 'Script uploaded.') setUploadNotice(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Scripts</h1>
          <p className="mt-1 text-sm text-ink-500">Call scripts with {'{{variables}}'}, usable standalone or attached to an agent.</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <input ref={fileInputRef} type="file" accept=".txt,.md,.docx,.pdf" className="hidden" onChange={handleUpload} />
            <Button variant="secondary" disabled={uploadScript.isPending} onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" /> {uploadScript.isPending ? 'Uploading...' : 'Upload'}
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New script
            </Button>
          </div>
        )}
      </div>

      {error && <div className="mt-4"><Alert>{error}</Alert></div>}
      {uploadNotice && (
        <div className="mt-4">
          <Alert variant="info">{uploadNotice}</Alert>
        </div>
      )}
      {creating && <ScriptEditor onClose={() => setCreating(false)} />}

      {scriptsQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading scripts...</p>}

      {!scriptsQuery.isLoading && scripts.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <FileText className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No scripts yet</p>
          <p className="mt-1 text-sm text-ink-500">Create one from a template, write your own, or upload a file.</p>
        </Card>
      )}

      <div className="mt-6 space-y-3">
        {scripts.map((script) =>
          editingId === script.id ? (
            <ScriptEditor key={script.id} scriptId={script.id} initialName={script.name} initialContent={script.content} onClose={() => setEditingId(null)} />
          ) : (
            <Card key={script.id} className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-ink-900">{script.name}</p>
                <p className="text-xs text-ink-500">
                  v{script.version} &middot; {script.source}
                  {script.agent_id ? ' · attached to an agent' : ''}
                </p>
              </div>
              {canManage && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setEditingId(script.id)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => deleteScript.mutate(script.id)} aria-label="Delete script">
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              )}
            </Card>
          ),
        )}
      </div>

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>
            Page {pagination.page} of {pagination.total_pages} ({pagination.total} scripts)
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

function ScriptEditor({
  scriptId,
  initialName,
  initialContent,
  onClose,
}: {
  scriptId?: string;
  initialName?: string;
  initialContent?: string;
  onClose: () => void;
}): JSX.Element {
  const createScript = useCreateScript();
  const updateScript = useUpdateScript();
  const templatesQuery = useScriptTemplates();
  const [name, setName] = useState(initialName ?? '');
  const [content, setContent] = useState(initialContent ?? '');
  const [error, setError] = useState<string | null>(null);
  const [placeholderNotice, setPlaceholderNotice] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (scriptId) {
        await updateScript.mutateAsync({ id: scriptId, name, content });
      } else {
        await createScript.mutateAsync({ name, content, source: 'editor' });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save this script.');
    }
  }

  const pending = createScript.isPending || updateScript.isPending;

  return (
    <Card className="mt-6">
      <form className="space-y-3" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div className="max-w-sm">
          <Label htmlFor="script_name">Name</Label>
          <Input id="script_name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
        </div>
        {!scriptId && (
          <div className="flex flex-wrap gap-1.5">
            {(templatesQuery.data ?? []).map((t) => (
              <button
                key={t.key}
                type="button"
                className="rounded-full border border-ink-300 bg-white px-3 py-1 text-xs text-ink-700 hover:bg-ink-50"
                onClick={() => {
                  setContent(t.content);
                  if (!name) setName(t.name);
                }}
              >
                Use "{t.name}" template
              </button>
            ))}
          </div>
        )}
        <div>
          <Label htmlFor="script_content">Content</Label>
          <textarea
            id="script_content"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={10}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onPaste={(e) => handlePlaceholderPaste(e, content, setContent, setPlaceholderNotice)}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PROMPT_VARIABLES.map((v) => (
              <code key={v} className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">
                {`{{${v}}}`}
              </code>
            ))}
          </div>
          {placeholderNotice && <p className="mt-1.5 text-xs text-ink-500">{placeholderNotice}</p>}
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving...' : 'Save script'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
