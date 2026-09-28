import { oemById } from '../catalog.js';
import type { SimEvent } from '../simulate.js';
import { AUREX_V1, toAurexV1 } from './aurex-v1.js';
import { KESTREL_V1, toKestrel } from './kestrel.js';

export * from './aurex-v1.js';
export * from './kestrel.js';

export interface EncodedMessage {
  topic: string;
  key: string;
  /** Value for the x-source-format header, e.g. "aurex.v1". */
  format: string;
  value: string;
}

/** Route an event to its OEM's raw topic, in that OEM's own payload format. */
export function encodeForOem(e: SimEvent): EncodedMessage {
  const oem = oemById(e.oemId);
  if (oem.code === 'AUREX') {
    return { topic: oem.topic, key: e.vin, format: AUREX_V1, value: JSON.stringify(toAurexV1(e)) };
  }
  return { topic: oem.topic, key: e.vin, format: KESTREL_V1, value: JSON.stringify(toKestrel(e)) };
}
