import { HOUR_MS } from '../time.js';
import { median } from './robust.js';

/**
 * Peer context (reference plan §9.4): what vans in the same context (region × duty) are doing right now,
 * as the robust centre (median) of their deviation from their OWN normal, in the metric's unit (°C, V).
 * Subtracting it cancels a shared condition exactly (a heatwave shifts every peer by the same °C),
 * whatever each van's own spread is.
 *
 * Each VIN keeps only its newest deviation per context; "right now" = within `windowH` of the query's event
 * time. The centre is cached and recomputed when the query moves to a new event-time hour or after the
 * context has seen a quarter of its size in updates: amortised O(1) per update, O(c log c) per recompute.
 * The querying VIN is not excluded: with ≥ minPeers peers its own weight on a median is negligible.
 *
 * In the service each replica estimates this from the vans it owns (a sampled estimate; ADR 0006).
 */
export interface PeerCentre {
  /** Median deviation of level (unit) and of slope (unit/h); 0 when there are too few peers. */
  level: number;
  slope: number;
  peers: number;
}

interface Entry {
  level: number;
  slope: number;
  ts: number;
}

interface Ctx {
  entries: Map<string, Entry>;
  cached: PeerCentre | null;
  cachedHour: number;
  updatesSince: number;
}

const NONE: PeerCentre = { level: 0, slope: 0, peers: 0 };

export class PeerContext {
  private readonly ctxs = new Map<string, Ctx>();

  constructor(
    private readonly windowH: number,
    private readonly minPeers: number,
  ) {}

  update(key: string, vin: string, level: number, slope: number, tsMs: number): void {
    let c = this.ctxs.get(key);
    if (!c) {
      c = { entries: new Map(), cached: null, cachedHour: -1, updatesSince: 0 };
      this.ctxs.set(key, c);
    }
    const prev = c.entries.get(vin);
    if (prev && prev.ts > tsMs) return; // keep the newest
    c.entries.set(vin, { level, slope, ts: tsMs });
    c.updatesSince++;
  }

  centre(key: string, tsMs: number): PeerCentre {
    const c = this.ctxs.get(key);
    if (!c) return NONE;
    const hour = Math.floor(tsMs / HOUR_MS);
    if (c.cached && c.cachedHour === hour && c.updatesSince * 4 < Math.max(c.entries.size, 8)) return c.cached;
    const from = tsMs - this.windowH * HOUR_MS;
    const levels: number[] = [];
    const slopes: number[] = [];
    for (const [vin, e] of c.entries) {
      if (e.ts < from - 24 * HOUR_MS) {
        c.entries.delete(vin); // long gone (parked or moved context)
      } else if (e.ts >= from && e.ts <= tsMs + this.windowH * HOUR_MS) {
        levels.push(e.level);
        slopes.push(e.slope);
      }
    }
    c.cached =
      levels.length < this.minPeers ? NONE : { level: median(levels), slope: median(slopes), peers: levels.length };
    c.cachedHour = hour;
    c.updatesSince = 0;
    return c.cached;
  }

  /** Number of VINs remembered per context (for metrics). */
  size(): number {
    let n = 0;
    for (const c of this.ctxs.values()) n += c.entries.size;
    return n;
  }
}

export interface PeerScope {
  key: string;
  /** For clues: "in the same region and duty". */
  label: string;
}

/** Peer contexts of a van, most specific first: region × duty, then the whole region (all duties). */
export const peerScopes = (regionId: number, dutyId: number, metric: string): PeerScope[] => [
  { key: `${regionId}|${dutyId}|${metric}`, label: 'in the same region and duty' },
  { key: `${regionId}|*|${metric}`, label: 'in the same region' },
];
