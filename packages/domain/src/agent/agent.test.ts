import { describe, expect, it } from 'vitest';
import { bookingDiff, withBookings, type QueueRow } from '../queue/bookings.js';
import { onCampaign, onRunaway, type CampaignTrigger } from './agent.js';

const C = '11111111-1111-5111-8111-111111111111';
const row = (vin: string, rank: number, slot: QueueRow['slot'], pinned = false): QueueRow => ({
  vin,
  rank,
  slot,
  pinned,
});
const queue: QueueRow[] = [
  row('RUN', 1, 'TODAY', true),
  row('A', 2, 'TODAY'),
  row('B', 3, 'TOMORROW'),
  row('C', 4, 'TOMORROW'),
  row('S1', 5, 'WAITING'),
  row('S2', 6, 'WAITING'),
];

const trigger = (over: Partial<CampaignTrigger> = {}): CampaignTrigger => ({
  campaignId: C,
  family: 'COOLING',
  depotId: 1,
  depotCode: 'D-001',
  members: 14,
  clues: [
    { ord: 0, type: 'PLACE', text: '14 KS-D1 vans on urban duty at depot D-001, same COOLING fault' },
    { ord: 1, type: 'TREND', text: 'typical member is 4.1 °C above its own normal, rising 0.21 °C/h' },
    { ord: 2, type: 'CODES', text: 'top codes: P0217 (3 vans)' },
    {
      ord: 3,
      type: 'FIRMWARE',
      text: '12 of 14 got firmware 4.2.1 in the 3 days before onset, vs 44% of healthy sisters (20 of 45)',
    },
  ],
  atRisk: [
    { vin: 'S1', reason: 'above its own normal in 3 of the last 4 hours' },
    { vin: 'S2', reason: 'rising faster than its usual rate (z 2.4)' },
  ],
  queue,
  bays: 2,
  alreadyBooked: new Set(),
  ...over,
});

describe('bookings (shared by the workshop and the agent dry run)', () => {
  it('runaways stay first, booked vans take their slot, the rest fill what is left', () => {
    const after = withBookings(
      queue,
      new Map([
        ['S1', 'TOMORROW' as const],
        ['S2', 'TOMORROW' as const],
      ]),
      2,
    );
    expect(after.map((a) => `${a.vin}:${a.slot}`)).toEqual([
      'RUN:TODAY',
      'A:TODAY',
      'S1:TOMORROW',
      'S2:TOMORROW',
      'B:WAITING',
      'C:WAITING',
    ]);
    expect(after.map((a) => a.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    const d = bookingDiff(queue, after);
    expect(d.summary).toBe("2 vans move into tomorrow's bays; B drops to waiting; C drops to waiting");
    expect(bookingDiff(queue, queue).summary).toBe('no change to the bays');
    const today = withBookings(queue, new Map([['S1', 'TODAY' as const]]), 1);
    expect(today.find((a) => a.vin === 'S1')!.slot).toBe('TOMORROW'); // today is full with the runaway: next day
  });
});

describe('template agent', () => {
  it('a campaign with at-risk sisters → notes (polite) + one proposal (disruptive) with a dry-run diff', () => {
    const { notes, proposal } = onCampaign(trigger());
    expect(notes.map((n) => n.kind)).toEqual(['NOTE', 'INSPECT_NEXT_VISIT', 'INSPECT_NEXT_VISIT']);
    expect(notes[0]!.text).toBe(
      'COOLING campaign at D-001: 14 members; 2 at-risk sisters flagged to inspect at their next visit.',
    );
    expect(proposal).not.toBeNull();
    expect(proposal!.actionType).toBe('BOOK_AT_RISK');
    expect(proposal!.title).toBe("Book the 2 at-risk sisters of the COOLING campaign at D-001 into tomorrow's bays");
    expect(proposal!.payload).toEqual([
      { vin: 'S1', slot: 'TOMORROW' },
      { vin: 'S2', slot: 'TOMORROW' },
    ]);
    expect(proposal!.diff.summary).toBe("2 vans move into tomorrow's bays; B drops to waiting; C drops to waiting");
    expect(proposal!.body).toContain('Dry run: 2 vans move into tomorrow');
  });

  it('never cites a clue without a source id, and only clues it was given', () => {
    const t = trigger();
    const { notes, proposal } = onCampaign(t);
    const given = new Set([...t.clues.map((c) => `${C}#${c.ord}`), ...t.atRisk.map((a) => `${C}#${a.vin}`)]);
    for (const e of [...proposal!.evidence, ...notes.flatMap((n) => n.evidence)]) {
      expect(e.source).toBeTruthy();
      expect(given.has(e.id)).toBe(true);
    }
    const texts = new Set([...t.clues.map((c) => c.text), ...t.atRisk.map((a) => a.reason)]);
    for (const e of proposal!.evidence) expect(texts.has(e.text)).toBe(true);
  });

  it('is idempotent and never re-proposes vans already booked', () => {
    expect(onCampaign(trigger()).proposal!.id).toBe(onCampaign(trigger()).proposal!.id);
    expect(onCampaign(trigger({ alreadyBooked: new Set(['S1', 'S2']) })).proposal).toBeNull();
    const one = onCampaign(trigger({ alreadyBooked: new Set(['S1']) })).proposal!;
    expect(one.payload).toEqual([{ vin: 'S2', slot: 'TOMORROW' }]);
    expect(one.id).not.toBe(onCampaign(trigger()).proposal!.id);
    expect(onCampaign(trigger({ atRisk: [] })).proposal).toBeNull();
  });

  it('proposes moving a runaway into today only when it is not already there', () => {
    const q = [row('A', 1, 'TODAY'), row('RUN', 2, 'TOMORROW', true)];
    const p = onRunaway({
      depotId: 1,
      depotCode: 'D-001',
      vin: 'RUN',
      reason: { id: '1#RUN', text: 'runaway: ≈ 6 h to 110 °C' },
      queue: q,
      bays: 1,
    })!;
    expect(p.actionType).toBe('MOVE_RUNAWAY');
    expect(p.payload).toEqual([{ vin: 'RUN', slot: 'TODAY' }]);
    expect(p.body).toMatch(/^runaway: ≈ 6 h to 110 °C\. It is booked for tomorrow now\. Dry run: /);
    expect(
      onRunaway({ depotId: 1, depotCode: 'D-001', vin: 'A', reason: { id: 'x', text: 'y' }, queue: q, bays: 1 }),
    ).toBeNull();
    expect(
      onRunaway({ depotId: 1, depotCode: 'D-001', vin: 'NOPE', reason: { id: 'x', text: 'y' }, queue: q, bays: 1 }),
    ).toBeNull();
  });
});
