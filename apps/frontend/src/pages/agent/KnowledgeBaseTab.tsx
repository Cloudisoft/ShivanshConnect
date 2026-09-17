import { useRef, useState } from 'react';
import { Database, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import {
  useCreateKnowledgeBase,
  useDeleteKnowledgeDocument,
  useKnowledgeBases,
  useKnowledgeDocuments,
  useReprocessKnowledgeDocument,
  useUploadKnowledgeDocument,
} from '../../hooks/useKnowledgeBases';
import { useAgentKnowledgeSearch } from '../../hooks/useAgents';
import { Alert, Badge, Button, Card, Input } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';
import type { KnowledgeDocument } from '@shivanshconnect/shared';

const STATUS_TONE: Record<KnowledgeDocument['status'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  uploaded: 'neutral',
  processing: 'warning',
  ready: 'success',
  failed: 'danger',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function KnowledgeBaseTab({ agentId }: { agentId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const kbsQuery = useKnowledgeBases(agentId);
  const createKb = useCreateKnowledgeBase();
  const [error, setError] = useState<string | null>(null);

  const kbs = kbsQuery.data ?? [];
  const kb = kbs[0];

  if (kbsQuery.isLoading) return <p className="text-sm text-ink-500">Loading knowledge base...</p>;

  if (!kb) {
    return (
      <Card className="flex flex-col items-center justify-center py-16 text-center">
        <Database className="h-10 w-10 text-ink-300" />
        <p className="mt-3 text-sm font-medium text-ink-700">No knowledge base yet</p>
        <p className="mt-1 max-w-sm text-sm text-ink-500">
          Create one to upload documents this agent can reference during calls (PDF, DOCX, TXT, CSV, MD).
        </p>
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
        {canManage && (
          <Button
            className="mt-4"
            disabled={createKb.isPending}
            onClick={async () => {
              setError(null);
              try {
                await createKb.mutateAsync({ name: 'Knowledge base', agent_id: agentId });
              } catch (err) {
                setError(err instanceof ApiClientError ? err.message : 'Could not create a knowledge base.');
              }
            }}
          >
            {createKb.isPending ? 'Creating...' : 'Create knowledge base'}
          </Button>
        )}
      </Card>
    );
  }

  return <KnowledgeBaseDocuments kbId={kb.id} agentId={agentId} canManage={canManage} />;
}

function KnowledgeBaseDocuments({ kbId, agentId, canManage }: { kbId: string; agentId: string; canManage: boolean }): JSX.Element {
  const docsQuery = useKnowledgeDocuments(kbId);
  const uploadDoc = useUploadKnowledgeDocument(kbId);
  const deleteDoc = useDeleteKnowledgeDocument(kbId);
  const reprocessDoc = useReprocessKnowledgeDocument(kbId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const docs = docsQuery.data ?? [];

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      await uploadDoc.mutateAsync(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {canManage && (
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">Documents</h3>
              <p className="mt-1 text-xs text-ink-500">PDF, DOCX, TXT, CSV or MD. Processing runs automatically after upload.</p>
            </div>
            <div>
              <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.csv,.md" className="hidden" onChange={handleFileChange} />
              <Button disabled={uploadDoc.isPending} onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" /> {uploadDoc.isPending ? 'Uploading...' : 'Upload document'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {docsQuery.isLoading && <p className="text-sm text-ink-500">Loading documents...</p>}

      {!docsQuery.isLoading && docs.length === 0 && (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-ink-500">No documents uploaded yet.</p>
        </Card>
      )}

      <div className="space-y-2">
        {docs.map((doc) => (
          <Card key={doc.id} className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-ink-900">{doc.file_name}</p>
                <Badge tone={STATUS_TONE[doc.status]}>{doc.status}</Badge>
              </div>
              <p className="mt-1 text-xs text-ink-500">
                {doc.file_type.toUpperCase()} &middot; {formatBytes(doc.size_bytes)} &middot; {new Date(doc.created_at).toLocaleString()}
              </p>
              {doc.status === 'failed' && doc.error_message && <p className="mt-1 text-xs text-red-600">{doc.error_message}</p>}
            </div>
            {canManage && (
              <div className="flex flex-shrink-0 gap-1">
                {doc.status === 'failed' && (
                  <Button variant="ghost" aria-label="Reprocess" onClick={() => reprocessDoc.mutate(doc.id)}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" aria-label="Delete document" onClick={() => deleteDoc.mutate(doc.id)}>
                  <Trash2 className="h-4 w-4 text-red-600" />
                </Button>
              </div>
            )}
          </Card>
        ))}
      </div>

      <TestRetrieval agentId={agentId} />
    </div>
  );
}

function TestRetrieval({ agentId }: { agentId: string }): JSX.Element {
  const search = useAgentKnowledgeSearch(agentId);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await search.mutateAsync({ query, top_k: 5 });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Search failed.');
    }
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-ink-900">Test retrieval</h3>
      <p className="mt-1 text-xs text-ink-500">Run a real query against this agent's knowledge base chunks.</p>
      <form className="mt-3 flex gap-2" onSubmit={handleSearch}>
        <Input placeholder="Ask a question..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" disabled={search.isPending || !query.trim()}>
          {search.isPending ? 'Searching...' : 'Search'}
        </Button>
      </form>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {search.data && (
        <div className="mt-4 space-y-2">
          {search.data.length === 0 && <p className="text-sm text-ink-500">No matching chunks found.</p>}
          {search.data.map((r) => (
            <div key={r.id} className="rounded-md border border-ink-200 p-3">
              <div className="flex items-center justify-between text-xs text-ink-500">
                <span>{r.document_file_name}</span>
                <span>{(r.similarity * 100).toFixed(1)}% match</span>
              </div>
              <p className="mt-1 text-sm text-ink-800">{r.content}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
