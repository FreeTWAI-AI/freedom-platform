import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionRuntimeFiles } from '../suite-runner.mjs';

test('partition is exact, disjoint and rejects duplicates or invalid sizes', () => {
  const files = ['a', 'b', 'c', 'd', 'e'];
  for (const count of [1, 2, 4]) {
  const shards = partitionRuntimeFiles(files, count);
  assert.deepEqual(shards.flat().sort(), files);
  assert.equal(new Set(shards.flat()).size, files.length);
  assert(Math.max(...shards.map(s=>s.length))-Math.min(...shards.map(s=>s.length))<=1);
  }
  for (const [input, count] of [[['a', 'a'], 2], [['a'], 2], [files, 3]]) assert.throws(() => partitionRuntimeFiles(input, count));
});

