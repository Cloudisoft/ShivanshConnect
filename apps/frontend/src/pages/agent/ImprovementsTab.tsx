import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import type { AgentImprovementEvidence, ImprovementStatus } from '@shivanshconnect/shared';
import { useAgentImprovementsFiltered, useApplyAgentImprovement, useUpdateAgentImprovementStatus } from '../../hooks/useEvaluations';
import { useAuth } from '../../hooks/useAuth';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

const STATUS_TONE: Record<ImprovementStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  detected: 'neutral',
  under_review: 'warning',
  approved: 'success',
  rejected: 'danger',
  applied: 'success',
};

const STATUS_FILTERS: { label: string; value: ImprovementStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Detected', value: 'detected' },
  { label: 'Under review', value: 'under_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Applied', value: 'applied' },
];

/**
 * Phase 11: the real Improvements tab (spec sections 24/49), replacing
 * Phase 3's honest empty-state stub - a human-in-the-loop review queue
 * over ai_agent_improvements rows mined by services/
 * aggregateAgentImprovements.ts. Review -> Approve/Reject -> Apply
 * (creates a draft version and deep-links to the Versions tab to publish
 * it) - never an automatic prompt rewrite.
 */
export function ImprovementsTab({ agentId }: { agentId: string }): JSX.Element {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('agents.manage');
  const [filter, setFilter] = useState<ImprovementStatus | 'all'>('all');
  const improvementsQuery = useAgentImprovementsFiltered(agentId, filter === 'all' ? undefined : filter);
  const updateStatus = useUpdateAgentImprovementStatus(agentId);
  const applyImprovement = useApplyAgentImprovement(agentId);
  const [error, setError] = useState<string | null>(null);
  const [appliedDraftVersion, setAppliedDraftVersion] = useState<number | null>(null);

  const improvements = improvementsQuery.data ?? [];

  async function handleStatusChange(id: string, status: 'under_review' | 'approved' | 'rejected') {
    setError(null);
    try {
      await updateStatus.mutateAsync({ id, status });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not update this improvement.');
    }
  }

  async function handleApply(id: string) {
    setError(null);
    try {
      const result = await applyImprovement.mutateAsync(id);
      setAppliedDraftVersion(result.draft_version.version_number);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not apply this improvement.');
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {appliedDraftVersion !== null && (
        <Alert variant="success">
          Created draft version {appliedDraftVersion}. It is NOT published - open the Versions tab to review and
          publish it whenever you are ready.
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={
              filter === f.value
                ? 'rounded-full bg-ink-900 px-3 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-ink-200 px-3 py-1 text-xs font-medium text-ink-600 hover:bg-ink-50'
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {improvementsQuery.isLoading && <p className="text-sm text-ink-500">Loading improvements...</p>}

      {!improvementsQuery.isLoading && improvements.length === 0 && (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <Sparkles className="h-10 w-10 text-ink-300" />
          <p className="mt-3 text-sm font-medium text-ink-700">No improvements {filter === 'all' ? 'yet' : `in "${filter}"`}</p>
          <p className="mt-1 max-w-sm text-sm text-ink-500">
            This tab is populated automatically after this agent's calls are evaluated and the same issue recurs
            across more than one call. There is nothing to show here yet, and nothing fake to show in the meantime.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {improvements.map((imp) => {
          const evidence = imp.evidence as AgentImprovementEvidence;
          const occurrences = evidence?.occurrences ?? [];
          const latest = occurrences[occurrences.length - 1];
          return (
            <Card key={imp.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-ink-900">{imp.issue}</p>
                  <p className="text-xs text-ink-500">{Math.round(imp.confidence * 100)}% confidence &middot; seen {imp.frequency}x</p>
                </div>
                <Badge tone={STATUS_TONE[imp.status]}>{imp.status.replace('_', ' ')}</Badge>
              </div>

              <p className="mt-2 text-sm text-ink-700">
                <span className="font-semibold">Suggested change: </span>
                {imp.suggested_change}
              </p>

              {latest && (
                <p className="mt-2 text-xs text-ink-500">
                  Evidence: &ldquo;{latest.excerpt}&rdquo;{' '}
                  {imp.source_call_id && (
                    <Link to={`/cdr?call=${imp.source_call_id}`} className="text-ink-700 underline hover:text-ink-900">
                      view source call
                    </Link>
                  )}
                </p>
              )}

              {imp.affected_version_id && (
                <p className="mt-1 text-xs text-ink-500">Applied to draft version - see the Versions tab to publish it.</p>
              )}

              {canManage && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {imp.status === 'detected' && (
                    <Button variant="secondary" disabled={updateStatus.isPending} onClick={() => handleStatusChange(imp.id, 'under_review')}>
                      Review
                    </Button>
                  )}
                  {imp.status === 'under_review' && (
                    <>
                      <Button variant="primary" disabled={updateStatus.isPending} onClick={() => handleStatusChange(imp.id, 'approved')}>
                        Approve
                      </Button>
                      <Button variant="danger" disabled={updateStatus.isPending} onClick={() => handleStatusChange(imp.id, 'rejected')}>
                        Reject
                      </Button>
                    </>
                  )}
                  {imp.status === 'approved' && (
                    <Button variant="primary" disabled={applyImprovement.isPending} onClick={() => handleApply(imp.id)}>
                      Apply (create draft version)
                    </Button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
