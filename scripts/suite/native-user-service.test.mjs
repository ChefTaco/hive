import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticUnitName } from './native-user-service.mjs';
test('real user-service rehearsal refuses non-synthetic and ambiguous ownership names', () => {
  assert.equal(
    syntheticUnitName('native-proof-012345abcd', 'native-magnus'),
    'hive-native-proof-012345abcd-native-magnus.service',
  );
  for (const installation of [
    'production',
    'native-proof-../owned',
    'native-proof-short',
    'native-proof-012345abcd.service',
  ])
    assert.throws(() => syntheticUnitName(installation, 'native-magnus'));
  assert.throws(() => syntheticUnitName('native-proof-012345abcd', 'existing-agent'));
});
