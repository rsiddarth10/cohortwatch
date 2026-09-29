import type { CanonicalEvent } from '../canonical/event.js';
import { uuidV5 } from '../canonical/event.js';
import { HOUR_MS, MINUTE_MS } from '../time.js';
import { dtcClue, signalClues, type Clue } from './clues.js';
import { dtcAdd, dtcCount24, dtcThreshold, type DtcRing } from './dtc.js';
import { emptyTrend, ewUpdate, trendFitNow, trendMean, trendSlope, trendWeight, type EwTrend } from './ewtrend.js';
import { kofnConfirmed, kofnPush } from './kofn.js';
import { METRICS, METRIC_FAMILY, type DetectParams, type Family, type Metric } from './params.js';
import type { PeerContext, PeerScope } from './peer.js';
import { robustZ } from './robust.js';
import { hoursToLimit, runawayRun } from './ttl.js';

/**
 * The per-van detection step (S3): one canonical reading in → the van's new state + incident events out.
 * Compares the van with its OWN normal (baseline from the batch job), minus what its peers are doing now,
 * confirms k of n, and runs the runaway rule. Pure apart from the peer context it reads and feeds.
 */

// ---- inputs ---------------------------------------------------------------------------------------

export interface MetricBaseline {
  median: number;
  mad: number;
  slopeMedian: number;
  slopeMad: number;
  /** VAN = learned from this van's history; COHORT = model × duty fallback for a van without history. */
  source: 'VAN' | 'COHORT';
}

export interface VanBaseline {
  metrics: Partial<Record<Metric, MetricBaseline>>;
  /** The van's usual codes per day, per family (missing = 0). */
  dtcPerDay: Partial<Record<Family, number>>;
}

/** The fields detection reads from a canonical event (event time in epoch ms). */
export interface DetectEvent {
  vin: string;
  seq: number;
  ts: number;
  evt: CanonicalEvent['evt'];
  ignition: boolean;
  charging: boolean;
  speedKmh: number | null;
  values: Record<Metric, number | null>;
  dtc: string[];
  families: Family[];
  flags: string[];
}

export function toDetectEvent(e: CanonicalEvent): DetectEvent {
  return {
    vin: e.vin,
    seq: e.seq,
    ts: Date.parse(e.event_ts),
    evt: e.evt,
    ignition: e.ignition,
    charging: e.charging,
    speedKmh: e.speed_kmh,
    values: { coolant_c: e.coolant_c, batt_temp_c: e.batt_temp_c, lv_batt_v: e.lv_batt_v },
    dtc: e.dtc,
    families: e.fault_families,
    flags: e.quality_flags,
  };
}

export interface StepEnv {
  params: DetectParams;
  baseline: VanBaseline | undefined;
  peers: PeerContext;
  /**
   * Peer contexts for this van and metric, most specific first (e.g. region × duty, then region). The first
   * with at least minPeers recent peers is used; the van feeds all of them. Empty = no peer adjustment.
   */
  peerKeys(metric: Metric): readonly PeerScope[];
}

// ---- state ----------------------------------------------------------------------------------------

export interface MetricState {
  slow: EwTrend;
  fast: EwTrend;
  /** Last accepted reading (jump guard). */
  lastTs: number;
  lastY: number;
  /** Current run of rejected readings: first time, newest value, count. */
  rejTs: number;
  rejY: number;
  rejN: number;
  /** k-of-n ring, consecutive normal readings, consecutive under-the-line readings. */
  win: number;
  normalRun: number;
  ttlRun: number;
  /** k-of-n ring of the simple global-threshold rule (evaluation baseline only). */
  gwin: number;
}

export type Trigger = 'SIGNAL' | 'DTC_RATE';
export type Severity = 'WARN' | 'HIGH' | 'CRITICAL';

export interface OpenIncident {
  id: string;
  bucket: number;
  openedTs: number;
  trigger: Trigger;
  severity: Severity;
  critical: boolean;
}

