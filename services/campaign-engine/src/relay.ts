import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { featureVector, pastCampaigns } from '@cw/domain';
import type pg from 'pg';

/**
 * Transactional-outbox relay (ADR 0012). Rows are written in the same transaction as the campaign change; the
 * relay publishes unpublished rows in order to campaign.events.v1 (key = campaign_id, header x-event-id), waits
 * for the acks, then marks them published. A crash between the ack and the mark re-sends the same event id,
 * which consumers drop: at-least-once delivery, exactly one row per change.
 *
 * Only the leader runs it (and the at-risk timer): the replica holding a session-level Postgres advisory lock.
 */
export const LEADER_LOCK = 0x5c5; // arbitrary constant, one per application

export class Leader {
  private client: pg.PoolClient | null = null;

  constructor(private readonly pool: pg.Pool) {}

  /** True while this replica holds the lock (tries to take it when it does not). */
  async isLeader(): Promise<boolean> {
    if (this.client) return true;
    const c = await this.pool.connect();
    const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK]);
    if (r.rows[0]!.ok) {
      this.client = c;
      c.on('error', () => {
        this.client = null; // connection lost: the lock is gone with it
      });
      return true;
    }
    c.release();
    return false;
  }

  release(): void {
    if (!this.client) return;
    this.client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK]).catch(() => undefined);
    this.client.release();
    this.client = null;
  }
}

export class OutboxRelay {
  constructor(
    private readonly pool: pg.Pool,
    private readonly producer: KafkaJS.Producer,
    private readonly batch: number,
    /** Only these topics: other services (S4/S6 workshop) run their own relay on the same table. */
    private readonly topics: readonly string[],
  ) {}

  /** Publish one batch; returns how many rows were published and their created→published delays (ms). */
  async publishOnce(): Promise<{ published: number; delaysMs: number[] }> {
    const rows = (
      await this.pool.query<{ id: string; topic: string; key: string; payload: unknown; created_at: Date }>(
        `SELECT id, topic, key, payload, created_at FROM core.outbox WHERE published_at IS NULL AND topic = ANY($2)
         ORDER BY created_at, id LIMIT $1`,
        [this.batch, this.topics],
      )
    ).rows;
    if (rows.length === 0) return { published: 0, delaysMs: [] };
    const byTopic = new Map<string, KafkaJS.Message[]>();
    for (const r of rows) {
      const list = byTopic.get(r.topic) ?? byTopic.set(r.topic, []).get(r.topic)!;
      list.push({ key: r.key, value: JSON.stringify(r.payload), headers: { 'x-event-id': r.id } });
    }
    await this.producer.sendBatch({ topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })) });
    await this.pool.query('UPDATE core.outbox SET published_at = now() WHERE id = ANY($1) AND published_at IS NULL', [
      rows.map((r) => r.id),
    ]);
    const now = Date.now();
    return { published: rows.length, delaysMs: rows.map((r) => now - r.created_at.getTime()) };
  }

  async backlog(): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM core.outbox WHERE published_at IS NULL AND topic = ANY($1)',
      [this.topics],
    );
    return r.rows[0]!.n;
  }
}

/** Seed the synthetic past campaigns (idempotent). */
export async function seedPastCampaigns(pool: pg.Pool): Promise<number> {
  let n = 0;
  for (const p of pastCampaigns()) {
    const r = await pool.query(
      `INSERT INTO core.past_campaign (id, code, year, fault_family, powertrain, duty, climate, members, deviation,
         slope_per_h, codes, root_cause, resolution, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::vector) ON CONFLICT (id) DO NOTHING`,
      [
        p.id, p.code, p.year, p.family, p.powertrain, p.duty, p.climate, p.members, p.deviation, p.slopePerH, p.codes,
        p.rootCause, p.resolution, `[${featureVector(p).join(',')}]`,
      ],
    ); // prettier-ignore
    n += r.rowCount ?? 0;
  }
  return n;
}
