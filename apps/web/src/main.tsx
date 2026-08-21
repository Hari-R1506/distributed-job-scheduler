import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { ApiError } from './lib/api';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polling is the baseline live-update mechanism: ~20 lines, survives
      // reconnects, needs no server-side fan-out. A WebSocket upgrade would
      // invalidate these same keys rather than pushing into the cache, so
      // there is one data path either way (ARCHITECTURE.md §29.8).
      refetchOnWindowFocus: true,
      // A hidden tab polling every 2s costs the API real traffic to render
      // pixels nobody is looking at.
      refetchIntervalInBackground: false,
      staleTime: 2_000,
      retry: (failureCount, error) => {
        // 4xx means the request was wrong; retrying cannot fix it and just
        // multiplies the error. Only retry transport/server failures.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
