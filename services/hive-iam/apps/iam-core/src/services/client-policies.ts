import { z } from 'zod';
const policySchema = z.object({
  audience: z.string().min(1).max(200),
  permissions: z.array(z.string().regex(/^[a-z0-9-]+(?::[a-z0-9-]+)+$/)).max(100).default([]),
  lifetimeSeconds: z.number().int().min(60).max(3600).default(900),
  rotationOwner: z.string().min(1).max(200),
}).strict();
export type ClientPolicy = z.infer<typeof policySchema>;
const reserved = new Set(['hive-router', 'security-exporter', 'example-portal']);
export function parseClientPolicies(raw = '{}'): Readonly<Record<string, ClientPolicy>> {
  const policies = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), policySchema).parse(JSON.parse(raw));
  for (const key of Object.keys(policies)) if (reserved.has(key)) throw new Error(`Built-in policy cannot be overridden: ${key}`);
  return Object.freeze(policies);
}
// Config is local to this IAM install and takes effect only after a reviewed restart.
export const machineClientPolicies = parseClientPolicies(process.env.IAM_MACHINE_CLIENT_POLICIES);
