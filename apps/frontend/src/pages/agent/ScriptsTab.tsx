import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { PROMPT_VARIABLES } from '@shivanshconnect/shared';
import { useAuth } from '../../hooks/useAuth';
import { useCreateScript, useDeleteScript, useScriptTemplates, useScripts, useUpdateScript } from '../../hooks/useScripts';
import { Alert, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';
import { handlePlaceholderPaste } from '../../lib/placeholderPaste';

export function ScriptsTab({ agentId }: { agentId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const scriptsQuery = useScripts(1, 50, agentId);
  const deleteScript = useDeleteScript();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const scripts = scriptsQuery.data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">Scripts attached to this agent. Manage all scripts on the Scripts page.</p>
        <div className="flex gap-2">
          <Link to="/scripts">
            <Button variant="secondary">All scripts</Button>
          </Link>
          {canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New script
            </Button>
          )}
        </div>
      </div>

      {creating && <ScriptForm agentId={agentId} onClose={() => setCreating(false)} />}

      {scriptsQuery.isLoading && <p className="text-sm text-ink-500">Loading scripts...</p>}

      {!scriptsQuery.isLoading && scripts.length === 0 && (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <FileText className="h-8 w-8 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No scripts attached yet</p>
        </Card>
      )}

      <div className="space-y-3">
        {scripts.map((script) =>
          editingId === script.id ? (
            <ScriptForm key={script.id} agentId={agentId} scriptId={script.id} initialName={script.name} initialContent={script.content} onClose={() => setEditingId(null)} />
          ) : (
            <Card key={script.id} className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-ink-900">{script.name}</p>
                <p className="text-xs text-ink-500">v{script.version} &middot; {script.source}</p>
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
    </div>
  );
}

function ScriptForm({
  agentId,
  scriptId,
  initialName,
  initialContent,
  onClose,
}: {
  agentId: string;
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (scriptId) {
        await updateScript.mutateAsync({ id: scriptId, name, content });
      } else {
        await createScript.mutateAsync({ name, content, agent_id: agentId, source: 'editor' });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save this script.');
    }
  }

  const pending = createScript.isPending || updateScript.isPending;

  return (
    <Card>
      <form className="space-y-3" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div>
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
            rows={8}
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
