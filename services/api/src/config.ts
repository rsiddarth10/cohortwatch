import { z } from 'zod';

/** API configuration: environment only; defaults work against the compose stack from the host. */
export const ApiConfigSchema = z.object({
  PORT: z.coerce.number().int().default(3100),
  /** cw_api: subject to row-level security by tenant (ADR 0019). */
  DATABASE_URL: z.string().default('postgres://cw_api:cw_api_dev@localhost:15432/cohortwatch'),
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  OIDC_ISSUER: z.string().default('http://localhost:3200'),
  /** Where the API fetches the issuer's keys (inside compose: http://auth:3200/jwks). */
  OIDC_JWKS_URL: z.string().default('http://localhost:3200/jwks'),
  API_AUDIENCE: z.string().default('urn:cohortwatch:api'),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(600),
  REPAIRS_TOPIC: z.string().default('workshop.repairs.v1'),
  AUDIT_TOPIC: z.string().default('audit.v1'),
  PROPOSALS_TOPIC: z.string().default('agent.proposals.v1'),
  /** Topics streamed to the browser over SSE. */
  SSE_TOPICS: z.string().default('queue.events.v1,campaign.events.v1,agent.proposals.v1'),
  LOG_LEVEL: z.string().default('info'),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => ApiConfigSchema.parse(env);
