import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Input, Label } from '../../components/ui';
import { supabase } from '../../lib/supabaseClient';

export function SecuritySettingsPage(): JSX.Element {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setSuccess(true);
      setPassword('');
      setConfirmPassword('');
    } catch {
      setError('Could not update your password. Try signing out and back in, then retry.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <h2 className="text-base font-semibold text-ink-900">Security</h2>
      <p className="mt-1 text-sm text-ink-500">Change your password.</p>
      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        {error && <Alert>{error}</Alert>}
        {success && <Alert variant="success">Password updated.</Alert>}
        <div>
          <Label htmlFor="new_password">New password</Label>
          <Input
            id="new_password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>
        <div>
          <Label htmlFor="confirm_password">Confirm new password</Label>
          <Input
            id="confirm_password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>
        <Button type="submit" disabled={loading}>
          {loading ? 'Updating...' : 'Update password'}
        </Button>
      </form>
    </Card>
  );
}
