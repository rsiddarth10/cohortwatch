/** Messages from worker processes to the main process. */
export type WorkerMessage =
  | { type: 'ready'; worker: number; vehicles: number; startupMs: number }
  | { type: 'sent'; worker: number; counts: Record<string, number>; simTs: number }
  | { type: 'send-error'; worker: number; error: string };

export const WORKER_INDEX_ENV = 'CW_WORKER_INDEX';
