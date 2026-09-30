import { uuidV5 } from '../canonical/event.js';
import { bookingDiff, withBookings, type BaySlot, type QueueRow } from '../queue/bookings.js';

/**
 * The template agent (S8, ADR 0020) — no LLM. For a trigger it gathers evidence (existing clues and numbers only,
 * each cited by its source id), dry-runs the queue change with the S4 booking function, applies POLITE actions itself
 * (notes, "inspect at next visit") and turns DISRUPTIVE ones (bookings into bays) into proposals that only a lead
 * can approve. Text is filled from templates with real numbers; nothing is invented.
 */
export interface Evidence {
  source: 'campaign_clue' | 'incident_clue' | 'campaign_at_risk' | 'queue_item';
  id: string;
  text: string;
}

export interface Note {
  kind: 'NOTE' | 'INSPECT_NEXT_VISIT';
  vin: string | null;
  text: string;
  evidence: Evidence[];
}

export interface Proposal {
  id: string;
  actionType: 'BOOK_AT_RISK' | 'MOVE_RUNAWAY';
  title: string;
  body: string;
  evidence: Evidence[];
  diff: { changes: { vin: string; from: string; to: string }[]; summary: string };
  payload: { vin: string; slot: BaySlot }[];
}

export interface CampaignTrigger {
  campaignId: string;
  family: string;
  depotId: number;
  depotCode: string;
  members: number;
  clues: { ord: number; type: string; text: string }[];
  atRisk: { vin: string; reason: string }[];
  queue: QueueRow[];
  bays: number;
  alreadyBooked: ReadonlySet<string>;
}

export const AGENT_NAMESPACE = '7c4e2b19-5a8d-4f36-9e01-b2d3c4a5e6f7';

const cite = (campaignId: string, c: { ord: number; type: string; text: string }): Evidence => ({
  source: 'campaign_clue',
  id: `${campaignId}#${c.ord}`,
  text: c.text,
});

/** Campaign with at-risk sisters: notes (polite) + a proposal to book them into tomorrow's bays (disruptive). */
export function onCampaign(t: CampaignTrigger): { notes: Note[]; proposal: Proposal | null } {
  const key = t.clues
    .filter((c) => ['PLACE', 'TREND', 'FIRMWARE', 'SURPRISE', 'MONEY'].includes(c.type))
    .map((c) => cite(t.campaignId, c));
  const notes: Note[] = [];
  const sisters = t.atRisk.filter((a) => !t.alreadyBooked.has(a.vin));
  notes.push({
    kind: 'NOTE',
    vin: null,
    text: `${t.family} campaign at ${t.depotCode}: ${t.members} members; ${t.atRisk.length} at-risk sister${t.atRisk.length === 1 ? '' : 's'} flagged to inspect at their next visit.`,
    evidence: key,
  });
  for (const a of t.atRisk) {
    notes.push({
      kind: 'INSPECT_NEXT_VISIT',
      vin: a.vin,
      text: `Inspect ${a.vin} at its next visit: ${a.reason}.`,
      evidence: [{ source: 'campaign_at_risk', id: `${t.campaignId}#${a.vin}`, text: a.reason }],
    });
  }
  if (sisters.length === 0) return { notes, proposal: null };
  const bookings = new Map(sisters.map((s) => [s.vin, 'TOMORROW' as BaySlot]));
  const after = withBookings(t.queue, bookings, t.bays);
  const diff = bookingDiff(t.queue, after);
  const vins = sisters.map((s) => s.vin).sort();
  const n = vins.length;
  return {
    notes,
    proposal: {
      id: uuidV5(AGENT_NAMESPACE, `BOOK_AT_RISK|${t.campaignId}|${vins.join(',')}`),
      actionType: 'BOOK_AT_RISK',
      title: `Book the ${n} at-risk sister${n === 1 ? '' : 's'} of the ${t.family} campaign at ${t.depotCode} into tomorrow's bays`,
      body: `${t.members} vans in this campaign already have the fault. ${n === 1 ? 'This van shares' : `These ${n} share`} the model, duty and depot and ${n === 1 ? 'is' : 'are'} trending the same way (see evidence). Dry run: ${diff.summary}.`,
      evidence: [
        ...key,
        ...sisters.map((s) => ({
          source: 'campaign_at_risk' as const,
          id: `${t.campaignId}#${s.vin}`,
          text: s.reason,
        })),
      ],
      diff,
      payload: vins.map((vin) => ({ vin, slot: 'TOMORROW' as BaySlot })),
    },
  };
}

export interface RunawayTrigger {
  depotId: number;
  depotCode: string;
  vin: string;
  reason: { id: string; text: string };
  queue: QueueRow[];
  bays: number;
}

/** A runaway that is not in today's bays (e.g. more runaways than bays): propose moving it into today's first slot. */
export function onRunaway(t: RunawayTrigger): Proposal | null {
  const cur = t.queue.find((q) => q.vin === t.vin);
  if (!cur || cur.slot === 'TODAY') return null;
  const after = withBookings(t.queue, new Map([[t.vin, 'TODAY' as BaySlot]]), t.bays);
  const diff = bookingDiff(t.queue, after);
  return {
    id: uuidV5(AGENT_NAMESPACE, `MOVE_RUNAWAY|${t.vin}|${cur.slot}`),
    actionType: 'MOVE_RUNAWAY',
    title: `Move runaway ${t.vin} into today's first slot at ${t.depotCode}`,
    body: `${t.reason.text}. It is ${cur.slot === 'TOMORROW' ? 'booked for tomorrow' : 'waiting'} now. Dry run: ${diff.summary}.`,
    evidence: [{ source: 'queue_item', id: t.reason.id, text: t.reason.text }],
    diff,
    payload: [{ vin: t.vin, slot: 'TODAY' }],
  };
}
