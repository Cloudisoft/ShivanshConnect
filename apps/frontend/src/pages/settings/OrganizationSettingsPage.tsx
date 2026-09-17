import { useEffect, useState, type FormEvent } from 'react';
import { useOrganization, useUpdateOrganization } from '../../hooks/useOrganization';
import { Alert, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

export function OrganizationSettingsPage(): JSX.Element {
  const { data: org, isLoading } = useOrganization();
  const updateOrg = useUpdateOrganization();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (org) {
      setName(org.name);
      setTimezone(org.timezone);
    }
  }, [org]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    try {
      await updateOrg.mutateAsync({ name, timezone });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not update organization.');
    }
  }

  if (isLoading) return <p className="text-sm text-ink-500">Loading...</p>;

  return (
    <Card className="max-w-xl">
      <h2 className="text-base font-semibold text-ink-900">Organization</h2>
      <p className="mt-1 text-sm text-ink-500">Update your organization&apos;s name and timezone.</p>
      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        {success && <Alert variant="success">Organization updated.</Alert>}
        <div>
          <Label htmlFor="org_name">Organization name</Label>
          <Input id="org_name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="org_timezone">Timezone</Label>
          <Input id="org_timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </div>
        <Button type="submit" disabled={updateOrg.isPending}>
          {updateOrg.isPending ? 'Saving...' : 'Save changes'}
        </Button>
      </form>
    </Card>
  );
}
