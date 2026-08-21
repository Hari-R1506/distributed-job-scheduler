import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setAccessToken, setUnauthenticatedHandler } from './api';

interface Me {
  kind: string;
  user: { id: string; email: string; name: string };
  memberships: { role: string; org: { id: string; name: string; slug: string } }[];
}

interface AuthState {
  user: Me['user'] | null;
  orgId: string | null;
  orgName: string | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(input: {
    email: string;
    password: string;
    name: string;
    org_name: string;
  }): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me['user'] | null>(null);
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMe(): Promise<void> {
    const me = await api.get<Me>('/auth/me');
    setUser(me.user);
    const first = me.memberships[0];
    setOrg(first ? { id: first.org.id, name: first.org.name } : null);
  }

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser(null);
      setOrg(null);
    });

    // On a fresh page load the access token is gone (it only ever lived in
    // memory) but the refresh cookie may still be valid — so try to restore the
    // session silently before showing the login screen.
    void (async () => {
      try {
        const res = await api.post<{ access_token: string }>('/auth/refresh');
        setAccessToken(res.access_token);
        await loadMe();
      } catch {
        // Not signed in. Expected on first visit.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const value: AuthState = {
    user,
    orgId: org?.id ?? null,
    orgName: org?.name ?? null,
    loading,
    async login(email, password) {
      const res = await api.post<{ access_token: string }>('/auth/login', { email, password });
      setAccessToken(res.access_token);
      await loadMe();
    },
    async register(input) {
      const res = await api.post<{ access_token: string }>('/auth/register', input);
      setAccessToken(res.access_token);
      await loadMe();
    },
    async logout() {
      await api.post('/auth/logout').catch(() => {});
      setAccessToken(null);
      setUser(null);
      setOrg(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
