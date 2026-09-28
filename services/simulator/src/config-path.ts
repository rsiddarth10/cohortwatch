import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** config/simulator.yaml next to src/ and dist/, unless SIM_CONFIG points elsewhere. */
export function configPath(): string {
  return process.env.SIM_CONFIG ?? resolve(dirname(fileURLToPath(import.meta.url)), '../config/simulator.yaml');
}
