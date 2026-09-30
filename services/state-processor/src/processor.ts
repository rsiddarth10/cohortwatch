import {
  emptyVan,
  familyKeyOf,
  peerScopes,
  resetForRepair,
  stepVan,
  toDetectEvent,
  type CanonicalEvent,
  type DetectParams,
  type GlobalHit,
  type IncidentEvent,
  type IncidentMessage,
  type Metric,
  type PeerContext,
  type VanScore,
  type VanState,
} from '@cw/domain';
import { placementAt, type RegistryCache } from './registry.js';

/**
 * One partition's in-memory detection state and the batch step (no Kafka, Redis or Postgres here, so it is
 * unit-testable). The Kafka loop feeds decoded events in offset order; `offset` is the next offset to read.
 */
export class PartitionState {
  vans = new Map<string, VanState>();
  offset: string | null = null;
  /** Changed since the last checkpoint. */
  dirty = false;
  /** Serialises batches and checkpoints of this partition (a checkpoint never sees half a batch). */
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  snapshot(): string {
    return JSON.stringify({ v: 1, offset: this.offset, savedAt: Date.now(), vans: Object.fromEntries(this.vans) });
  }
}

export interface InEvent {
  event: CanonicalEvent;
  /** Producer wall-clock send time (x-sent-at), for latency. */
  sentAt: number | null;
}

export interface IncidentOut {
  message: IncidentMessage;
  sentAt: number | null;
}

export interface BatchOutput {
  incidents: IncidentOut[];
  globalHits: GlobalHit[];
  applied: number;
  skipped: number;
  unknownVin: number;
  /** Per input event (same index): the van's peer-adjusted scores at that reading, for the telemetry writer. */
  scores: (VanScore[] | undefined)[];
}

export interface ProcessorEnv {
  params: DetectParams;
  registry: RegistryCache;
  peers: PeerContext;
  /** vin → event time of its latest repair (S6): the van's trend restarts there (ADR 0016). */
  repairs?: ReadonlyMap<string, number>;
}

function toMessage(
  i: IncidentEvent,
  ev: CanonicalEvent,
  familyKey: string,
  place: { depotId: number; regionId: number },
  modelId: number,
  dutyId: number,
  baselineSource: 'VAN' | 'COHORT' | null,
): IncidentMessage {
  return {
    incident_id: i.incidentId,
    action: i.action,
    vin: i.vin,
    fault_family: i.family,
    family_key: familyKey,
    window_bucket: i.windowBucket,
    event_ts: new Date(i.ts).toISOString(),
    seq: i.seq,
    trigger: i.trigger,
    metric: i.metric,
    severity: i.severity,
    runaway: i.runaway,
    hours_to_limit: i.hoursToLimit,
    depot_id: place.depotId,
    model_id: modelId,
    duty_type_id: dutyId,
    region_id: place.regionId,
    firmware: ev.firmware || null,
    baseline_source: baselineSource,
    last_code: i.lastCode,
    numbers: {
      level: i.level,
      baseline_median: i.baselineMedian,
      deviation: i.deviation,
      peer_adj: i.peerAdj,
      z_level: i.zLevel,
      z_slope: i.zSlope,
      slope_per_h: i.slopePerH,
      dtc_count_24h: i.dtcCount24,
      dtc_usual_per_day: i.dtcUsualPerDay,
    },
    clues: i.clues,
  };
}

/** Apply a batch of one partition's events (in offset order) to its state. */
export function processBatch(part: PartitionState, events: readonly InEvent[], env: ProcessorEnv): BatchOutput {
  const out: BatchOutput = { incidents: [], globalHits: [], applied: 0, skipped: 0, unknownVin: 0, scores: [] };
  for (let idx = 0; idx < events.length; idx++) {
    const { event, sentAt } = events[idx]!;
    const van = env.registry.get(event.vin);
    if (!van) {
      out.unknownVin++; // registry lags (refreshed periodically); the reading is not scored
      continue;
    }
    const ev = toDetectEvent(event);
    const place = placementAt(van, ev.ts);
    let before = part.vans.get(ev.vin) ?? emptyVan();
    const repairTs = env.repairs?.get(ev.vin);
    if (repairTs !== undefined) {
      const reset = resetForRepair(before, repairTs);
      if (reset !== before) part.vans.set(ev.vin, (before = reset));
    }
    const r = stepVan(before, ev, {
      params: env.params,
      baseline: van.baseline,
      peers: env.peers,
      peerKeys: (m: Metric) => (place ? peerScopes(place.regionId, van.dutyId, m) : []),
    });
    if (r.skipped) {
      out.skipped++;
      continue;
    }
    out.applied++;
    part.vans.set(ev.vin, r.state);
    out.globalHits.push(...r.globalHits);
    if (r.scores.length > 0) out.scores[idx] = r.scores;
    if (!place) continue;
    for (const i of r.incidents) {
      const src = i.metric ? (van.baseline?.metrics[i.metric]?.source ?? null) : null;
      const fk = familyKeyOf(i.family, van.modelId, van.dutyId, place.depotId);
      out.incidents.push({ message: toMessage(i, event, fk, place, van.modelId, van.dutyId, src), sentAt });
    }
  }
  if (events.length > 0) part.dirty = true;
  return out;
}
