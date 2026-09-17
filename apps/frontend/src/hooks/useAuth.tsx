import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@shivanshconnect/shared';
import { supabase } from '../lib/supabaseClient';
import { api } from '../lib/apiClient';

interface AuthContextValue {
  session: Session | null;
  sessionLoading: boolean;
  me: MeResponse | undefined;
  meLoading: boolean;
  meError: unknown;
  hasPermission: (key: string) => boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setSessionLoading(false);
      queryClient.invalidateQueries({ queryKey: ['me'] });
    });

    return () => listener.subscription.unsubscribe();
  }, [queryClient]);

  const {
    data: me,
    isLoading: meLoading,
    error: meError,
  } = useQuery({
    queryKey: ['me', session?.user.id],
    queryFn: () => api.get<MeResponse>('/me'),
    enabled: !!session,
    retry: false,
    staleTime: 60_000,
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      sessionLoading,
      me,
      meLoading,
      meError,
      hasPermission: (key: string) => !!me?.permissions.includes(key),
      signOut: async () => {
        await supabase.auth.signOut();
        queryClient.clear();
      },
    }),
    [session, sessionLoading, me, meLoading, meError, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
