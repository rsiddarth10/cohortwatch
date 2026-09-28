import { describe, expect, it } from 'vitest';
import { loadSimulatorConfig } from './config.js';

const yaml = `
scale: 5000
seed: s
workers: 4
t0: '2026-09-28T04:00:00Z'
plants: 'off'
kafka: { brokers: 'localhost:19092', clientId: cw, lingerMs: 10 }
databaseUrl: postgres://x
metricsPort: 9464
tickMs: 250
logLevel: info
model: { cadenceMin: 30 }
`;

describe('loadSimulatorConfig', () => {
  it('reads YAML defaults', () => {
    const c = loadSimulatorConfig(yaml, {});
    expect(c.scale).toBe(5000);
    expect(c.kafka.brokers).toBe('localhost:19092');
    expect(c.model.cadenceMin).toBe(30);
  });

  it('lets env override scale, seed, workers, brokers and database', () => {
    const c = loadSimulatorConfig(yaml, {
      SIM_SCALE: '100000',
      SIM_SEED: 'other',
      SIM_WORKERS: '8',
      KAFKA_BROKERS: 'redpanda:9092',
      DATABASE_URL: 'postgres://y',
      METRICS_PORT: '9000',
      LOG_LEVEL: 'warn',
    });
    expect(c).toMatchObject({ scale: 100000, seed: 'other', workers: 8, databaseUrl: 'postgres://y' });
    expect(c.kafka.brokers).toBe('redpanda:9092');
    expect(c.metricsPort).toBe(9000);
    expect(c.logLevel).toBe('warn');
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadSimulatorConfig(yaml, { SIM_SCALE: '12' })).toThrow(/scale/);
    expect(() => loadSimulatorConfig(yaml, { SIM_T0: 'yesterday' })).toThrow(/t0/);
  });

  it('refuses PLANTS=on until step 1b', () => {
    expect(() => loadSimulatorConfig(yaml, { PLANTS: 'on' })).toThrow(/1b/);
  });
});
