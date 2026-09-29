import type { CanonicalEvent } from '@cw/domain';
import avro from 'avsc';

/**
 * Canonical event decoder (Confluent wire format: magic 0, 4-byte schema id, Avro body). The writer schema is
 * fetched from the registry by id once and cached, so decoding stays synchronous on the hot path and a
 * BACKWARD-compatible schema change on the producer side needs no redeploy here.
 */
export class CanonicalDecoder {
  private readonly types = new Map<number, avro.Type>();

  constructor(private readonly registryUrl: string) {}

  /** Schema ids used in these buffers that are not cached yet. */
  unknownIds(bufs: readonly (Buffer | null)[]): number[] {
    const ids = new Set<number>();
    for (const b of bufs)
      if (b && b.length >= 5 && b[0] === 0 && !this.types.has(b.readInt32BE(1))) ids.add(b.readInt32BE(1));
    return [...ids];
  }

  async load(ids: readonly number[]): Promise<void> {
    for (const id of ids) {
      const res = await fetch(`${this.registryUrl}/schemas/ids/${id}`);
      if (!res.ok) throw new Error(`schema ${id}: HTTP ${res.status}`);
      const body = (await res.json()) as { schema: string };
      this.types.set(id, avro.Type.forSchema(JSON.parse(body.schema) as avro.Schema));
    }
  }

  /** Synchronous decode; throws on a malformed record or an unknown schema id (call load() first). */
  decode(buf: Buffer): CanonicalEvent {
    if (buf.length < 5 || buf[0] !== 0) throw new Error('not Confluent wire format');
    const type = this.types.get(buf.readInt32BE(1));
    if (!type) throw new Error(`schema id ${buf.readInt32BE(1)} not loaded`);
    return type.fromBuffer(buf.subarray(5)) as CanonicalEvent;
  }
}
