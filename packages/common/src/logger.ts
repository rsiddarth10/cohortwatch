import { pino, type Logger } from 'pino';

export type { Logger };

/** JSON logs to stdout (one line per event) so any log shipper can collect them. */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ name, level, base: { service: name }, timestamp: pino.stdTimeFunctions.isoTime });
}
