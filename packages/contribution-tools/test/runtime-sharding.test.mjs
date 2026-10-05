import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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



test('reviewed hosted costs distribute heavy fixtures without losing unfinished or newly added files', () => {
  const observation = JSON.parse(readFileSync(new URL('./fixtures/runtime-hosted-costs.json', import.meta.url)));
  const files = Object.keys(observation.milliseconds).map(name => 'tests/runtime/' + name).sort();
  const cost = path => observation.milliseconds[path.split('/').at(-1)] ?? 0;
  const original = Array.from({ length: 4 }, (_, i) => files.filter((_, index) => index % 4 === i));
  const total = shard => shard.reduce((sum, path) => sum + cost(path), 0);
  assert(Math.max(...original.map(total)) > 860_000, 'historical serial hotspot is reproduced');
  const partitions = partitionRuntimeFiles(files, 4);
  assert(Math.max(...partitions.map(total)) < 700_000, 'observed completed work is balanced; unfinished files are not a timing prediction');
  assert.deepEqual(partitions.flat().sort(), files);
  assert(partitions.every(shard => JSON.stringify(shard) === JSON.stringify([...shard].sort())));
  assert.deepEqual(partitionRuntimeFiles(files, 1), [files]);
  for (const count of [2, 4]) {
    const expanded = [...files, 'tests/runtime/new-unmeasured.test.ts'].sort();
    const shards = partitionRuntimeFiles(expanded, count);
    assert.deepEqual(shards.flat().sort(), expanded);
    assert.equal(new Set(shards.flat()).size, expanded.length);
    assert.deepEqual(partitionRuntimeFiles(expanded, count), shards);
    assert.equal(shards.length, count);
  }
});
