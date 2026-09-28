import { createHash } from 'node:crypto';
import {
  DEFAULT_MESS,
  applyFirmwarePlant,
  buildScenario,
  generateRegistry,
  withParams,
  type MessContext,
  type Registry,
  type Scenario,
  type SimParams,
} from '@cw/domain';
import type { SimulatorConfig } from '@cw/common';

/** Bump when the generator changes in a way that alters the registry for the same (seed, N, T0). */
export const MODEL_VERSION = '1b.1';

export interface World {
  registry: Registry;
  params: SimParams;
  scenario: Scenario;
  mess: MessContext;
  /** Identifies the seeded registry (seed, N, T0, params, model version). */
  registryHash: string;
  /** Identifies the scenario (registry + plant options). */
  scenarioHash: string;
}

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

/**
 * The whole simulated world is a pure function of the config (seed, N, T0, model params, plant options),
 * so every worker process builds an identical copy without reading the database.
 */
export function buildWorld(cfg: SimulatorConfig, overrides: Partial<SimParams> = {}): World {
  const params = withParams({ ...(cfg.model as Partial<SimParams>), ...overrides });
  const registry = generateRegistry(cfg.seed, cfg.scale, Date.parse(cfg.t0), params);
  const scenario = buildScenario(registry, params, {
    plants: cfg.plants === 'on',
    depotTransfer: cfg.depotTransfer === 'on',
  });
  applyFirmwarePlant(registry, scenario);
  const registryHash = hash({ v: MODEL_VERSION, seed: cfg.seed, n: cfg.scale, t0: cfg.t0, params });
  const scenarioHash = hash({ registryHash, plants: cfg.plants, transfer: cfg.depotTransfer });
  const mess: MessContext = {
    seed: cfg.seed,
    epochMs: registry.epochMs,
    cfg: DEFAULT_MESS,
    enabled: cfg.mess === 'on',
    aurexV2FromMs: scenario.aurexV2FromMs,
  };
  return { registry, params, scenario, mess, registryHash, scenarioHash };
}
