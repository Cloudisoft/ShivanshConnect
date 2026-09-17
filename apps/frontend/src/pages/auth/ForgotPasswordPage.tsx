import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '../../components/AuthLayout';
import { Alert, Button, Input, Label } from '../../components/ui';
import { api, ApiClientError } from '../../lib/apiClient';

export function ForgotPasswordPage(): JSX.Element {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post('/auth/password-reset/request', { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a link to set a new one.">
      {sent ? (
        <Alert variant="success">
          If an account exists for {email}, a password reset link is on its way.
        </Alert>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && <Alert>{error}</Alert>}
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Sending...' : 'Send reset link'}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-ink-500">
        <Link to="/login" className="font-medium text-ink-900 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
