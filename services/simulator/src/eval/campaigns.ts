import { H, horizonH, rowsOf, sinceT0, type Check, type EvalContext } from './common.js';

/**
 * S5 scorecard as data: campaigns vs the plants. "Campaign" = a group that opened (OPEN or DISMISSED); WATCHING
 * groups are not campaigns.
 */
export interface CampaignFacts {
  horizonH: number | null;
  opened: number;
  watching: number;
  merged: number;
  s1Campaigns: number;
  s1Recall: number;
  s1Intruders: number;
  s1bCampaigns: number;
  s1bRecall: number;
  s1bSeparate: boolean;
  s1bIntruders: number;
  lateFlagged: number;
  lateTotal: number;
  lateLeadsH: number[];
  healthyCohortFlagged: number;
  decoysAdmitted: number;
  heatwaveCampaigns: number;
  backgroundCampaigns: number;
  firmwareClue: string | null;
  earlyWarningH: number | null;
  memberRows: number;
  uniqueMembers: number;
  outboxRows: number;
  outboxUnpublished: number;
}

export interface CampaignList {
  key: string;
  status: string;
  members: number;
  at_risk: number;
  opened_ts: Date | null;
  p: number | null;
}

export const S1_ROLES = ['s1_sister', 's1_late_sister', 'bad_repair'];

