import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { FullScreenSpinner } from './FullScreenSpinner';
import { ApiClientError } from '../lib/apiClient';

export function ProtectedRoute(): JSX.Element {
  const { session, sessionLoading, meLoading, me, meError } = useAuth();
  const location = useLocation();

  if (sessionLoading || (session && meLoading)) {
    return <FullScreenSpinner />;
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // A cached /me (useAuth's instant-reload cache) can still be present when
  // the fresh /me fails - an auth rejection must still send the user back
  // to login rather than leave them in the app on stale data.
  const authRejected = meError instanceof ApiClientError && (meError.status === 401 || meError.status === 403);
  if (session && meError && (!me || authRejected)) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
