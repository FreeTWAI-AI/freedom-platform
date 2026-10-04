import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionRuntimeFiles } from '../suite-runner.mjs';

test('partition is exact, disjoint and rejects duplicates or invalid sizes', () => {
  const files = ['a', 'b', 'c', 'd', 'e'];
  const shards = partitionRuntimeFiles(files, 2);
  assert.deepEqual(shards.flat().sort(), files);
  assert.equal(new Set(shards.flat()).size, files.length);
  for (const [input, count] of [[['a', 'a'], 2], [['a'], 2], [files, 4]]) assert.throws(() => partitionRuntimeFiles(input, count));
});

