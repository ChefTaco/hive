import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildDevHivePlan } from './dev-hive.ts';
import { makeTempRoot } from './test-fixtures.ts';

describe('dev-hive bootstrap plan', () => {
  it('builds a disposable local stack plan with generated local secrets', () => {
    const root = makeTempRoot('hive-dev-plan-');
    const plan = buildDevHivePlan(root);
    assert.equal(plan.stateDir, join(root, '.hive-dev'));
    assert.match(plan.memoryToken, /^[^.]+\.[^.]+\.[^.]+$/);
    assert.deepEqual(plan.services.map((service) => service.name), ['memory', 'iam', 'router', 'ui']);
    assert.equal(plan.services.find((service) => service.name === 'router')?.env.HIVE_ROUTER_MEMORY_PROXY_TOKEN, plan.memoryToken);
    assert.equal(plan.services.find((service) => service.name === 'iam')?.env.PORT, '4200');
    assert.equal(plan.services.find((service) => service.name === 'memory')?.env.QDRANT_URL, 'http://127.0.0.1:6333');
  });
});
