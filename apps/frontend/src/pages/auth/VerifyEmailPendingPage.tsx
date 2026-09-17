import { Link, useLocation } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { AuthLayout } from '../../components/AuthLayout';

export function VerifyEmailPendingPage(): JSX.Element {
  const location = useLocation() as { state?: { email?: string } };
  const email = location.state?.email;

  return (
    <AuthLayout title="Check your email">
      <div className="flex flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gold-100">
          <MailCheck className="h-6 w-6 text-gold-700" />
        </div>
        <p className="mt-4 text-sm text-ink-600">
          We sent a verification link{email ? <> to <strong>{email}</strong></> : ''}. Click it to
          activate your account, then sign in.
        </p>
      </div>
      <p className="mt-6 text-center text-sm text-ink-500">
        <Link to="/login" className="font-medium text-ink-900 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
