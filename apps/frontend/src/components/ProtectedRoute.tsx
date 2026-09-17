import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { FullScreenSpinner } from './FullScreenSpinner';

export function ProtectedRoute(): JSX.Element {
  const { session, sessionLoading, meLoading, me, meError } = useAuth();
  const location = useLocation();

  if (sessionLoading || (session && meLoading)) {
    return <FullScreenSpinner />;
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (session && !me && meError) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
