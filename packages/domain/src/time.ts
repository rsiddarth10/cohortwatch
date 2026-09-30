export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Simulated-time clock. All generation reads simulated time through this interface;
 * wall-clock time is only used for latency and throughput measurements.
 */
export interface Clock {
  /** Current simulated time, epoch ms. */
  now(): number;
  /** Simulated seconds per wall second. */
  readonly speed: number;
}

/** Step 1a: live clock at 1x, simulated time == wall time. Speed-up and T0 modes arrive in 1b. */
export class LiveClock implements Clock {
  readonly speed = 1;
  constructor(private readonly wallNow: () => number = Date.now) {}
  now(): number {
    return this.wallNow();
  }
}

/**
 * Scaled simulated clock (step 1b): simulated time starts at `simStartMs` when the wall clock reads
 * `wallStartMs`, then advances `speed` simulated ms per wall ms. Demo mode uses speed 360
 * (1 wall-second = 6 sim-minutes). Workers share (simStart, wallStart, speed), so they agree on "now".
 *
 * S9 (video helper): the clock can be paused and resumed at a given wall time. While paused, "now" stands still,
 * so the simulator produces nothing new and the whole story waits. The main process sends the same wall times to
 * every worker, so they stay in agreement.
 */
export class SimClock implements Clock {
  private pausedAtWall: number | null = null;
  private pausedTotalMs = 0;

  constructor(
    readonly simStartMs: number,
    readonly speed: number,
    readonly wallStartMs: number = Date.now(),
    private readonly wallNow: () => number = Date.now,
  ) {
    if (!(speed > 0)) throw new Error('clock speed must be > 0');
  }
  now(): number {
    const wall = this.pausedAtWall ?? this.wallNow();
    return this.simStartMs + (wall - this.wallStartMs - this.pausedTotalMs) * this.speed;
  }
  /** Wall-clock ms at which simulated time `simMs` is reached (assuming no further pause). */
  wallAt(simMs: number): number {
    return this.wallStartMs + this.pausedTotalMs + (simMs - this.simStartMs) / this.speed;
  }
  get paused(): boolean {
    return this.pausedAtWall !== null;
  }
  /** Freeze "now" as of wall time `atWallMs`. Idempotent. */
  pause(atWallMs: number = this.wallNow()): void {
    if (this.pausedAtWall === null) this.pausedAtWall = atWallMs;
  }
  /** Continue from where it stood: the paused wall interval is skipped. Idempotent. */
  resume(atWallMs: number = this.wallNow()): void {
    if (this.pausedAtWall === null) return;
    this.pausedTotalMs += Math.max(0, atWallMs - this.pausedAtWall);
    this.pausedAtWall = null;
  }
}

/** Deterministic clock for tests. */
export class ManualClock implements Clock {
  readonly speed = 1;
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Start of the simulated world (= start of the history window): T0 minus `historyDays`,
 * aligned down to the vehicle-day boundary (`dayStartHourUtc`). Sim-day 0 starts here.
 */
export function worldEpochMs(t0Ms: number, historyDays: number, dayStartHourUtc: number): number {
  const target = t0Ms - historyDays * DAY_MS;
  const shift = dayStartHourUtc * HOUR_MS;
  return Math.floor((target - shift) / DAY_MS) * DAY_MS + shift;
}
