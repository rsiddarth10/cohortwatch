import { FAULT_CODES } from '../catalog.js';
import { uuidV5 } from '../canonical/event.js';
import { hashSeed, Rng } from '../rng.js';

/**
 * "Similar past campaigns" (brief §1.3.3): a numeric feature vector per campaign, compared by cosine similarity
 * (pgvector `<=>` in Postgres; `cosine` here for tests). No external embedding API.
 * The 30 past campaigns are SYNTHETIC and fictional (declared in docs/DECLARATIONS.md), generated
 * deterministically, each with a root cause and a resolution note.
 */

export const SIM_FAMILIES = [
  'COOLING',
  'HV_BATTERY_THERMAL',
  'LV_ELECTRICAL',
  'EXHAUST',
  'BRAKE_SENSOR',
  'OTHER',
] as const;
export const SIM_POWERTRAINS = ['EV', 'DIESEL', 'HYBRID'] as const;
export const SIM_DUTIES = ['URBAN', 'LINEHAUL', 'RENTAL', 'FIELD', 'YARD'] as const;
export const SIM_CLIMATES = ['HOT_DRY', 'HOT_HUMID', 'TEMPERATE', 'COLD'] as const;
export const SIM_CODES: readonly string[] = Object.values(FAULT_CODES).flat();
/** 6 + 3 + 5 + 4 + 3 + 10 = 31 dimensions. */
export const FEATURE_DIM =
  SIM_FAMILIES.length + SIM_POWERTRAINS.length + SIM_DUTIES.length + SIM_CLIMATES.length + 3 + SIM_CODES.length;

export interface CampaignFeatures {
  family: string;
  powertrain: string;
  duty: string;
  climate: string;
  members: number;
  /** Typical member deviation from its own normal (°C or V) and trend (unit/h). */
  deviation: number;
  slopePerH: number;
  /** Fault codes seen among members (with repeats: one per member that reported it). */
  codes: readonly string[];
}

/** Block weights: the fault family matters most, then powertrain and codes, then place and size. */
const W = { family: 2, powertrain: 1.2, duty: 0.8, climate: 0.6, size: 0.5, dev: 0.7, slope: 0.7, codes: 1 };

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const oneHot = (values: readonly string[], v: string, w: number) => values.map((x) => (x === v ? w : 0));

