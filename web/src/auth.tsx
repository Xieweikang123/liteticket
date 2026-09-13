import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.ts';
import type { AuthUser, Permission } from './api.ts';

interface AuthState {
  user: AuthUser | null;
  /**
   * Capabilities in force, resolved by the server on each login / boot. The UI
   * uses these only to decide what to *offer*; the API enforces them on every
   * request, so hiding a control is cosmetic and never the security boundary.
   */
  permissions: Permission[];
  /** True until the stored token has been checked against the server. */
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Holds the current session.
 *
 * The token lives in localStorage, and the *authoritative* identity is
 * re-read from /auth/me on boot rather than decoded from the token: that way a
 * revoked token or a changed role is reflected on the next load instead of
 * being trusted from stale local state.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * Sign out. The server is told to delete the session row first, so the
   * credential is revoked rather than merely forgotten; local state is cleared
   * regardless, and a failed call must not trap the user in the app. The token
   * is read before clearing because the request attaches it from localStorage.
   */
  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Best-effort: the session still expires on its own.
    }
    setToken(null);
    setUser(null);
    setPermissions([]);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((me) => {
        if (cancelled) return;
        // /auth/me carries the owner's identity and effective permissions for
        // a user-bound token, so no second call is needed. An unbound machine
        // token has no user and stays authorized-but-anonymous.
        setUser(me.user ?? null);
        setPermissions(me.permissions ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setToken(null);
          setUser(null);
          setPermissions([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    setToken(res.token);
    setUser(res.user);
    setPermissions(res.permissions ?? []);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, permissions, loading, login, logout }),
    [user, permissions, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Whether the current session holds a capability. UI gating only — the server
 * re-checks on every request. Kept as a free function so a component can test a
 * permission without reading the whole context.
 */
export function can(permissions: Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}