export async function evalCampaigns(
  e: EvalContext,
): Promise<{ checks: Check[]; facts: CampaignFacts; list: CampaignList[] }> {
  const q = <T extends import('pg').QueryResultRow>(sql: string, args: unknown[] = []) =>
    rowsOf<T>(e.client, sql, args);
  const h = (d: Date | null | undefined) => sinceT0(e.t0, d);
  const checks: Check[] = [];
  const [counts] = await q<{ campaigns: number; watching: number; merged: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('OPEN', 'DISMISSED'))::int AS campaigns,
            count(*) FILTER (WHERE status = 'WATCHING')::int AS watching, count(*) FILTER (WHERE status = 'MERGED')::int AS merged
     FROM core.campaign`,
  );
  const members = await q<{ id: string; role: string; vin: string }>(
    `SELECT c.id, g.role, m.vin::text AS vin FROM core.campaign c
     JOIN core.campaign_member m ON m.campaign_id = c.id AND m.active
     JOIN sim.ground_truth g ON g.vin = m.vin WHERE c.status IN ('OPEN', 'DISMISSED')`,
  );
  const campaignsWith = (roles: string[]) => new Set(members.filter((m) => roles.includes(m.role)).map((m) => m.id));
  const s1c = campaignsWith(S1_ROLES);
  const s1bc = campaignsWith(['s1b_sister']);
  const inCampaigns = (ids: Set<string>) => members.filter((m) => ids.has(m.id));
  const s1m = inCampaigns(s1c);
  const s1Intruders = s1m.filter((m) => !S1_ROLES.includes(m.role)).length;
  const s1Recall = new Set(s1m.filter((m) => S1_ROLES.includes(m.role)).map((m) => m.vin)).size;
  checks.push(['S1', 'exactly 1 campaign; members ⊆ sisters', `${s1c.size} campaign(s); ${s1Recall}/18 sisters; ${s1Intruders} non-sisters`]); // prettier-ignore
  const s1bm = inCampaigns(s1bc);
  const s1bRecall = new Set(s1bm.filter((m) => m.role === 's1b_sister').map((m) => m.vin)).size;
  const s1bSeparate = ![...s1bc].some((id) => s1c.has(id));
  const s1bIntruders = s1bm.filter((m) => m.role !== 's1b_sister').length;
  checks.push(['S1b', 'exactly 1, separate from S1', `${s1bc.size} campaign(s); ${s1bRecall}/8 sisters; ${s1bSeparate ? 'separate' : 'SHARED with S1'}; ${s1bIntruders} non-sisters`]); // prettier-ignore

  const late = await q<{ vin: string; at_risk: Date | null; incident: Date | null }>(
    `SELECT g.vin::text AS vin,
       (SELECT min(a.first_ts) FROM core.campaign_at_risk a WHERE a.vin = g.vin) AS at_risk,
       (SELECT min(i.opened_ts) FROM core.incident i WHERE i.vin = g.vin AND i.fault_family = 'COOLING') AS incident
     FROM sim.ground_truth g WHERE g.role = 's1_late_sister'`,
  );
  const before = late.filter((l) => l.at_risk && (!l.incident || l.at_risk < l.incident));
  const leads = before.filter((l) => l.incident).map((l) => (l.incident!.getTime() - l.at_risk!.getTime()) / H);
  checks.push(['Late sisters', 'at-risk before own incident; lead (h)', `${before.length}/${late.length} (${Math.round((100 * before.length) / Math.max(1, late.length))}%); lead ${leads.length ? leads.map((x) => x.toFixed(1)).join(', ') : '–'} h`]); // prettier-ignore
  const [fp] = await q<{ n: number }>(
    `SELECT count(DISTINCT a.vin)::int AS n FROM core.campaign_at_risk a JOIN sim.ground_truth g ON g.vin = a.vin
     WHERE g.role = 's1_healthy_cohort'`,
  );
  checks.push(['At-risk false positives', 'healthy S1 cohort flagged', `${fp!.n}/42`]);
  const decoys = new Set(
    members.filter((m) => m.role === 'decoy_scattered' || m.role === 'decoy_same_depot_other_model').map((d) => d.vin),
  ).size;
  checks.push(['Decoys', 'admitted to any campaign = 0', `${decoys}`]);
  const heat = campaignsWith(['heatwave_region']);
  checks.push(['Heatwave region', 'campaigns = 0', `${heat.size}`]);
  const plantRoles = new Set([...S1_ROLES, 's1b_sister', 'decoy_scattered', 'decoy_same_depot_other_model', 'runaway']);
  const bgOnly = [...new Set(members.map((m) => m.id))].filter(
    (id) => !heat.has(id) && members.filter((m) => m.id === id).every((m) => !plantRoles.has(m.role)),
  );
  checks.push(['Background', 'campaigns = 0', `${bgOnly.length}`]);

  const clue = await q<{ text: string }>(
    `SELECT text FROM core.campaign_clue WHERE clue_type = 'FIRMWARE' AND campaign_id = ANY($1)`,
    [[...s1c]],
  );
  const fw = await q<{ grp: string; n: number }>(
    `SELECT CASE WHEN g.expected_campaign = 'S1' THEN 'sister' ELSE 'healthy' END AS grp, count(DISTINCT h.vin)::int AS n
     FROM sim.ground_truth g JOIN core.vehicle_firmware_history h ON h.vin = g.vin
     JOIN core.firmware_release r ON r.id = h.firmware_id AND r.version = '4.2.1'
     WHERE g.role IN ('s1_sister','bad_repair','s1_late_sister','s1_healthy_cohort')
       AND h.installed_at >= $1::timestamptz - interval '72 hours' AND h.installed_at < $1::timestamptz + interval '6 hours'
     GROUP BY 1`,
    [new Date(e.t0).toISOString()],
  );
  const man = (g: string) => fw.find((r) => r.grp === g)?.n ?? 0;
  checks.push(['Firmware clue', 'S1 clue printed; matches the plant', `"${clue[0]?.text ?? '(none)'}" · plant: ${man('sister')}/18 sisters, ${man('healthy')}/42 healthy (${Math.round((100 * man('healthy')) / 42)}%)`]); // prettier-ignore

  const [ew] = await q<{ opened: Date | null; limit_ts: Date | null }>(
    `SELECT (SELECT min(opened_ts) FROM core.campaign WHERE id = ANY($1)) AS opened,
            (SELECT min(limit_ts) FROM sim.ground_truth WHERE role IN ('s1_sister', 's1_late_sister', 'bad_repair')) AS limit_ts`,
    [[...s1c]],
  );
  const earlyWarningH = ew?.opened && ew.limit_ts ? (ew.limit_ts.getTime() - ew.opened.getTime()) / H : null;
  checks.push(['Early warning', 'S1 OPEN → first sister limit_ts', earlyWarningH === null ? '–' : `${earlyWarningH.toFixed(1)} h (opened ${h(ew!.opened)}, limit ${h(ew!.limit_ts)})`]); // prettier-ignore
  const [cnt] = await q<{ rows: number; vins: number; outbox: number; unpublished: number }>(
    `SELECT (SELECT count(*)::int FROM core.campaign_member WHERE active) AS rows,
            (SELECT count(DISTINCT (vin, fault_family))::int FROM core.campaign_member WHERE active) AS vins,
            (SELECT count(*)::int FROM core.outbox) AS outbox,
            (SELECT count(*)::int FROM core.outbox WHERE published_at IS NULL) AS unpublished`,
  );
  checks.push(['Counting', 'members = unique VINs after restarts', `${cnt!.rows} member rows = ${cnt!.vins} unique (vin, family); outbox ${cnt!.outbox} rows, ${cnt!.unpublished} unpublished`]); // prettier-ignore

  const list = await q<CampaignList>(
    `SELECT family_key AS key, status, member_count AS members, at_risk_count AS at_risk, opened_ts, p_value AS p
     FROM core.campaign WHERE status IN ('OPEN', 'DISMISSED') ORDER BY opened_ts`,
  );
  return {
    checks,
    list,
    facts: {
      horizonH: await horizonH(e.client, e.t0),
      opened: counts!.campaigns,
      watching: counts!.watching,
      merged: counts!.merged,
      s1Campaigns: s1c.size,
      s1Recall,
      s1Intruders,
      s1bCampaigns: s1bc.size,
      s1bRecall,
      s1bSeparate,
      s1bIntruders,
      lateFlagged: before.length,
      lateTotal: late.length,
      lateLeadsH: leads,
      healthyCohortFlagged: fp!.n,
      decoysAdmitted: decoys,
      heatwaveCampaigns: heat.size,
      backgroundCampaigns: bgOnly.length,
      firmwareClue: clue[0]?.text ?? null,
      earlyWarningH,
      memberRows: cnt!.rows,
      uniqueMembers: cnt!.vins,
      outboxRows: cnt!.outbox,
      outboxUnpublished: cnt!.unpublished,
    },
  };
}
