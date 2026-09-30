import { HOUR_MS } from '../time.js';
import type { CampaignParams } from './params.js';

/**
 * Firmware clue (brief §1.3.3): did the members get the same update just before their fault? Fair comparison:
 * the share of members who got version X in the `windowDays` before THEIR first incident, vs the share of
 * non-member sisters (same family key) who got X in the `windowDays` before the CAMPAIGN's first incident.
 * X = the version most members got in their window. Shown only when enough members got it and the gap is large.
 */
export interface Install {
  version: string;
  ts: number;
}

export interface FirmwareInput {
  members: readonly { vin: string; firstIncidentTs: number; installs: readonly Install[] }[];
  sisters: readonly { vin: string; installs: readonly Install[] }[];
  campaignFirstTs: number;
}

export interface FirmwareClue {
  version: string;
  membersWith: number;
  members: number;
  sistersWith: number;
  sisters: number;
  memberShare: number;
  sisterShare: number;
  shown: boolean;
  text: string;
}

const within = (installs: readonly Install[], version: string, endTs: number, days: number) =>
  installs.some((i) => i.version === version && i.ts <= endTs && i.ts > endTs - days * 24 * HOUR_MS);

export function firmwareClue(i: FirmwareInput, p: CampaignParams['firmware']): FirmwareClue | null {
  if (i.members.length === 0) return null;
  const counts = new Map<string, number>();
  for (const m of i.members) {
    const seen = new Set<string>();
    for (const inst of m.installs) {
      if (!seen.has(inst.version) && within([inst], inst.version, m.firstIncidentTs, p.windowDays)) {
        seen.add(inst.version);
        counts.set(inst.version, (counts.get(inst.version) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return null;
  const [version, membersWith] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  const sistersWith = i.sisters.filter((s) => within(s.installs, version, i.campaignFirstTs, p.windowDays)).length;
  const memberShare = membersWith / i.members.length;
  const sisterShare = i.sisters.length > 0 ? sistersWith / i.sisters.length : 0;
  const shown =
    memberShare >= p.minMemberShare && i.sisters.length > 0 && (memberShare - sisterShare) * 100 >= p.minGapPts;
  const d = p.windowDays;
  return {
    version,
    membersWith,
    members: i.members.length,
    sistersWith,
    sisters: i.sisters.length,
    memberShare,
    sisterShare,
    shown,
    text: `${membersWith} of ${i.members.length} got firmware ${version} in the ${d} days before onset, vs ${Math.round(
      sisterShare * 100,
    )}% of healthy sisters (${sistersWith} of ${i.sisters.length})`,
  };
}
