import { decodeVinState, encodeVinState, type VinState } from '@cw/domain';
import { Redis } from 'ioredis';

/**
 * Per-VIN normaliser state in Redis: key `ar:{vin}` → 168-byte VinState (replay window + last reading).
 * One MGET per batch to read; one Lua call per batch to write back with compare-and-set, so a replica that
 * lost the partition in a rebalance cannot overwrite the new owner's newer state. No per-message round trips.
 */

const KEY = (vin: string) => `ar:{${vin}}`;

// KEYS = state keys; ARGV[1] = TTL seconds, then (expected, new) pairs. Expected "" = key must be absent.
// Returns the 1-based indexes of keys whose current value no longer matched (conflicts, left untouched).
const CAS_SCRIPT = `
local ttl = tonumber(ARGV[1])
local conflicts = {}
for i, key in ipairs(KEYS) do
  local expected = ARGV[2 * i]
  local current = redis.call('GET', key)
  if (current == false and expected == '') or current == expected then
    redis.call('SET', key, ARGV[2 * i + 1], 'EX', ttl)
  else
    conflicts[#conflicts + 1] = i
  end
end
return conflicts
`;

export interface ReadStates {
  states: Map<string, VinState | undefined>;
  /** The raw bytes as read, for the compare-and-set. */
  raw: Map<string, Buffer | null>;
}

export class StateStore {
  private readonly redis: Redis;
  private sha: string | null = null;
  /** States that could not be decoded (format change) and were treated as new. */
  undecodable = 0;

  constructor(
    url: string,
    private readonly ttlS: number,
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, enableAutoPipelining: false, lazyConnect: true });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
    this.sha = (await this.redis.script('LOAD', CAS_SCRIPT)) as string;
  }

  async read(vins: readonly string[]): Promise<ReadStates> {
    const states = new Map<string, VinState | undefined>();
    const raw = new Map<string, Buffer | null>();
    if (vins.length === 0) return { states, raw };
    const values = await this.redis.mgetBuffer(...vins.map(KEY));
    vins.forEach((vin, i) => {
      const v = values[i] ?? null;
      raw.set(vin, v);
      let state: VinState | undefined;
      try {
        state = v ? decodeVinState(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : undefined;
      } catch {
        // An older state format (e.g. after an upgrade): start this VIN fresh. The CAS still replaces the old
        // bytes. Worst case one duplicate is forwarded again, with the same event_id.
        this.undecodable++;
      }
      states.set(vin, state);
    });
    return { states, raw };
  }

  /** Write new states if nobody changed them since `read`. Returns the VINs that conflicted. */
  async write(next: ReadonlyMap<string, VinState>, read: ReadStates): Promise<string[]> {
    if (next.size === 0) return [];
    const vins = [...next.keys()];
    const args: (string | Buffer | number)[] = [this.ttlS];
    for (const vin of vins) {
      args.push(read.raw.get(vin) ?? '', Buffer.from(encodeVinState(next.get(vin)!)));
    }
    const keys = vins.map(KEY);
    let conflicts: number[];
    try {
      conflicts = (await this.redis.evalsha(this.sha!, vins.length, ...keys, ...args)) as number[];
    } catch (err) {
      if (!String(err).includes('NOSCRIPT')) throw err;
      // Redis restarted and lost its script cache: load again and retry once.
      this.sha = (await this.redis.script('LOAD', CAS_SCRIPT)) as string;
      conflicts = (await this.redis.evalsha(this.sha, vins.length, ...keys, ...args)) as number[];
    }
    return conflicts.map((i) => vins[i - 1]!);
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
