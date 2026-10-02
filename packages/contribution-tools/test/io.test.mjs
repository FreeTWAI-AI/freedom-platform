import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactPath, uniquePaths, parseJson, readBounded, listArtifacts, readRemoteBounded } from '../io.mjs';
import { safeFailure } from '../errors.mjs';
import { assertSchema } from '../schema.mjs';
import { fixtureRoot, put } from './fixtures.mjs';

for (const path of ['', '/absolute', '../escape', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'C:/a', '//host/a',
  'a\n', 'a\0b', 'a b', 'CON', 'aux.json', 'a/LPT1.txt', 'a./b', 'a/%2e', 'f'.repeat(241), Array(18).fill('a').join('/')]) {
  test(`reject unsafe path ${JSON.stringify(path)}`, () => assert.throws(() => artifactPath(path), { code: 'invalid_artifact_path' }));
}
test('portable paths include valid hidden names and reject case/parent collisions', () => {
  assert.equal(artifactPath('.github/workflows/verify.yml'), '.github/workflows/verify.yml');
  assert.throws(() => uniquePaths(['a', 'a']), { code: 'duplicate_artifact_path' });
  assert.throws(() => uniquePaths(['SDK/a', 'sdk/b']), { code: 'case_collision' });
  assert.throws(() => uniquePaths(['a', 'a/b']), { code: 'artifact_parent_collision' });
});

test('strict JSON retains valid data without prototype effects', () => {
  const source = '{"unicode":"工坊😀","constructor":1,"__proto__":{"polluted":true},"v":[true,false,null,-1,1.25,1e2]}';
  assert.equal(JSON.stringify(parseJson(source)), JSON.stringify(JSON.parse(source)));
  assert.equal({}.polluted, undefined);
  assert.equal(parseJson(' 12\n'), 12);
});
for (const source of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"v":{"a":1,"a":2}}']) {
  test(`reject duplicate JSON ${source}`, () => assert.throws(() => parseJson(source), { code: 'duplicate_json_key' }));
}
for (const source of ['', '{', '[1,]', '{"a":1,}', '01', '+1', '1.', '1e', '1 2', 'true false', 'undefined',
  'NaN', 'Infinity', '"\\q"', '"line\nbreak"', '\ufeff{}']) {
  test(`reject malformed JSON ${JSON.stringify(source)}`, () => assert.throws(() => parseJson(source)));
}
test('JSON size, depth, node, numeric and Unicode limits', () => {
  assert.throws(() => parseJson('"1234"', { maxBytes: 3 }), { code: 'json_size_limit' });
  assert.throws(() => parseJson('[[[0]]]', { maxDepth: 2 }), { code: 'json_complexity_limit' });
  assert.throws(() => parseJson('[1,2]', { maxNodes: 2 }), { code: 'json_complexity_limit' });
  for (const source of ['1e400', '9007199254740993']) assert.throws(() => parseJson(source), { code: 'invalid_json_number' });
  for (const source of ['"\\ud800"', Buffer.from([0xc0, 0x80])]) assert.throws(() => parseJson(source), { code: 'invalid_json_encoding' });
});
test('schema subset rejects extra fields, unsupported rules, regex newline, and empty required arrays', () => {
  assert.throws(() => assertSchema('x\n', { type: 'string', pattern: '^x$' }), { code: 'schema_violation' });
  assert.throws(() => assertSchema({}, { type: 'object', required: ['id'] }), { code: 'schema_violation' });
  assert.throws(() => assertSchema({ id: 1 }, { type: 'object', properties: {}, additionalProperties: false }), { code: 'schema_violation' });
  assert.throws(() => assertSchema([], { type: 'array', minItems: 1 }), { code: 'schema_violation' });
  assert.throws(() => assertSchema({}, { $ref: 'https://untrusted.invalid/schema' }), { code: 'unsupported_schema_keyword' });
});
test('bounded reads reject oversized, symlinked, hardlinked and non-file inputs', async t => {
  const root = await fixtureRoot(t);
  await put(root, 'data/value', Buffer.from('abcd'));
  assert.equal((await readBounded(root, 'data/value', 4)).toString(), 'abcd');
  await assert.rejects(readBounded(root, 'data/value', 3), { code: 'artifact_size_limit' });
  await symlink(join(root, 'data/value'), join(root, 'linked'));
  await assert.rejects(readBounded(root, 'linked'), { code: 'artifact_symlink' });
  await symlink(join(root, 'data'), join(root, 'linked-parent'));
  await assert.rejects(readBounded(root, 'linked-parent/value'), { code: 'artifact_symlink' });
  await assert.rejects(readBounded(root, 'data'), { code: 'artifact_not_regular' });
  await link(join(root, 'data/value'), join(root, 'hard'));
  await assert.rejects(readBounded(root, 'hard'), { code: 'artifact_not_regular' });
  await assert.rejects(readBounded(root, 'missing'), { code: 'artifact_missing' });
});
test('tree walking rejects symlinks and case-conflicting directories', async t => {
  const root = await fixtureRoot(t);
  await put(root, 'a/file', 'x');
  assert.deepEqual(await listArtifacts(root), ['a/file']);
  await mkdir(join(root, 'A'));
  await assert.rejects(listArtifacts(root), { code: 'case_collision' });
  const other = await fixtureRoot(t);
  await symlink(root, join(other, 'external'));
  await assert.rejects(listArtifacts(other), { code: 'artifact_symlink' });
});
test('remote reader has a streaming size cap, fixed redirect policy, and redacted errors', async () => {
  const url = 'https://raw.githubusercontent.com/example/pinned/file';
  assert.equal((await readRemoteBounded(url, async (received, options) => {
    assert.equal(received, url); assert.equal(options.redirect, 'error'); assert(options.signal);
    return new Response('safe');
  })).toString(), 'safe');
  await assert.rejects(readRemoteBounded(url, async () => new Response(new Uint8Array(2_000_001))), { code: 'remote_size_limit' });
  await assert.rejects(readRemoteBounded(url, async () => { throw Error('fixture-secret-never-print'); }), { code: 'pinned_source_unavailable' });
  assert.deepEqual(safeFailure(Error('fixture-secret-never-print')), { status: 'failed', code: 'verification_failed' });
});
