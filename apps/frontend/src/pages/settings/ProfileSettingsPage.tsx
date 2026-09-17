import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { Alert, Button, Card, Input, Label } from '../../components/ui';
import { api, ApiClientError } from '../../lib/apiClient';

export function ProfileSettingsPage(): JSX.Element {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState(me?.user.full_name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const updateProfile = useMutation({
    mutationFn: (full_name: string) => api.patch('/me', { full_name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    try {
      await updateProfile.mutateAsync(fullName);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not update your profile.');
    }
  }

  return (
    <Card className="max-w-xl">
      <h2 className="text-base font-semibold text-ink-900">Profile</h2>
      <p className="mt-1 text-sm text-ink-500">Your personal account details.</p>
      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        {success && <Alert variant="success">Profile updated.</Alert>}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={me?.user.email ?? ''} disabled />
        </div>
        <div>
          <Label htmlFor="full_name">Full name</Label>
          <Input id="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </div>
        <Button type="submit" disabled={updateProfile.isPending}>
          {updateProfile.isPending ? 'Saving...' : 'Save changes'}
        </Button>
      </form>
    </Card>
  );
}