export interface VanState {
  /** Highest seq applied; readings at or below it are skipped (replay after a crash never double-counts). */
  lastSeq: number;
  /** Event time of the last IGNITION_ON; −1 = unknown or off. */
  ignOnTs: number;
  m: Partial<Record<Metric, MetricState>>;
  dtc: Partial<Record<Family, DtcRing>>;
  open: Partial<Record<Family, OpenIncident>>;
  /** Metrics whose global-threshold rule already fired once. */
  gHit: Partial<Record<Metric, true>>;
}

export const emptyVan = (): VanState => ({ lastSeq: -1, ignOnTs: -1, m: {}, dtc: {}, open: {}, gHit: {} });

const emptyMetric = (): MetricState => ({
  slow: emptyTrend(),
  fast: emptyTrend(),
  lastTs: 0,
  lastY: 0,
  rejTs: 0,
  rejY: 0,
  rejN: 0,
  win: 0,
  normalRun: 0,
  ttlRun: 0,
  gwin: 0,
});

// ---- outputs --------------------------------------------------------------------------------------

export interface IncidentEvent {
  action: 'OPEN' | 'ESCALATE' | 'CLOSE';
  incidentId: string;
  vin: string;
  family: Family;
  windowBucket: number;
  /** Event time of the reading that caused this action (ms), and its seq. */
  ts: number;
  seq: number;
  trigger: Trigger;
  metric: Metric | null;
  severity: Severity;
  runaway: boolean;
  hoursToLimit: number | null;
  level: number | null;
  baselineMedian: number | null;
  deviation: number | null;
  peerAdj: number | null;
  zLevel: number | null;
  zSlope: number | null;
  slopePerH: number | null;
  dtcCount24: number;
  dtcUsualPerDay: number;
  clues: Clue[];
}

export interface GlobalHit {
  vin: string;
  metric: Metric;
  family: Family;
  ts: number;
}

export interface StepResult {
  state: VanState;
  incidents: IncidentEvent[];
  globalHits: GlobalHit[];
  /** True when the reading was at or below the last applied seq and was skipped. */
  skipped: boolean;
}

/** Fixed namespace for incident ids (random v4, generated once). */
export const INCIDENT_ID_NAMESPACE = 'a3c9e0f2-5d41-4b7e-8f26-91c4d7e8b053';

export const windowBucketOf = (tsMs: number, bucketH: number): number => Math.floor(tsMs / (bucketH * HOUR_MS));

export const incidentIdOf = (vin: string, family: Family, bucket: number): string =>
  uuidV5(INCIDENT_ID_NAMESPACE, `${vin}|${family}|${bucket}`);

/** Family key (brief §1.3.3): fault family | model | duty | depot. */
export const familyKeyOf = (family: Family, modelId: number, dutyId: number, depotId: number): string =>
  `${family}|${modelId}|${dutyId}|${depotId}`;

// ---- which readings count --------------------------------------------------------------------------

/** The value a reading contributes for a metric, or null (flagged, parked, warming up, heartbeat, ...). */
export function qualifyingValue(ev: DetectEvent, metric: Metric, ignOnTs: number, p: DetectParams): number | null {
  const y = ev.values[metric];
  if (y === null || ev.evt !== 'PERIODIC' || !ev.ignition) return null;
  for (const f of ev.flags) {
    if (f === 'CLOCK_SKEW' || f === 'LATE' || f === `OUT_OF_RANGE:${metric}`) return null;
  }
  if (metric === 'lv_batt_v') return y; // running voltage: any ignition-on periodic reading
  // temperatures: driving only, engine warmed up
  if (ev.charging || (ev.speedKmh ?? 0) <= 0) return null;
  if (ignOnTs >= 0 && ev.ts - ignOnTs < p.warmupMin * MINUTE_MS) return null;
  return y;
}

