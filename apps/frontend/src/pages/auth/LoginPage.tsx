import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/AuthLayout';
import { Alert, Button, Input, Label } from '../../components/ui';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabaseClient';
import { api } from '../../lib/apiClient';
import { preloadAllPages } from '../../lib/lazyPage';

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Download the app's pages (dashboard, charts...) while the user is still
  // typing, so signing in lands on a dashboard that's ready to draw.
  useEffect(() => {
    preloadAllPages();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError('Incorrect email or password.');
        return;
      }
      const destination = location.state?.from ?? '/dashboard';
      if (destination === '/dashboard') {
        // Start the dashboard's data loading now, in parallel with /me -
        // otherwise it only starts after ProtectedRoute's /me round trip
        // finishes, a strictly sequential chain of round trips on every
        // login. Same keys/params as useDashboardMetrics/useDashboardCharts
        // with the page's default 'today' period, so the page picks these
        // results straight up. Errors are ignored here; the page's own
        // queries surface them.
        const period = { period: 'today' as const };
        void queryClient.prefetchQuery({ queryKey: ['dashboard', 'metrics', period], queryFn: () => api.get('/dashboard?period=today') });
        void queryClient.prefetchQuery({ queryKey: ['dashboard', 'charts', period], queryFn: () => api.get('/dashboard/charts?period=today') });
      }
      navigate(destination, { replace: true });
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back to ShivanshConnect.">
      <form className="space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-xs font-medium text-ink-500 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-500">
        Don&apos;t have an account?{' '}
        <Link to="/signup" className="font-medium text-ink-900 hover:underline">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}