export function featureVector(f: CampaignFeatures): number[] {
  const codeCounts = SIM_CODES.map((c) => f.codes.filter((x) => x === c).length);
  const codeTotal = Math.max(
    1,
    codeCounts.reduce((a, b) => a + b, 0),
  );
  return [
    ...oneHot(SIM_FAMILIES, f.family, W.family),
    ...oneHot(SIM_POWERTRAINS, f.powertrain, W.powertrain),
    ...oneHot(SIM_DUTIES, f.duty, W.duty),
    ...oneHot(SIM_CLIMATES, f.climate, W.climate),
    W.size * clamp(Math.log2(1 + f.members) / Math.log2(51), 0, 1),
    W.dev * clamp(f.deviation / 15, -1, 1),
    W.slope * clamp(f.slopePerH, -1, 1),
    ...codeCounts.map((c) => (W.codes * c) / codeTotal),
  ];
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface PastCampaign extends CampaignFeatures {
  id: string;
  code: string;
  year: number;
  rootCause: string;
  resolution: string;
}

interface Template {
  family: string;
  powertrains: readonly string[];
  codes: readonly string[];
  deviation: [number, number];
  slope: [number, number];
  rootCause: string;
  resolution: string;
}

const TEMPLATES: readonly Template[] = [
  { family: 'COOLING', powertrains: ['DIESEL', 'HYBRID'], codes: ['P0217', 'P0118'], deviation: [7, 12], slope: [0.15, 0.4], rootCause: 'thermostat batch sticking half-closed', resolution: 'thermostat batch replaced under a supplier recall; drift gone within a day' },
  { family: 'COOLING', powertrains: ['DIESEL'], codes: ['P0480', 'P0217'], deviation: [5, 10], slope: [0.1, 0.3], rootCause: 'radiator fan relay failing hot', resolution: 'fan relay recall; relays swapped at the depot in one shift' },
  { family: 'COOLING', powertrains: ['DIESEL', 'HYBRID'], codes: ['P0217'], deviation: [4, 8], slope: [0.05, 0.2], rootCause: 'coolant pump seal wear (one production week)', resolution: 'pump seal kit fitted; coolant flushed' },
  { family: 'COOLING', powertrains: ['DIESEL'], codes: ['P0480', 'P0118'], deviation: [6, 11], slope: [0.2, 0.5], rootCause: 'fan-control firmware bug after an update', resolution: 'firmware rolled back to the previous version, then patched' },
  { family: 'HV_BATTERY_THERMAL', powertrains: ['EV', 'HYBRID'], codes: ['P0A7E', 'P0A80'], deviation: [4, 9], slope: [0.1, 0.4], rootCause: 'battery coolant pump derated by firmware', resolution: 'OTA patch restored pump duty cycle' },
  { family: 'HV_BATTERY_THERMAL', powertrains: ['EV'], codes: ['P0A7E'], deviation: [5, 10], slope: [0.05, 0.25], rootCause: 'chiller refrigerant leak at a crimped hose', resolution: 'chiller re-gassed and hose seals replaced' },
  { family: 'HV_BATTERY_THERMAL', powertrains: ['EV', 'HYBRID'], codes: ['P0A80'], deviation: [3, 6], slope: [0.02, 0.1], rootCause: 'HV thermal sensor drift', resolution: 'sensor harness replaced; readings back in band' },
  { family: 'LV_ELECTRICAL', powertrains: ['DIESEL', 'HYBRID'], codes: ['P0562'], deviation: [-1.2, -0.5], slope: [-0.05, -0.01], rootCause: 'alternator regulator batch undercharging', resolution: 'regulators replaced; 12 V batteries tested' },
  { family: 'LV_ELECTRICAL', powertrains: ['EV'], codes: ['P0562', 'P0620'], deviation: [-1.0, -0.4], slope: [-0.04, -0.01], rootCause: 'DC-DC converter fault', resolution: 'DC-DC converters replaced under warranty' },
  { family: 'LV_ELECTRICAL', powertrains: ['EV', 'DIESEL', 'HYBRID'], codes: ['P0620'], deviation: [-0.8, -0.3], slope: [-0.03, 0], rootCause: 'parasitic drain from a telematics unit', resolution: 'telematics firmware update; sleep mode fixed' },
  { family: 'EXHAUST', powertrains: ['DIESEL'], codes: ['P0401'], deviation: [0, 1], slope: [0, 0.05], rootCause: 'EGR valve sticking on short urban trips', resolution: 'EGR valves cleaned or replaced; route mix changed' },
  { family: 'EXHAUST', powertrains: ['DIESEL'], codes: ['P2463'], deviation: [0, 1], slope: [0, 0.05], rootCause: 'DPF regeneration failing on yard duty', resolution: 'forced regeneration plus a calibration update' },
  { family: 'BRAKE_SENSOR', powertrains: ['EV', 'DIESEL', 'HYBRID'], codes: ['C0035'], deviation: [0, 0.5], slope: [0, 0.02], rootCause: 'wheel-speed sensor connector corrosion (coastal depots)', resolution: 'connectors sealed and replaced' },
]; // prettier-ignore

/** 30 fictional past campaigns, identical on every run. */
export function pastCampaigns(n = 30): PastCampaign[] {
  const rng = new Rng(hashSeed('cohortwatch', 'past-campaigns-v1'));
  const out: PastCampaign[] = [];
  for (let i = 0; i < n; i++) {
    const t = TEMPLATES[i % TEMPLATES.length]!;
    const members = rng.int(5, 40);
    const codes: string[] = [];
    for (let k = 0; k < members; k++) codes.push(t.codes[rng.int(0, t.codes.length - 1)]!);
    out.push({
      id: uuidV5('0c7a3e51-6b2d-4f8e-a915-3d4c6b7e8f20', `past-${i}`),
      code: `PC-${2024 + (i % 3)}-${String(101 + i).padStart(3, '0')}`,
      year: 2024 + (i % 3),
      family: t.family,
      powertrain: t.powertrains[rng.int(0, t.powertrains.length - 1)]!,
      duty: SIM_DUTIES[rng.int(0, SIM_DUTIES.length - 1)]!,
      climate: SIM_CLIMATES[rng.int(0, SIM_CLIMATES.length - 1)]!,
      members,
      deviation: rng.uniform(t.deviation[0], t.deviation[1]),
      slopePerH: rng.uniform(t.slope[0], t.slope[1]),
      codes,
      rootCause: t.rootCause,
      resolution: t.resolution,
    });
  }
  return out;
}