type Guard = 'ACCEPT' | 'REJECT' | 'RESET';

/**
 * Impossible-jump guard. A reading is rejected when it moves faster than the metric's physical maximum
 * rate from the last accepted reading, or lies more than `spikeMax` from the fast trend's mean (catches the
 * 25 → 140 → 25 °C glitch). A run of rejected readings that agree with each other and span `rejectResetH`
 * is a real level change: the trend restarts from it.
 */
function guard(ms: MetricState, ts: number, y: number, metric: Metric, p: DetectParams): Guard {
  if (ms.slow.S === 0) return 'ACCEPT';
  const mp = p.metrics[metric];
  const minutes = Math.max((ts - ms.lastTs) / MINUTE_MS, 1 / 60);
  const tooFast = Math.abs(y - ms.lastY) / minutes > mp.maxRatePerMin;
  const spike = Math.abs(y - trendMean(ms.fast)) > mp.spikeMax;
  if (!tooFast && !spike) {
    ms.rejN = 0;
    return 'ACCEPT';
  }
  if (ms.rejN > 0 && Math.abs(y - ms.rejY) <= mp.spikeMax) {
    ms.rejN++;
    ms.rejY = y;
  } else {
    ms.rejN = 1;
    ms.rejTs = ts;
    ms.rejY = y;
  }
  if (ms.rejN >= 2 && ts - ms.rejTs >= p.rejectResetH * HOUR_MS) {
    ms.rejN = 0;
    return 'RESET';
  }
  return 'REJECT';
}

// ---- the step -------------------------------------------------------------------------------------

function severityOf(zLevel: number, dtcActive: boolean, critical: boolean, p: DetectParams): Severity {
  if (critical) return 'CRITICAL';
  return zLevel >= 2 * p.zLevel || dtcActive ? 'HIGH' : 'WARN';
}

