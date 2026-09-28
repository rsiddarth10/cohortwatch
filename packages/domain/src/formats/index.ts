import { oemById } from '../catalog.js';
import type { SimEvent } from '../simulate.js';
import { AUREX_V1, toAurexV1 } from './aurex-v1.js';
import { AUREX_V2, toAurexV2 } from './aurex-v2.js';
import { KESTREL_V1, toKestrel } from './kestrel.js';

export * from './aurex-v1.js';
export * from './aurex-v2.js';
export * from './kestrel.js';

export interface EncodedMessage {
  topic: string;
  key: string;
  /** Value for the x-source-format header, e.g. "aurex.v1". */
  format: string;
  value: string;
}

export interface EncodeOptions {
  /** OEM-A switches to format v2 for events at/after this sim time (brief §5.5). */
  aurexV2FromMs?: number;
}

/** The OEM payload object for an event (before JSON encoding). */
export function oemPayload(e: SimEvent, opts: EncodeOptions = {}): { topic: string; format: string; body: object } {
  const oem = oemById(e.oemId);
  if (oem.code === 'AUREX') {
    const v2 = opts.aurexV2FromMs !== undefined && e.eventTs >= opts.aurexV2FromMs;
    return v2
      ? { topic: oem.topic, format: AUREX_V2, body: toAurexV2(e) }
      : { topic: oem.topic, format: AUREX_V1, body: toAurexV1(e) };
  }
  return { topic: oem.topic, format: KESTREL_V1, body: toKestrel(e) };
}

/** Route an event to its OEM's raw topic, in that OEM's own payload format. */
export function encodeForOem(e: SimEvent, opts: EncodeOptions = {}): EncodedMessage {
  const p = oemPayload(e, opts);
  return { topic: p.topic, key: e.vin, format: p.format, value: JSON.stringify(p.body) };
}
