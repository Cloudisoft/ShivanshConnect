import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/AuthLayout';
import { Alert, Button, Input, Label } from '../../components/ui';
import { api, ApiClientError } from '../../lib/apiClient';
import { supabase } from '../../lib/supabaseClient';

function readHashTokens(): { access_token: string; refresh_token: string } | null {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  if (access_token && refresh_token) return { access_token, refresh_token };
  return null;
}

export function ResetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = readHashTokens();
      if (tokens) {
        await api.post('/auth/password-reset/confirm', {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          new_password: password,
        });
      } else {
        // Session was already established by detectSessionInUrl.
        const { error: updateError } = await supabase.auth.updateUser({ password });
        if (updateError) throw updateError;
      }
      await supabase.auth.signOut();
      navigate('/login', { replace: true, state: { resetSuccess: true } });
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'This reset link is invalid or has expired. Request a new one.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Set a new password">
      <form className="space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoFocus
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Updating...' : 'Update password'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-500">
        <Link to="/login" className="font-medium text-ink-900 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
