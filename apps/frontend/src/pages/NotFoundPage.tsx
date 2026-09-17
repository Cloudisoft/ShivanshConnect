import { Link } from 'react-router-dom';

export function NotFoundPage(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-50 text-center">
      <p className="text-sm font-semibold text-gold-600">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">Page not found</h1>
      <Link to="/dashboard" className="mt-4 text-sm font-medium text-ink-700 hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}
