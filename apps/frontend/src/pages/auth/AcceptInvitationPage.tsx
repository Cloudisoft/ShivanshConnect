import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../../components/AuthLayout';
import { Alert, Button, Input, Label } from '../../components/ui';
import { api, ApiClientError } from '../../lib/apiClient';
import { supabase } from '../../lib/supabaseClient';

interface AcceptInvitationResponse {
  account_created: boolean;
  session: { access_token: string; refresh_token: string } | null;
}

export function AcceptInvitationPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError('This invitation link is missing its token.');
      return;
    }

    setLoading(true);
    try {
      const result = await api.post<AcceptInvitationResponse>('/auth/accept-invitation', {
        token,
        full_name: fullName,
        password,
      });

      if (result.session) {
        await supabase.auth.setSession(result.session);
        navigate('/dashboard', { replace: true });
      } else {
        navigate('/login', { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not accept this invitation.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Join your team" subtitle="Set your name and password to finish joining.">
      <form className="space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        {!token && <Alert>This invitation link is missing its token. Ask an admin to resend it.</Alert>}
        <div>
          <Label htmlFor="full_name">Your full name</Label>
          <Input id="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoFocus />
        </div>
        <div>
          <Label htmlFor="password">Choose a password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading || !token}>
          {loading ? 'Joining...' : 'Join organization'}
        </Button>
      </form>
    </AuthLayout>
  );
}
