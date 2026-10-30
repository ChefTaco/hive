import { expect, it } from 'vitest';
import { parseClientPolicies } from './client-policies.js';
it('defaults to no machine clients and refuses privileged wildcard policies or built-in overrides', () => {
  expect(parseClientPolicies()).toEqual({});
  expect(() => parseClientPolicies('{"hive-router":{}}')).toThrow();
  expect(() => parseClientPolicies(JSON.stringify({ example: { audience: 'example', permissions: ['*'], rotationOwner: 'owner' } }))).toThrow();
  expect(parseClientPolicies(JSON.stringify({ example: { audience: 'example', rotationOwner: 'owner' } })).example?.permissions).toEqual([]);
});
