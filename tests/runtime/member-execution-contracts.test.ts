import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
// @ts-expect-error Existing host-only clean environment helper is an ESM JavaScript module.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import {
  MemberExecutionVersionSchema, ModelSelectionSchema,
  CreateModelConnectionInputSchema, ReadModelConnectionInputSchema, RevokeModelConnectionInputSchema,
  ModelConnectionMetadataSchema, CreateExecutionGrantInputSchema, ReadExecutionGrantInputSchema,
  RevokeExecutionGrantInputSchema, ExecutionGrantMetadataSchema,
  CreateExecutionAttemptInputSchema, ReadExecutionAttemptInputSchema, ExecutionAttemptMetadataSchema,
} from '../../contracts/execution/v1/member-execution.js';

const id = '12345678-1234-4234-8234-123456789abc';
const time = '2026-10-02T12:00:00.000Z';
const selection = { providerRef: 'synthetic-provider', modelRef: 'synthetic-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'official_cli', engineLocation: 'runtime_local', billingSource: 'user_cli' };
const model = { modelConnectionId: id, connectionId: id, runtimeDeviceId: id, familyId: id, environment: 'local',
  clientId: 'synthetic-client', selection, state: 'unverified', aggregateVersion: '1', createdAt: time, operational_authority: false };
const grant = { grantId: id, runId: id, workId: id, inputWorkVersion: '1', runVersion: '1', taskLeaseEpoch: '1', controlEpoch: '1',
  connectionId: id, connectionVersion: '1', runtimeDeviceId: id, familyId: id, modelConnectionId: id, modelVersion: '1', selection,
  policyRevision: 'private-work.v1', state: 'active', aggregateVersion: '1', issuedAt: time,
  expiresAt: '2026-10-05T12:00:00.000Z', purpose: 'model.private-draft', operational_authority: false };
const attempt = { attemptId: id, attemptNumber: 1, grant, createdAt: time, state: 'preflight_blocked',
  blockers: ['model_authentication_unavailable', 'model_adapter_unavailable'], operational_authority: false };

test('member execution generated structural contracts match central schemas exactly', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'modules/agent-execution/generate-member-execution.ts', '--check'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: verificationEnvironment(),
    encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('all explicit custody/location/billing combinations reject incompatible bindings or missing selections', () => {
  const valid = [selection,
    { ...selection, credentialCustody: 'local_keychain', billingSource: 'user_byok' },
    { ...selection, credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' },
  ];
  for (const item of valid) {
    assert(ModelSelectionSchema.safeParse(item).success);
    for (const name of Object.keys(item)) {
      const incomplete = { ...item } as Record<string, unknown>; delete incomplete[name];
      assert(!ModelSelectionSchema.safeParse(incomplete).success, name);
    }
    for (const custody of ['official_cli', 'local_keychain', 'platform_vault']) {
      for (const engine of ['runtime_local', 'platform']) {
        for (const billing of ['user_cli', 'user_byok', 'platform_system', 'user_api', 'user_cli_subscription']) {
          const expected = custody === 'official_cli' ? engine === 'runtime_local' && billing === 'user_cli'
            : custody === 'local_keychain' ? engine === 'runtime_local' && billing === 'user_byok'
              : engine === 'platform' && billing === 'user_byok';
          assert.equal(ModelSelectionSchema.safeParse({ ...item, credentialCustody: custody,
            engineLocation: engine, billingSource: billing }).success, expected);
        }
      }
    }
  }
  for (const value of ['', 'a'.repeat(97), 'https://synthetic.test', 'x\n', 'x y']) {
    for (const name of ['providerRef', 'modelRef', 'processingLocation']) {
      assert(!ModelSelectionSchema.safeParse({ ...selection, [name]: value }).success, name);
    }
  }
});

test('signed64 canonical decimal version bounds survive JSON schema export', () => {
  const wire = z.toJSONSchema(MemberExecutionVersionSchema), pattern = new RegExp(wire.pattern!);
  const values = ['1', '9', '10', '999999999999999999', '1000000000000000000', '8999999999999999999',
    '9000000000000000000', '9223372036854775806', '9223372036854775807', '9223372036854775808',
    '9999999999999999999', '10000000000000000000', '0', '00', '01', '-1', '+1', '1.0', '1e1', '１', '1\n', '1\r', ' 1', '1 '];
  let sample = 123456789n;
  for (let index = 0; index < 1000; index++) {
    sample = (sample * 6364136223846793005n + 1442695040888963407n) % 10_000_000_000_000_000_000n;
    values.push(sample.toString());
  }
  for (const value of values) {
    const expected = /^[1-9][0-9]*$(?![\s\S])/.test(value) && BigInt(value) <= 9223372036854775807n;
    assert.equal(MemberExecutionVersionSchema.safeParse(value).success, expected, value);
    assert.equal(pattern.test(value) && value.length <= wire.maxLength!, expected, value);
  }
  assert(ExecutionGrantMetadataSchema.safeParse({ ...grant, policyRevision: 'private-work.v9223372036854775807' }).success);
  assert(!ExecutionGrantMetadataSchema.safeParse({ ...grant, policyRevision: 'private-work.v9223372036854775808' }).success);
});

test('closed commands reject caller asserted authority, secrets, scope expansion and missing consent', () => {
  const commands = [
    [CreateModelConnectionInputSchema, { key: 'synthetic_key', connectionId: id, expectedConnectionVersion: '1', selection }],
    [ReadModelConnectionInputSchema, { modelConnectionId: id }],
    [RevokeModelConnectionInputSchema, { key: 'synthetic_key', modelConnectionId: id, expectedVersion: '1' }],
    [CreateExecutionGrantInputSchema, { key: 'synthetic_key', runId: id, expectedRunVersion: '1', expectedWorkVersion: '1',
      connectionId: id, expectedConnectionVersion: '1', modelConnectionId: id, expectedModelVersion: '1', consent: true }],
    [ReadExecutionGrantInputSchema, { grantId: id }],
    [RevokeExecutionGrantInputSchema, { key: 'synthetic_key', grantId: id, expectedVersion: '1' }],
    [CreateExecutionAttemptInputSchema, { key: 'synthetic_key', runId: id, grantId: id, expectedRunVersion: '1', expectedGrantVersion: '1' }],
    [ReadExecutionAttemptInputSchema, { attemptId: id }],
  ] as const;
  for (const [schema, input] of commands) {
    assert(schema.safeParse(input).success);
    for (const name of ['modelReady', 'model_ready', 'authEvidence', 'secretRef', 'apiKey', 'privateKey', 'providerEndpoint',
      'ownerPrincipalId', 'scopeId', 'operation', 'scopes', 'leaseEpoch', 'recoveryGeneration', 'operational_authority']) {
      assert(!schema.safeParse({ ...input, [name]: 'synthetic' }).success, name);
    }
    const missingVersions = Object.fromEntries(Object.entries(input).filter(([name]) => !name.startsWith('expected')));
    assert(schema.safeParse(missingVersions).success, 'Missing versions must reach the server 428 check.');
    for (const name of Object.keys(input).filter(name => name.startsWith('expected'))) {
      assert(!schema.safeParse({ ...input, [name]: '9223372036854775808' }).success, name);
    }
  }
  const consentInput = commands[3][1];
  for (const consent of [false, null, undefined, 'true', 1]) {
    assert(!CreateExecutionGrantInputSchema.safeParse({ ...consentInput, consent }).success);
  }
  for (const name of ['modelReady', 'authEvidence', 'secretRef', 'localHandle', 'providerEndpoint', 'fallback']) {
    assert(!ModelSelectionSchema.safeParse({ ...selection, [name]: 'synthetic' }).success, name);
  }
});

test('metadata cannot represent model readiness, operational activation or an expanded Attempt', () => {
  const records = [[ModelConnectionMetadataSchema, model], [ExecutionGrantMetadataSchema, grant],
    [ExecutionAttemptMetadataSchema, attempt]] as const;
  for (const [schema, record] of records) {
    assert(schema.safeParse(record).success);
    assert(!schema.safeParse({ ...record, operational_authority: true }).success);
    for (const name of ['modelReady', 'authEvidence', 'privateKey', 'secretRef', 'ownerUserId', 'scopeId', 'lease', 'recoveryGeneration']) {
      assert(!schema.safeParse({ ...record, [name]: 'synthetic' }).success, name);
    }
    const timestamp = 'createdAt' in record ? 'createdAt' : 'issuedAt';
    for (const invalid of ['2026-10-02T12:00:00Z', '2026-10-02T12:00:00.0000Z', '2026-10-02T12:00:00.000+00:00', 'infinity']) {
      assert(!schema.safeParse({ ...record, [timestamp]: invalid }).success, invalid);
    }
  }
  for (const state of ['verified', 'ready', 'active']) assert(!ModelConnectionMetadataSchema.safeParse({ ...model, state }).success);
  assert(!ExecutionGrantMetadataSchema.safeParse({ ...grant, purpose: 'browser.execute' }).success);
  for (const state of ['ready', 'running', 'completed', 'cancelled']) assert(!ExecutionAttemptMetadataSchema.safeParse({ ...attempt, state }).success);
  for (const number of [0, 17, 1.5, '1']) assert(!ExecutionAttemptMetadataSchema.safeParse({ ...attempt, attemptNumber: number }).success);
  for (const blockers of [[], ['model_adapter_unavailable'], ['model_adapter_unavailable', 'model_authentication_unavailable'],
    [...attempt.blockers, 'extra']]) assert(!ExecutionAttemptMetadataSchema.safeParse({ ...attempt, blockers }).success);
  // An original consent snapshot survives revocation; its structural presence
  // is deliberately no claim about the current separately stored Grant.
  assert(ExecutionAttemptMetadataSchema.safeParse({ ...attempt, grant: { ...grant, state: 'revoked', aggregateVersion: '2' } }).success);
});
