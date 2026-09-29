import type { MetricParams } from './params.js';

/**
 * Incident clues (reference plan §9.5): short phrases built from numbers with units, never a bare score.
 * Each clue keeps its source value so the UI and the agent can cite it.
 */
export type ClueType = 'LEVEL' | 'SLOPE' | 'DTC_RATE' | 'PEERS' | 'TIME_TO_LIMIT' | 'RUNAWAY';

export interface Clue {
  type: ClueType;
  text: string;
  value: number;
  unit: string;
}

export interface SignalClueInput {
  p: MetricParams;
  /** Smoothed level minus the van's own median (unit). */
  deviation: number;
  baselineMedian: number;
  /** Slow-trend slope and the van's usual slope (unit/h); slope null when not yet fitted. */
  slopePerH: number | null;
  baselineSlopePerH: number;
  baselineSlopeMad: number;
  /** Robust z of the peer-adjusted slope (bad direction positive). */
  zSlope: number;
  /** Peer centre (unit) and how many peers it came from (0 = no adjustment). */
  peerLevel: number;
  peers: number;
  hoursToLimit: number | null;
  runaway: boolean;
}

export interface DtcClueInput {
  code: string;
  family: string;
  count24: number;
  usualPerDay: number;
}

const f1 = (x: number) => (Math.abs(x) < 0.05 ? '0.0' : x.toFixed(1));
const f2 = (x: number) => x.toFixed(2);
const signed = (x: number) => (x >= 0 ? `+${f1(x)}` : f1(x));

export function signalClues(i: SignalClueInput): Clue[] {
  const { p } = i;
  const clues: Clue[] = [];
  const dir = i.deviation >= 0 ? 'above' : 'below';
  clues.push({
    type: 'LEVEL',
    text: `${p.label} ${f1(Math.abs(i.deviation))} ${p.unit} ${dir} its own normal (${f1(i.baselineMedian)} ${p.unit})`,
    value: i.deviation,
    unit: p.unit,
  });
  if (i.slopePerH !== null && i.zSlope >= 1.5) {
    const usual = Math.max(Math.abs(i.baselineSlopePerH), 1.4826 * i.baselineSlopeMad, p.minSlopeMad);
    const verb = i.slopePerH >= 0 ? 'rising' : 'falling';
    const ratio = Math.abs(i.slopePerH) / usual;
    clues.push({
      type: 'SLOPE',
      text: `${verb} ${f2(Math.abs(i.slopePerH))} ${p.unit}/h, ${f1(ratio)}× its usual rate`,
      value: i.slopePerH,
      unit: `${p.unit}/h`,
    });
  }
  if (i.peers > 0) {
    const text =
      Math.abs(i.peerLevel) < 1.5 * p.minMad
        ? `peers in the same region and duty are normal right now (${signed(i.peerLevel)} ${p.unit}, ${i.peers} vans)`
        : `peers in the same region and duty are ${signed(i.peerLevel)} ${p.unit} vs their own normal right now; this van is compared after removing that (${i.peers} vans)`;
    clues.push({ type: 'PEERS', text, value: i.peerLevel, unit: p.unit });
  }
  if (i.hoursToLimit !== null && p.hardLimit !== null) {
    clues.push({
      type: 'TIME_TO_LIMIT',
      text: `about ${f1(i.hoursToLimit)} h to the ${p.hardLimit} ${p.unit} limit at the current rate`,
      value: i.hoursToLimit,
      unit: 'h',
    });
  }
  if (i.runaway) {
    clues.push({
      type: 'RUNAWAY',
      text: `runaway: under the time-to-limit line for several readings in a row`,
      value: i.hoursToLimit ?? 0,
      unit: 'h',
    });
  }
  return clues;
}

export function dtcClue(i: DtcClueInput): Clue {
  return {
    type: 'DTC_RATE',
    text: `${i.family} codes seen ${i.count24}× in 24 h, latest ${i.code} (usual: ${f1(i.usualPerDay)} per day)`,
    value: i.count24,
    unit: 'codes/24h',
  };
}
