import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { AGENT_ROLES, AGENT_ROLE_LABELS, type AgentRole, type AiAgent } from '@shivanshconnect/shared';
import { useAuth } from '../hooks/useAuth';
import { useAgents, useCreateAgent, useDeleteAgent } from '../hooks/useAgents';
import { Alert, Badge, Button, Card, Input, Label } from '../components/ui';
import { ApiClientError } from '../lib/apiClient';

const STATUS_TONE: Record<AiAgent['status'], 'neutral' | 'success' | 'warning'> = {
  draft: 'neutral',
  active: 'success',
  inactive: 'warning',
};

export function AgentsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);

  const agentsQuery = useAgents(page);
  const agents = agentsQuery.data?.data ?? [];
  const pagination = agentsQuery.data?.pagination;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">AI Agents</h1>
          <p className="mt-1 text-sm text-ink-500">
            Configure the AI personas that make and take calls - personality, prompt, knowledge base and scripts.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> New agent
          </Button>
        )}
      </div>

      {showCreate && <CreateAgentForm onClose={() => setShowCreate(false)} />}

      {agentsQuery.isLoading && <p className="mt-8 text-sm text-ink-500">Loading agents...</p>}

      {!agentsQuery.isLoading && agents.length === 0 && (
        <Card className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <Bot className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No AI agents yet</p>
          <p className="mt-1 text-sm text-ink-500">Create one to configure its personality, prompt and knowledge base.</p>
        </Card>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <Card key={agent.id} className="flex flex-col">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <Link to={`/ai-agents/${agent.id}`} className="truncate text-sm font-semibold text-ink-900 hover:underline">
                  {agent.name}
                </Link>
                <p className="mt-1 text-xs text-ink-500">{AGENT_ROLE_LABELS[agent.role]}</p>
              </div>
              <Badge tone={STATUS_TONE[agent.status]}>{agent.status}</Badge>
            </div>
            {agent.description && <p className="mt-3 line-clamp-2 text-xs text-ink-500">{agent.description}</p>}
            <div className="mt-4 flex items-center justify-between">
              <Link to={`/ai-agents/${agent.id}`}>
                <Button variant="secondary">Configure</Button>
              </Link>
              {canManage && <DeleteAgentButton agent={agent} />}
            </div>
          </Card>
        ))}
      </div>

      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <span>
            Page {pagination.page} of {pagination.total_pages} ({pagination.total} agents)
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

function DeleteAgentButton({ agent }: { agent: AiAgent }): JSX.Element {
  const deleteAgent = useDeleteAgent();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button variant="danger" disabled={deleteAgent.isPending} onClick={() => deleteAgent.mutate(agent.id)}>
          Confirm
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button variant="ghost" onClick={() => setConfirming(true)} aria-label="Delete agent">
      <Trash2 className="h-4 w-4 text-red-600" />
    </Button>
  );
}

function CreateAgentForm({ onClose }: { onClose: () => void }): JSX.Element {
  const createAgent = useCreateAgent();
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('sales_agent');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createAgent.mutateAsync({ name, role, description: description || null });
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create this agent.');
    }
  }

  return (
    <Card className="mt-6 max-w-xl">
      <h2 className="text-sm font-semibold text-ink-900">New AI agent</h2>
      <p className="mt-1 text-xs text-ink-500">
        Pick a role to start. Personality, prompt, LLM and knowledge base are configured on the agent's page next.
      </p>
      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="agent_name">Name</Label>
          <Input id="agent_name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
        </div>
        <div>
          <Label htmlFor="agent_role">Role</Label>
          <select
            id="agent_role"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
          >
            {AGENT_ROLES.map((r) => (
              <option key={r} value={r}>
                {AGENT_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="agent_description">Description (optional)</Label>
          <textarea
            id="agent_description"
            className="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={createAgent.isPending}>
            {createAgent.isPending ? 'Creating...' : 'Create agent'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
