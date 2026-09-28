import { generateRegistry, withParams, type Registry, type SimParams } from '@cw/domain';
import type { SimulatorConfig } from '@cw/common';

export interface World {
  registry: Registry;
  params: SimParams;
}

/** The whole simulated world is a pure function of the config (seed, N, T0, model params). */
export function buildWorld(cfg: SimulatorConfig): World {
  const params = withParams(cfg.model as Partial<SimParams>);
  const registry = generateRegistry(cfg.seed, cfg.scale, Date.parse(cfg.t0), params);
  return { registry, params };
}
