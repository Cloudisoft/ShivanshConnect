import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './hooks/useAuth';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Cleared on every fresh page load, not just once ever - see
// ErrorBoundary.tsx's RELOAD_GUARD_KEY. Without this, one earlier deploy's
// auto-reload would permanently disable the same recovery for every LATER
// deploy too, for as long as this tab's sessionStorage lives.
sessionStorage.removeItem('sc_chunk_reload_attempted');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="ShivanshConnect">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
