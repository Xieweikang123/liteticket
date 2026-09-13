/**
 * The single point where the browser talks to the API.
 *
 * Every call goes through `request`, so the Authorization header, JSON
 * encoding, and error shape are handled once. A 401 clears the stored token
 * and notifies the app, so a revoked credential logs the user out instead of
 * leaving a half-broken page.
 */

const TOKEN_KEY = 'liteticket.token';

export type Role = 'admin' | 'agent';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface Ticket {
  id: number;
  subject: string;
  body: string;
  status: 'open' | 'pending' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  requesterEmail: string;
  requesterName: string | null;
  assigneeId: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  tags?: string[];
  assigneeName?: string | null;
}

export interface Comment {
  id: number;
  ticketId: number;
  body: string;
  authorId: number | null;
  authorEmail: string | null;
  isInternal: boolean;
  createdAt: string;
}

export interface TokenRow {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Stats {
  open: number;
  pending: number;
  closed: number;
  total: number;
}

/** Raised for any non-2xx response, carrying the server's message. */
export class ApiError extends Error {
  status: number;
  issues?: { path: string; message: string }[];

  constructor(status: number, message: string, issues?: { path: string; message: string }[]) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Called when the API rejects the stored token, so the app can log out. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Set for the login call, which must not send (or require) a token. */
  anonymous?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token && !opts.anonymous) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 401 && !opts.anonymous) {
    setToken(null);
    onUnauthorized?.();
    throw new ApiError(401, '登录已失效，请重新登录');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const p = payload as { error?: string; issues?: { path: string; message: string }[] } | null;
    throw new ApiError(res.status, p?.error ?? `请求失败 (${res.status})`, p?.issues);
  }

  return payload as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      anonymous: true,
    }),

  me: () =>
    request<{
      source: string;
      tokenId: number;
      userId: number | null;
      name: string;
      role: Role;
      /** Present only for a user-bound token. */
      user: AuthUser | null;
    }>('/auth/me'),

  stats: () => request<Stats>('/stats'),

  listTickets: (params: {
    status?: string;
    q?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ items: Ticket[]; total: number; limit: number; offset: number }>(
      `/tickets${suffix}`,
    );
  },

  getTicket: (id: number, includeInternal = true) =>
    request<Ticket & { comments: Comment[] }>(
      `/tickets/${id}${includeInternal ? '?includeInternal=true' : ''}`,
    ),

  createTicket: (input: {
    subject: string;
    body?: string;
    priority?: string;
    requesterEmail: string;
    requesterName?: string | null;
    assigneeId?: number | null;
    tags?: string[];
  }) => request<Ticket>('/tickets', { method: 'POST', body: input }),

  updateTicket: (id: number, patch: Record<string, unknown>) =>
    request<Ticket>(`/tickets/${id}`, { method: 'PATCH', body: patch }),

  deleteTicket: (id: number) => request<void>(`/tickets/${id}`, { method: 'DELETE' }),

  addComment: (id: number, input: { body: string; isInternal?: boolean }) =>
    request<Comment>(`/tickets/${id}/comments`, { method: 'POST', body: input }),

  listUsers: () => request<{ items: (AuthUser & { createdAt: string })[] }>('/users'),

  createUser: (input: { email: string; name: string; role?: Role; password?: string }) =>
    request<AuthUser>('/users', { method: 'POST', body: input }),

  updateUser: (id: number, patch: Record<string, unknown>) =>
    request<AuthUser>(`/users/${id}`, { method: 'PATCH', body: patch }),

  deleteUser: (id: number) => request<void>(`/users/${id}`, { method: 'DELETE' }),

  listTokens: () => request<{ items: TokenRow[] }>('/tokens'),

  createToken: (name: string) =>
    request<{ token: string; name: string }>('/tokens', { method: 'POST', body: { name } }),

  revokeToken: (id: number) => request<void>(`/tokens/${id}`, { method: 'DELETE' }),

  listTags: () => request<{ items: { id: number; name: string }[] }>('/tags'),
};