export function stepVan(prev: VanState, ev: DetectEvent, env: StepEnv): StepResult {
  const p = env.params;
  const reset = ev.flags.includes('SEQ_RESET');
  if (ev.seq <= prev.lastSeq && !reset) return { state: prev, incidents: [], globalHits: [], skipped: true };

  const st: VanState = {
    lastSeq: ev.seq,
    ignOnTs: prev.ignOnTs,
    m: { ...prev.m },
    dtc: { ...prev.dtc },
    open: { ...prev.open },
    gHit: prev.gHit,
  };
  const incidents: IncidentEvent[] = [];
  const globalHits: GlobalHit[] = [];
  if (ev.evt === 'IGNITION_ON') st.ignOnTs = ev.ts;
  else if (ev.evt === 'IGNITION_OFF') st.ignOnTs = -1;

  ev.dtc.forEach((code, i) => {
    const fam = ev.families[i] ?? 'OTHER';
    st.dtc[fam] = dtcAdd(st.dtc[fam], ev.ts, code);
  });
  const usual = (fam: Family) => env.baseline?.dtcPerDay[fam] ?? 0;
  const dtcState = (fam: Family) => {
    const count = dtcCount24(st.dtc[fam], ev.ts);
    return { count, active: count >= dtcThreshold(usual(fam), p.dtcFactor, p.dtcMinCount) };
  };
  const dtcClues = (fam: Family, count: number): Clue[] =>
    count > 0 ? [dtcClue({ code: st.dtc[fam]!.lastCode, family: fam, count24: count, usualPerDay: usual(fam) })] : [];

  // ---- signals ----
  const signalFamilies = new Set<Family>();
  for (const metric of METRICS) {
    const y = qualifyingValue(ev, metric, st.ignOnTs, p);
    if (y === null) continue;
    const mp = p.metrics[metric];
    const ms: MetricState = { ...(st.m[metric] ?? emptyMetric()) };
    st.m[metric] = ms;

    // simple global-threshold rule, same k-of-n, no own normal, no guard (the evaluation's comparison)
    if (mp.globalThreshold !== null) {
      ms.gwin = kofnPush(ms.gwin, mp.direction * (y - mp.globalThreshold) > 0, p.n);
      if (!st.gHit[metric] && kofnConfirmed(ms.gwin, p.k)) {
        st.gHit = { ...st.gHit, [metric]: true };
        globalHits.push({ vin: ev.vin, metric, family: METRIC_FAMILY[metric], ts: ev.ts });
      }
    }

    const g = guard(ms, ev.ts, y, metric, p);
    if (g === 'REJECT') continue;
    if (g === 'RESET') {
      ms.slow = emptyTrend();
      ms.fast = emptyTrend();
    }
    ms.slow = ewUpdate(ms.slow, ev.ts, y, p.tauH);
    ms.fast = ewUpdate(ms.fast, ev.ts, y, p.fastTauH);
    ms.lastTs = ev.ts;
    ms.lastY = y;

    const base = env.baseline?.metrics[metric];
    if (!base || trendWeight(ms.slow) < p.minWeight) continue;

    // own normal, minus peers (in the metric's unit), then robust z
    const level = trendMean(ms.slow);
    const dev = level - base.median;
    const slope = trendSlope(ms.slow);
    const devSlope = slope === null ? 0 : slope - base.slopeMedian;
    const scopes = env.peerKeys(metric);
    let ctx = { level: 0, slope: 0, fastSlope: 0, peers: 0 };
    let scope = '';
    for (const s of scopes) {
      const c = env.peers.centre(s.key, ev.ts);
      if (c.peers > 0) {
        ctx = c;
        scope = s.label;
        break;
      }
    }
    const fastSlope = trendSlope(ms.fast);
    for (const s of scopes) env.peers.update(s.key, ev.vin, dev, devSlope, ev.ts, fastSlope ?? 0);
    const zL = mp.direction * robustZ(dev - ctx.level, base.mad, mp.minMad);
    const zS = slope === null ? 0 : mp.direction * robustZ(devSlope - ctx.slope, base.slopeMad, mp.minSlopeMad);
    const abnormal = zL >= p.zLevel || (zS >= p.zSlope && zL >= p.zLevelWithSlope);
    ms.win = kofnPush(ms.win, abnormal, p.n);
    ms.normalRun = abnormal ? 0 : ms.normalRun + 1;

    // time to limit from the fast trend; runaway after several readings in a row under the line
    let ttl: number | null = null;
    if (mp.hardLimit !== null) {
      // the van's own rate minus what its peers are doing right now (shared heating is not a runaway)
      const rate = fastSlope === null ? null : fastSlope - ctx.fastSlope;
      ttl = hoursToLimit(trendFitNow(ms.fast), rate, mp.hardLimit, mp.runawayMinRatePerH, mp.direction);
      // only a van that is abnormal after peer adjustment, and confirmed k of n, can become a runaway
      ms.ttlRun = abnormal && kofnConfirmed(ms.win, p.k) ? runawayRun(ms.ttlRun, ttl, p.runawayHours) : 0;
    }
    const runawayNow = ms.ttlRun >= p.runawayConsecutive;

    const fam = METRIC_FAMILY[metric];
    signalFamilies.add(fam);
    const open = st.open[fam];
    const dtc = dtcState(fam);
    const build = (action: IncidentEvent['action'], inc: OpenIncident): IncidentEvent => ({
      action,
      incidentId: inc.id,
      vin: ev.vin,
      family: fam,
      windowBucket: inc.bucket,
      ts: ev.ts,
      seq: ev.seq,
      trigger: inc.trigger,
      metric,
      severity: inc.severity,
      runaway: inc.critical,
      hoursToLimit: ttl,
      level,
      baselineMedian: base.median,
      deviation: dev,
      peerAdj: ctx.level,
      zLevel: zL,
      zSlope: zS,
      slopePerH: slope,
      dtcCount24: dtc.count,
      dtcUsualPerDay: usual(fam),
      clues: [
        ...signalClues({
          p: mp,
          deviation: dev,
          baselineMedian: base.median,
          slopePerH: slope,
          baselineSlopePerH: base.slopeMedian,
          baselineSlopeMad: base.slopeMad,
          zSlope: zS,
          peerLevel: ctx.level,
          peers: ctx.peers,
          peerScope: scope,
          hoursToLimit: ttl,
          runaway: inc.critical,
        }),
        ...dtcClues(fam, dtc.count),
      ],
    });

    if (!open && kofnConfirmed(ms.win, p.k)) {
      const bucket = windowBucketOf(ev.ts, p.windowBucketH);
      const inc: OpenIncident = {
        id: incidentIdOf(ev.vin, fam, bucket),
        bucket,
        openedTs: ev.ts,
        trigger: 'SIGNAL',
        severity: severityOf(zL, dtc.active, runawayNow, p),
        critical: runawayNow,
      };
      st.open[fam] = inc;
      incidents.push(build('OPEN', inc));
    } else if (open && open.trigger === 'DTC_RATE' && kofnConfirmed(ms.win, p.k)) {
      // a code-rate incident whose signal now confirms too: same incident, now signal-backed
      const inc: OpenIncident = {
        ...open,
        trigger: 'SIGNAL',
        severity: severityOf(zL, true, runawayNow, p),
        critical: runawayNow,
      };
      st.open[fam] = inc;
      incidents.push(build('ESCALATE', inc));
    } else if (open && runawayNow && !open.critical) {
      const inc: OpenIncident = { ...open, critical: true, severity: 'CRITICAL' };
      st.open[fam] = inc;
      incidents.push(build('ESCALATE', inc));
    } else if (open && ms.normalRun >= p.closeAfterNormal && !dtc.active) {
      delete st.open[fam];
      ms.ttlRun = 0;
      incidents.push(build('CLOSE', open));
    }
  }

  // ---- fault-code rate (any family) ----
  const families = new Set<Family>(ev.families);
  for (const f of Object.keys(st.open) as Family[]) if (st.open[f]!.trigger === 'DTC_RATE') families.add(f);
  for (const fam of families) {
    if (signalFamilies.has(fam) && st.open[fam]?.trigger === 'SIGNAL') continue;
    const dtc = dtcState(fam);
    const open = st.open[fam];
    const base = {
      vin: ev.vin,
      family: fam,
      ts: ev.ts,
      seq: ev.seq,
      metric: null,
      runaway: false,
      hoursToLimit: null,
      level: null,
      baselineMedian: null,
      deviation: null,
      peerAdj: null,
      zLevel: null,
      zSlope: null,
      slopePerH: null,
      dtcCount24: dtc.count,
      dtcUsualPerDay: usual(fam),
      clues: dtcClues(fam, dtc.count),
    } as const;
    if (!open && dtc.active) {
      const bucket = windowBucketOf(ev.ts, p.windowBucketH);
      const inc: OpenIncident = {
        id: incidentIdOf(ev.vin, fam, bucket),
        bucket,
        openedTs: ev.ts,
        trigger: 'DTC_RATE',
        severity: 'WARN',
        critical: false,
      };
      st.open[fam] = inc;
      incidents.push({
        ...base,
        action: 'OPEN',
        incidentId: inc.id,
        windowBucket: bucket,
        trigger: 'DTC_RATE',
        severity: 'WARN',
      });
    } else if (open && open.trigger === 'DTC_RATE' && !dtc.active) {
      delete st.open[fam];
      incidents.push({
        ...base,
        action: 'CLOSE',
        incidentId: open.id,
        windowBucket: open.bucket,
        trigger: 'DTC_RATE',
        severity: open.severity,
      });
    }
  }

  return { state: st, incidents, globalHits, skipped: false };
}
