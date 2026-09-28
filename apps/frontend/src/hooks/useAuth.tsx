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

const ME_CACHE_KEY = 'sc:me';

function readCachedMe(userId: string | undefined): MeResponse | undefined {
  if (!userId) return undefined;
  try {
    const raw = localStorage.getItem(ME_CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { userId: string; me: MeResponse };
    return parsed.userId === userId ? parsed.me : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedMe(userId: string, me: MeResponse): void {
  try {
    localStorage.setItem(ME_CACHE_KEY, JSON.stringify({ userId, me }));
  } catch {
    // storage full/blocked - the app still works, just without the instant reload
  }
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      setSessionLoading(false);
      // Sign-in/sign-out already refetch /me through the ['me', userId]
      // query key changing - invalidating on those too fetched /me twice
      // on every login, and TOKEN_REFRESHED (hourly) refetched it for no
      // reason. Only a profile change needs an explicit refetch.
      if (event === 'USER_UPDATED') queryClient.invalidateQueries({ queryKey: ['me'] });
    });

    return () => listener.subscription.unsubscribe();
  }, [queryClient]);

  const userId = session?.user.id;
  const {
    data: me,
    isLoading: meLoading,
    error: meError,
  } = useQuery({
    queryKey: ['me', userId],
    queryFn: () => api.get<MeResponse>('/me'),
    enabled: !!session,
    retry: false,
    staleTime: 60_000,
    // The last /me this browser saw for this user, so a reload renders the
    // app immediately instead of a full-screen spinner while /me travels
    // to the US and back. initialDataUpdatedAt 0 marks it stale, so the
    // real /me still refetches right away in the background. Permissions
    // are enforced server-side on every request regardless.
    initialData: () => readCachedMe(userId),
    initialDataUpdatedAt: 0,
  });

  useEffect(() => {
    if (me && userId) writeCachedMe(userId, me);
  }, [me, userId]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      sessionLoading,
      me,
      meLoading,
      meError,
      hasPermission: (key: string) => !!me?.permissions.includes(key),
      signOut: async () => {
        // The cached /me is kept: it is keyed to this user id, so it only
        // ever renders for the same user signing back in (instantly), and
        // /me refetches straight away regardless.
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
