import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type pg from 'pg';

/**
 * Transactional-outbox relay + advisory-lock leader, the same pattern as the S5 campaign engine (ADR 0012), copied
 * here rather than restructuring S5. It publishes only this service's topics (queue.events.v1, workshop.outcomes.v1)
 * and uses its own lock id, so the two relays never publish each other's rows.
 */
export const WORKSHOP_LEADER_LOCK = 0x5c6;

export class Leader {
  private client: pg.PoolClient | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly lockId = WORKSHOP_LEADER_LOCK,
  ) {}

  async isLeader(): Promise<boolean> {
    if (this.client) return true;
    const c = await this.pool.connect();
    const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [this.lockId]);
    if (r.rows[0]!.ok) {
      this.client = c;
      c.on('error', () => {
        this.client = null;
      });
      return true;
    }
    c.release();
    return false;
  }

  release(): void {
    if (!this.client) return;
    this.client.query('SELECT pg_advisory_unlock($1)', [this.lockId]).catch(() => undefined);
    this.client.release();
    this.client = null;
  }
}

export class OutboxRelay {
  constructor(
    private readonly pool: pg.Pool,
    private readonly producer: KafkaJS.Producer,
    private readonly batch: number,
    private readonly topics: readonly string[],
  ) {}

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
