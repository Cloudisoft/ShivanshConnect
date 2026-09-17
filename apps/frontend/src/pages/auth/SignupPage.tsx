import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/AuthLayout';
import { Alert, Button, Input, Label } from '../../components/ui';
import { api, ApiClientError } from '../../lib/apiClient';
import { supabase } from '../../lib/supabaseClient';

interface SignupResponse {
  organization: { id: string; name: string };
  user: { id: string; email: string };
  session: { access_token: string; refresh_token: string } | null;
  email_confirmation_required: boolean;
}

export function SignupPage(): JSX.Element {
  const navigate = useNavigate();
  const [organizationName, setOrganizationName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.post<SignupResponse>('/auth/signup', {
        organization_name: organizationName,
        full_name: fullName,
        email,
        password,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });

      if (result.session) {
        await supabase.auth.setSession({
          access_token: result.session.access_token,
          refresh_token: result.session.refresh_token,
        });
        navigate('/dashboard', { replace: true });
      } else {
        navigate('/verify-email', { replace: true, state: { email } });
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create your account.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Create your organization" subtitle="Set up ShivanshConnect for your team.">
      <form className="space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="organization_name">Organization name</Label>
          <Input
            id="organization_name"
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder="Acme Contact Center"
            required
            minLength={2}
          />
        </div>
        <div>
          <Label htmlFor="full_name">Your full name</Label>
          <Input
            id="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Doe"
            required
          />
        </div>
        <div>
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@acme.com"
            required
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
            minLength={8}
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Creating account...' : 'Create account'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-500">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-ink-900 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
