import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConsumerEntryCoverage } from '../consumer-entry-coverage.mjs';
const pkg = '{"type":"module","scripts":{"start":"node src/server.mjs"},"exports":{".":"./src/index.mjs"}}';
function fixture() {
  const baseline = new Map([['package.json', pkg], ['src/index.mjs', 'export const value = 1;'],
    ['.github/workflows/verify.yml', 'name: approved'], ['tool', '#!/bin/sh\nexit 0\n']]);
  const candidate = new Map(baseline);
  const tree = values => new Map([...values.keys()].map(path => [path, { mode: path === 'tool' ? '100755' : '100644' }]));
  const baselineFiles = tree(baseline), candidateFiles = tree(candidate);
  return { baseline, candidate, input: { baselineFiles, candidateFiles,
    readBaseline: async path => Buffer.from(baseline.get(path)), readCandidate: async path => Buffer.from(candidate.get(path)) } };
}
test('changed existing automation and executable mode registrations are rejected', async () => {
  const f = fixture(); f.candidate.set('.github/workflows/verify.yml', 'name: unreviewed');
  await assert.rejects(verifyConsumerEntryCoverage(f.input), { code: 'consumer_entry_automation_changed' });
  const g = fixture(); g.input.candidateFiles.set('src/index.mjs', { mode: '100755' });
  await assert.rejects(verifyConsumerEntryCoverage(g.input), { code: 'consumer_executable_registration_changed' });
});
test('existing aliases cannot be redirected and duplicate metadata interpretations fail closed', async () => {
  const f = fixture(); f.candidate.set('package.json', pkg.replace('./src/index.mjs', './src/bypass.mjs'));
  await assert.rejects(verifyConsumerEntryCoverage(f.input), { code: 'consumer_entry_registration_changed' });
  f.candidate.set('package.json', '{"scripts":{},"scripts":{"start":"node bypass.mjs"}}');
  await assert.rejects(verifyConsumerEntryCoverage(f.input), { code: 'duplicate_json_key' });
});
test('missing package baseline and invalid inventory input fail closed', async () => {
  await assert.rejects(verifyConsumerEntryCoverage({}), { code: 'trusted_entry_inventory_required' });
  const f = fixture(); f.input.baselineFiles.delete('package.json');
  await assert.rejects(verifyConsumerEntryCoverage(f.input), { code: 'consumer_package_required' });
});

test('prototype fields, escaped duplicate keys and case-variant package additions cannot hide registration', async () => {
  const f = fixture(); f.candidate.set('package.json', '{"__proto__":{"scripts":{"start":"node bypass.mjs"}}}');
  await assert.rejects(verifyConsumerEntryCoverage(f.input), { code: 'consumer_entry_registration_changed' });
  f.candidate.set('package.json', String.raw`{"scripts":{},"\u0073cripts":{"start":"node bypass.mjs"}}`);
  await assert.rejects(verifyConsumerEntryCoverage(f.input), { code: 'duplicate_json_key' });
  const g = fixture(); g.input.candidateFiles.set('nested/Package.json', {mode:'100644'});
  await assert.rejects(verifyConsumerEntryCoverage(g.input), { code: 'consumer_entry_registry_set_changed' });
});
