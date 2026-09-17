import { Sparkles } from 'lucide-react';
import { useAgentImprovements } from '../../hooks/useAgents';
import { Card } from '../../components/ui';

export function ImprovementsTab({ agentId }: { agentId: string }): JSX.Element {
  const improvementsQuery = useAgentImprovements(agentId);
  const improvements = improvementsQuery.data ?? [];

  if (improvementsQuery.isLoading) return <p className="text-sm text-ink-500">Loading improvements...</p>;

  if (improvements.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center py-16 text-center">
        <Sparkles className="h-10 w-10 text-ink-300" />
        <p className="mt-3 text-sm font-medium text-ink-700">No improvements yet</p>
        <p className="mt-1 max-w-sm text-sm text-ink-500">
          This tab is populated automatically after calls are evaluated - that arrives in Phase 11's evaluator. There
          is nothing to show here yet, and nothing fake to show in the meantime.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {improvements.map((imp) => (
        <Card key={imp.id}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink-900">{imp.issue}</p>
            <span className="text-xs text-ink-500">{Math.round(imp.confidence * 100)}% confidence &middot; seen {imp.frequency}x</span>
          </div>
          <p className="mt-2 text-sm text-ink-700">{imp.suggested_change}</p>
          <p className="mt-1 text-xs text-ink-500">Status: {imp.status}</p>
        </Card>
      ))}
    </div>
  );
}
