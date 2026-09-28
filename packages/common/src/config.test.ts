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
mode: demo
speed: 360
mess: 'on'
autoRepairs: 'off'
depotTransfer: 'off'
simPrivateDir: data/sim-private
lake: { endpoint: 'http://localhost:19000', region: us-east-1, accessKeyId: a, secretAccessKey: b, bucket: cohortwatch-lake, forcePathStyle: true }
history: { days: 7, intervalMin: 30 }
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

  it('accepts step-1b settings from env (plants, mode, speed, lake, thresholds)', () => {
    const c = loadSimulatorConfig(yaml, {
      PLANTS: 'on',
      SIM_MODE: 'live',
      SIM_SPEED: '720',
      AUTO_REPAIRS: 'on',
      S3_ENDPOINT: 'http://rustfs:9000',
      LAKE_BUCKET: 'other',
      GLOBAL_COOLANT_THRESHOLD_C: '98',
      GLOBAL_BATT_TEMP_THRESHOLD_C: '48',
    });
    expect(c).toMatchObject({ plants: 'on', mode: 'live', speed: 720, autoRepairs: 'on' });
    expect(c.lake).toMatchObject({ endpoint: 'http://rustfs:9000', bucket: 'other', forcePathStyle: true });
    expect(c.model).toMatchObject({ cadenceMin: 30, globalCoolantThresholdC: 98, globalBattTempThresholdC: 48 });
    expect(c.history).toEqual({ days: 7, intervalMin: 30 });
  });
});
