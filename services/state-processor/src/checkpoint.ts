import type { VanState } from '@cw/domain';
import { Redis } from 'ioredis';

/**
 * Per-partition checkpoint in Redis (ADR 0005): the in-memory state of every VIN of one input partition plus
 * the offset it is consistent with, as one JSON value `{prefix}:ckpt:{topic}:{partition}`.
 * Written every CHECKPOINT_MS and on revoke; the Kafka offset is committed only after it is written.
 */
export interface Checkpoint {
  v: 1;
  /** Next offset to read: the state includes every record before it. */
  offset: string;
  savedAt: number;
  vans: Record<string, VanState>;
}

export class CheckpointStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly prefix: string,
    private readonly ttlS: number,
  ) {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3, commandTimeout: 10_000 });
  }

  connect(): Promise<void> {
    return this.redis.connect();
  }

  key(topic: string, partition: number): string {
    return `${this.prefix}:ckpt:${topic}:${partition}`;
  }

  async load(topic: string, partition: number): Promise<Checkpoint | null> {
    const raw = await this.redis.get(this.key(topic, partition));
    if (!raw) return null;
    const c = JSON.parse(raw) as Checkpoint;
    return c.v === 1 ? c : null;
  }

  /** Stores an already-serialised checkpoint (serialise synchronously, while the partition is quiet). */
  async save(topic: string, partition: number, json: string): Promise<void> {
    await this.redis.set(this.key(topic, partition), json, 'EX', this.ttlS);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
