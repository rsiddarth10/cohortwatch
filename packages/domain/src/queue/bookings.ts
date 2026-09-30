/**
 * Bookings (S8): a lead-approved proposal books vans into a slot. The workshop applies them to the real queue, and
 * the agent uses the same function to DRY-RUN a proposal and describe the change ("3 vans move into tomorrow's bays;
 * van X drops to waiting"). Runaways stay first; booked vans come next in their slot; the rest fill what is left
 * in rank order (only items that were bay-eligible before keep a bay).
 */
export type BaySlot = 'TODAY' | 'TOMORROW';

export interface QueueRow {
  vin: string;
  rank: number;
  slot: 'TODAY' | 'TOMORROW' | 'WAITING';
  pinned: boolean;
  /** Could take a bay (score ≥ threshold or pinned); defaults to "had a bay". */
  eligible?: boolean;
}

export interface Booked<T extends QueueRow> extends Omit<QueueRow, 'slot'> {
  row: T;
  slot: 'TODAY' | 'TOMORROW' | 'WAITING';
  rank: number;
  booked: boolean;
}

export function withBookings<T extends QueueRow>(
  rows: readonly T[],
  bookings: ReadonlyMap<string, BaySlot>,
  perDay: number,
): Booked<T>[] {
  const eligible = (r: T) => r.eligible ?? r.slot !== 'WAITING';
  const ordered = [...rows].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(bookings.has(b.vin)) - Number(bookings.has(a.vin)) ||
      (bookings.get(a.vin) === 'TODAY' ? 0 : 1) - (bookings.get(b.vin) === 'TODAY' ? 0 : 1) ||
      a.rank - b.rank,
  );
  const used = { TODAY: 0, TOMORROW: 0 };
  const take = (s: BaySlot) => (used[s] < perDay ? (used[s]++, true) : false);
  const placed = ordered.map((r, i) => {
    const want = bookings.get(r.vin);
    let slot: Booked<T>['slot'] = 'WAITING';
    if (r.pinned) slot = take('TODAY') ? 'TODAY' : take('TOMORROW') ? 'TOMORROW' : 'WAITING';
    else if (want) slot = take(want) ? want : want === 'TODAY' && take('TOMORROW') ? 'TOMORROW' : 'WAITING';
    else if (eligible(r)) slot = take('TODAY') ? 'TODAY' : take('TOMORROW') ? 'TOMORROW' : 'WAITING';
    return {
      vin: r.vin,
      pinned: r.pinned,
      eligible: r.eligible,
      row: r,
      slot,
      rank: i + 1,
      booked: want !== undefined,
    };
  });
  // ranks follow the slots: today's bays, then tomorrow's, then waiting (processing order within each)
  const order = { TODAY: 0, TOMORROW: 1, WAITING: 2 };
  return placed.sort((a, b) => order[a.slot] - order[b.slot] || a.rank - b.rank).map((p, i) => ({ ...p, rank: i + 1 }));
}

export interface SlotChange {
  vin: string;
  from: QueueRow['slot'];
  to: QueueRow['slot'];
}

/** What a booking would change, in words and as rows (the dry-run diff of an agent proposal). */
export function bookingDiff(
  before: readonly QueueRow[],
  after: readonly { vin: string; slot: QueueRow['slot'] }[],
): { changes: SlotChange[]; summary: string } {
  const was = new Map(before.map((r) => [r.vin, r.slot]));
  const changes = after
    .filter((a) => was.get(a.vin) !== a.slot)
    .map((a) => ({ vin: a.vin, from: was.get(a.vin) ?? 'WAITING', to: a.slot }));
  const into = (s: string) => changes.filter((c) => c.to === s && c.from !== s).length;
  const parts: string[] = [];
  const nToday = into('TODAY');
  const nTomorrow = into('TOMORROW');
  if (nToday) parts.push(`${nToday} van${nToday > 1 ? 's' : ''} move${nToday > 1 ? '' : 's'} into today's bays`);
  if (nTomorrow)
    parts.push(`${nTomorrow} van${nTomorrow > 1 ? 's' : ''} move${nTomorrow > 1 ? '' : 's'} into tomorrow's bays`);
  for (const c of changes.filter((x) => x.to === 'WAITING')) parts.push(`${c.vin} drops to waiting`);
  for (const c of changes.filter((x) => x.from === 'TODAY' && x.to === 'TOMORROW'))
    parts.push(`${c.vin} moves from today to tomorrow`);
  return { changes, summary: parts.length ? parts.join('; ') : 'no change to the bays' };
}
