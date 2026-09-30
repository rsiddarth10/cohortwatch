/** Messages from worker processes to the main process. */
export type WorkerMessage =
  | { type: 'ready'; worker: number; vehicles: number; startupMs: number }
  | {
      type: 'sent';
      worker: number;
      counts: Record<string, number>;
      mess: Record<string, number>;
      simTs: number;
      /** Wall seconds the worker is behind the simulated clock (0 = keeping up). */
      lagS: number;
      queued: number;
    }
  | { type: 'send-error'; worker: number; error: string }
  | { type: 'repair-applied'; worker: number; vin: string; effectiveMs: number }
  | { type: 'history-progress'; worker: number; day: number; rows: number }
  | { type: 'history-done'; worker: number; rows: number; files: number }
  | { type: 'bench'; worker: number; sent: number; batchMs: number[] };

/** Messages from the main process to workers. */
export type MainMessage =
  | { type: 'start'; wallStartMs: number }
  | { type: 'repair'; vin: string; repairedAtMs: number }
  // S9 video helper: every worker freezes / resumes its clock at the same wall instant as the main process
  | { type: 'pause'; atWallMs: number }
  | { type: 'resume'; atWallMs: number };

export const WORKER_INDEX_ENV = 'CW_WORKER_INDEX';
export const WORKER_MODE_ENV = 'CW_WORKER_MODE';
export const SIM_START_ENV = 'CW_SIM_START_MS';
export const SPEED_ENV = 'CW_SPEED';
export const REPAIRS_ENV = 'CW_REPAIRS';
export const HISTORY_SPEC_ENV = 'CW_HISTORY_SPEC';
export const BENCH_SPEC_ENV = 'CW_BENCH_SPEC';
/** Bench mode writes only here (short retention, cleared after each run) so it never fills the raw topics. */
export const BENCH_TOPIC = 'bench.raw.v1';

export interface BenchSpec {
  /** Phases in wall seconds with a rate multiplier (1 = every vehicle once per second). */
  phases: { seconds: number; multiplier: number }[];
  wallStartMs: number;
}
