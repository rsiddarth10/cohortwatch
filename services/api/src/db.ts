import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Role, User } from './auth.js';

/**
 * Every request runs in one transaction as cw_api with `app.tenant_id` set (SET LOCAL): Postgres row-level security
 * then shows only that tenant's rows (ADR 0019). The audit row for the request commits in the same transaction,
 * with an outbox row for `audit.v1`.
 */
export type Q = Pick<pg.PoolClient, 'query'>;

export async function withTenant<T>(pool: pg.Pool, user: User, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(user.tenantId)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export interface AuditEntry {
  action: 'VIEW' | 'DISMISS' | 'REPAIR' | 'APPROVE' | 'REJECT' | 'ERASE';
  resource: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

/** Who, what, when: core.audit + an outbox row to audit.v1, in the request's transaction. */
export async function audit(c: Q, user: User, e: AuditEntry, auditTopic: string): Promise<void> {
  const details = e.details ?? {};
  const r = await c.query<{ id: string; at: Date }>(
    `INSERT INTO core.audit (tenant_id, actor, role, action, resource, resource_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, at`,
    [user.tenantId, user.sub, user.role, e.action, e.resource, e.resourceId ?? null, JSON.stringify(details)],
  );
  const row = r.rows[0]!;
  await c.query('INSERT INTO core.outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)', [
    randomUUID(),
    auditTopic,
    String(user.tenantId),
    JSON.stringify({
      id: row.id,
      at: row.at,
      tenant_id: user.tenantId,
      actor: user.sub,
      role: user.role,
      ...e,
      details,
    }),
  ]);
}

// ---- viewer masking (ADR 0019): summaries only, no driver ids, no precise locations -------------------

export interface DepotOut {
  id: number;
  code: string;
  region: string | null;
  geohash5: string;
  lat?: number;
  lon?: number;
}

export function maskDepot(d: DepotOut & { lat: number; lon: number }, role: Role): DepotOut {
  if (role === 'viewer') return { id: d.id, code: d.code, region: d.region, geohash5: d.geohash5 };
  return d;
}

export interface DriverOut {
  id: number;
  pseudonym: string;
}

/** Viewers never see who drives a van. */
export const maskDriver = (d: DriverOut | null, role: Role): DriverOut | null => (role === 'viewer' ? null : d);
