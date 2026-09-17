import { useAuth } from '../hooks/useAuth';
import { Card } from '../components/ui';

export function DashboardPage(): JSX.Element {
  const { me } = useAuth();

  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">
        Welcome, {me?.user.full_name || me?.user.email}
      </h1>
      <p className="mt-1 text-sm text-ink-500">
        {me?.organization.name} &middot;{' '}
        <span className="capitalize">{me?.roles.map((r) => r.name.replace(/_/g, ' ').toLowerCase()).join(', ')}</span>
      </p>

      <Card className="mt-8">
        <h2 className="text-base font-semibold text-ink-900">You&apos;re set up</h2>
        <p className="mt-2 text-sm text-ink-600">
          Your organization, account and permissions are ready. Real-time metrics, call volume and
          campaign performance land on this dashboard in a later build phase - Phase 1 only
          provisions your organization and access, so there is nothing to fake here yet.
        </p>
      </Card>
    </div>
  );
}
