import { accessToken, login } from './auth';

export type Role = 'lead' | 'planner' | 'viewer';
export interface Me {
  sub: string;
  name: string;
  role: Role;
  tenantId: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API through /api (Vite proxy in dev, nginx in compose). `version` becomes If-Match. */
export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; version?: number } = {},
): Promise<T> {
  const token = await accessToken();
  if (!token) {
    await login();
    throw new ApiError(401, 'signing in');
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.version !== undefined) headers['if-match'] = `"${opts.version}"`;
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (r.status === 401) {
    await login();
    throw new ApiError(401, 'session expired');
  }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string } | null)?.error ?? r.statusText);
  return data as T;
}

type Listener = (type: string, data: unknown) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

/** One SSE stream per tab (tenant-filtered by the API); pages subscribe to refresh when their data changes. */
export async function openLive(): Promise<void> {
  const token = await accessToken();
  if (!token || source) return;
  source = new EventSource(`/api/events?access_token=${encodeURIComponent(token)}`);
  for (const t of ['queue', 'campaign', 'proposal', 'card'])
    source.addEventListener(t, (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      for (const l of listeners) l(t, data);
    });
}

export function onLive(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
export const when = (t: string | null | undefined) =>
  t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
