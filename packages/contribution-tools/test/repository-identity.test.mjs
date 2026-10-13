import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repositoryTransport, matchesRecordedRepository, isPlatformSourceRepository} from '../repository-identity.mjs';
import {matchSupportedConsumerHostTuple} from '../consumer-host-tuples.mjs';
import {releaseFixture, legacyFixture, put, pretty} from './fixtures.mjs';
import {verifyContractPin} from '../contracts.mjs';

test('transport maps only transferred pinned repositories and preserves historical lock identities', () => {
  assert.equal(repositoryTransport('FreeTWAI-AI/FreeTWAI-AI.github.io'), 'FreeTWAI/FreeTWAI.github.io');
  for (const name of ['freedom-platform', '.github', 'freedom-agent-kit', 'freedom-storefront']) {
    assert.equal(repositoryTransport('FreeTWAI-AI/' + name), 'FreeTWAI/' + name);
    assert.equal(repositoryTransport('FreeTWAI/' + name), 'FreeTWAI/' + name);
    assert.equal(matchesRecordedRepository('FreeTWAI-AI/' + name, 'FreeTWAI/' + name), true);
    assert.equal(matchesRecordedRepository('FreeTWAI/' + name, 'FreeTWAI-AI/' + name), false);
  }
  for (const name of ['FreeTWAI-AI-Legacy/freedom-platform', 'fork/freedom-platform',
    'FreeTWAI/unknown', 'FreeTWAI-AI/freedom-platform/extra', 'freetwai/freedom-platform']) {
    assert.throws(() => repositoryTransport(name));
    assert.equal(isPlatformSourceRepository(name), false);
    assert.equal(matchesRecordedRepository(name, 'FreeTWAI/freedom-platform'), false);
  }
});

test('historical consumer provenance matches the same exact host-selected source/profile tuple', () => {
  const lock = {format: 'freedom.consumer-libraries/v1', source_repository: 'FreeTWAI-AI/freedom-platform',
    repository: 'FreeTWAI-AI/freedom-storefront', source_commit: '91b943ac61e132fbbce72ea066cb2301aa065600'};
  assert.equal(matchSupportedConsumerHostTuple('FreeTWAI/freedom-storefront', lock).source, lock.source_commit);
  for (const change of [{repository: 'fork/freedom-storefront'}, {source_repository: 'FreeTWAI-AI-Legacy/freedom-platform'},
    {source_commit: 'a'.repeat(40)}, {repository: 'FreeTWAI-AI/freedom-supplier-client'}]) {
    assert.throws(() => matchSupportedConsumerHostTuple('FreeTWAI/freedom-storefront', {...lock, ...change}));
  }
  assert.throws(() => matchSupportedConsumerHostTuple('FreeTWAI-AI/freedom-storefront', lock));
});

test('historical preview and signed ReleaseSet remain verifiable without relabeling signed bytes', async t => {
  const legacy = await legacyFixture(t);
  legacy.lock.source_repository = 'FreeTWAI-AI/freedom-platform';
  await put(legacy.root, 'contracts.lock.json', pretty(legacy.lock));
  assert.equal((await verifyContractPin({repositoryRoot: legacy.root})).status, 'passed');
  const fixture = await releaseFixture(t);
  fixture.manifest.source_repository = 'FreeTWAI-AI/freedom-platform';
  fixture.trustProfile.keys[0].source_repository = fixture.manifest.source_repository;
  await fixture.save();
  assert.equal((await verifyContractPin(fixture.options)).status, 'passed');
  fixture.trustProfile.keys[0].source_repository = 'FreeTWAI/freedom-platform';
  await assert.rejects(verifyContractPin(fixture.options), {code: 'publisher_not_approved'});
});
