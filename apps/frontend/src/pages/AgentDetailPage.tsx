import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { AGENT_ROLE_LABELS } from '@shivanshconnect/shared';
import { useAgent } from '../hooks/useAgents';
import { Badge, Card } from '../components/ui';
import { ConfigurationTab } from './agent/ConfigurationTab';
import { VersionsTab } from './agent/VersionsTab';
import { ScriptsTab } from './agent/ScriptsTab';
import { KnowledgeBaseTab } from './agent/KnowledgeBaseTab';
import { PreviewTab } from './agent/PreviewTab';
import { ImprovementsTab } from './agent/ImprovementsTab';

const TABS = ['Configuration', 'Versions', 'Scripts', 'Knowledge Base', 'Preview', 'Improvements'] as const;
type Tab = (typeof TABS)[number];

const STATUS_TONE = { draft: 'neutral', active: 'success', inactive: 'warning' } as const;

export function AgentDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const agentQuery = useAgent(id);
  const [tab, setTab] = useState<Tab>('Configuration');

  if (agentQuery.isLoading) return <p className="text-sm text-ink-500">Loading agent...</p>;
  if (!agentQuery.data) return <p className="text-sm text-ink-500">Agent not found.</p>;

  const agent = agentQuery.data;

  return (
    <div>
      <Link to="/ai-agents" className="inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Back to AI Agents
      </Link>

      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-ink-900">{agent.name}</h1>
        <Badge tone={STATUS_TONE[agent.status]}>{agent.status}</Badge>
      </div>
      <p className="mt-1 text-sm text-ink-500">
        {AGENT_ROLE_LABELS[agent.role]}
        {agent.description ? ` · ${agent.description}` : ''}
      </p>

      <div className="mt-6 border-b border-ink-200">
        <nav className="-mb-px flex gap-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'whitespace-nowrap border-b-2 border-gold-500 pb-3 text-sm font-medium text-ink-900'
                  : 'whitespace-nowrap border-b-2 border-transparent pb-3 text-sm font-medium text-ink-500 hover:text-ink-700'
              }
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-6">
        {tab === 'Configuration' && <ConfigurationTab agentId={agent.id} />}
        {tab === 'Versions' && <VersionsTab agentId={agent.id} />}
        {tab === 'Scripts' && <ScriptsTab agentId={agent.id} />}
        {tab === 'Knowledge Base' && <KnowledgeBaseTab agentId={agent.id} />}
        {tab === 'Preview' && (
          agent.current_version_id ? (
            <PreviewTab agentId={agent.id} />
          ) : (
            <Card className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm font-medium text-ink-700">No published version yet</p>
              <p className="mt-1 text-sm text-ink-500">Publish a version on the Configuration tab to preview it.</p>
            </Card>
          )
        )}
        {tab === 'Improvements' && <ImprovementsTab agentId={agent.id} />}
      </div>
    </div>
  );
}
