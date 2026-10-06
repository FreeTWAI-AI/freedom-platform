// Owned PG18 recovery-set restore against a Miniflare authority Durable Object.
// Restoring an older snapshot must not revive a credential the external floor has passed.
// Local synthetic provider only. The authority Workers are not deployed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, link } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK } from 'jose';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { CredentialRecoveryFloorSchema } from '../../contracts/execution/v2/model-credential.js';
import { ModelBrokerResponsePayloadSchema, type ModelBrokerCommand, type ModelBrokerRequest } from '../../contracts/execution/v2/model-broker-bridge.js';
import type { ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { migrate } from '../../scripts/database.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { createModelBrokerAuthorizations } from '../../modules/agent-control/model-broker-authorizations.js';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createLocalFixtureModelStepHost, createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { Problem } from '../../packages/shared/problem.js';
import { assertObjectKey, validateRange, type ObjectMetadata, type ObjectStore } from '../../packages/asset-storage/index.js';
import { createAssetMaintenance } from '../../modules/assets/maintenance.js';
import { createConsistentAssetBackup } from '../../packages/media-migration/backup-coordinator.js';
import { createFileArchiveStore } from '../../packages/media-migration/backup-archive-fs.js';
import { RecoveryArchiveError, restoreRecoverySet, restoredReferenceAuthorization, type DumpSource, type RecoverySetIdentity } from '../../packages/media-migration/backup-archive.js';
import { lockdownRestoredMediaAcl } from '../../packages/media-migration/restore-acl-lockdown.js';
import { AUTHORITY_ORIGIN, AUTHORITY_PATHS, authorityObjectName, type AuthorityProfile } from '../../apps/private-ai-authority/src/profile.js';
import { bindPrivateAiJsonService, type PrivateAiServiceBinding } from '../../apps/platform-api/src/model-broker-service-binding.js';
import { createSignedRecoverySource, CredentialRecoveryError } from '../../apps/credential-broker/src/recovery.js';
import { createCredentialVault } from '../../apps/credential-broker/src/vault.js';
import { createBrokerCredentialStore, getCredentialWriteBinding } from '../../apps/credential-broker/src/store.js';
import { createBrokerModelExecution } from '../../apps/credential-broker/src/execution.js';
import { createBrokerBridge, type BrokerBridge } from '../../apps/credential-broker/src/bridge.js';
import type { Actor } from '../../modules/identity-membership/service.js';

const SECRET = 'SYNTHETIC_DRILL_PROVIDER_SECRET';
const G = '3';
const G1 = '4';
const AUTHORITY = 'drill-recovery-authority';
const KEY_ID = 'drill-recovery-key';
const CLIENT_ID = 'recovery-generation-drill';
const ISSUER = 'drill-member-issuer';
const REQUEST_AUDIENCE = 'drill-member-broker';
const BROKER_ID = 'drill-broker';
const RESPONSE_AUDIENCE = 'drill-member-main';
const REQUEST_KID = 'drill-member-1';
const RESPONSE_KID = 'drill-broker-1';
const IMAGE = 'postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd';
const TASK = 'recovery-generation-drill';
const selection: ModelSelection = { providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote', artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' };
const sqlOptions = { environment: 'local' as const, clientId: CLIENT_ID };
const self = fileURLToPath(import.meta.url);
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const stateSchema = z.object({ signedState: z.string().max(4096) }).strict();

function problemOf(error: unknown): { status?: number; code?: string; name: string; message: string } {
  const record = (error ?? {}) as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  const status = typeof record.status === 'number' ? record.status : undefined;
  const code = typeof record.code === 'string' ? record.code : error instanceof CredentialRecoveryError ? error.message : undefined;
  const name = typeof record.name === 'string' ? record.name : 'Error';
  const message = (typeof record.message === 'string' ? record.message : 'failed').replaceAll(SECRET, '[redacted]').replace(/postgresql:\/\/\S+/gi, '[redacted]').slice(0, 180);
  return { status, code, name, message };
}
function assertIdent(value: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('identifier_rejected');
}
function fileStore(directory: string): ObjectStore {
  const file = (key: Parameters<ObjectStore['head']>[0]) => { assertObjectKey(key); return join(directory, key.replaceAll('/', '_')); };
  const read = async (key: Parameters<ObjectStore['head']>[0]) => { try { return JSON.parse(await readFile(file(key), 'utf8')) as { metadata: ObjectMetadata; bytes: string }; } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; } };
  return { putImmutable: async (key, value) => { const pending = join(directory, 'pending-' + randomUUID()); await writeFile(pending, JSON.stringify({ metadata: value.metadata, bytes: Buffer.from(value.bytes).toString('base64') }), { flag: 'wx' }); try { await link(pending, file(key)); return 'created'; } catch (error) { if ((error as { code?: string }).code === 'EEXIST') return 'exists'; throw error; } finally { await rm(pending, { force: true }); } }, head: async key => { const value = await read(key); return value ? { metadata: value.metadata } : null; }, get: async (key, range) => { const value = await read(key); if (!value) return null; let bytes = new Uint8Array(Buffer.from(value.bytes, 'base64')); if (range) { validateRange(range, bytes.byteLength); bytes = bytes.slice(range.offset, range.offset + range.length); } return { metadata: value.metadata, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }; }, delete: async key => { if (!await read(key)) return 'missing'; await rm(file(key)); return 'deleted'; } };
}
async function applyTemplate(owner: Pool, schema: string, file: string, role: string, variable: string) {
  assertIdent(schema); assertIdent(role);
  const source = (await readFile(new URL('../../deploy/cloudflare/sql/' + file, import.meta.url), 'utf8')).replace(/^\\set .*$/mg, '').replaceAll('SCHEMA public', 'SCHEMA ' + schema).replaceAll("n.nspname='public'", "n.nspname='" + schema + "'").replaceAll("'public','CREATE'", "'" + schema + "','CREATE'").replaceAll(':"' + variable + '"', '"' + role + '"').replaceAll(":'" + variable + "'", "'" + role + "'");
  const q = await owner.connect();
  try {
    const pieces = source.split('\\gexec');
    for (let i = 0; i < pieces.length; i++) {
      const result = await q.query(pieces[i]);
      if (i < pieces.length - 1) { const last = Array.isArray(result) ? result[result.length - 1] : result; for (const row of last.rows) await q.query(Object.values(row)[0] as string); }
    }
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
}
function listen(server: Server): Promise<string> {
  return new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { reject(new Error('listen_failed')); return; } done(`http://127.0.0.1:${address.port}`); }); });
}
async function signRequest(payload: { authorizationRef: string; nonce: string }, privateKey: CryptoKey): Promise<ModelBrokerRequest> {
  const assertion = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'EdDSA', typ: 'freedom-model-broker-assertion+jws', kid: REQUEST_KID }).sign(privateKey);
  return { authorizationRef: payload.authorizationRef, nonce: payload.nonce, assertion };
}
async function readOutcome(response: string, publicKey: CryptoKey) {
  const verified = await compactVerify(response, publicKey);
  return ModelBrokerResponsePayloadSchema.parse(JSON.parse(new TextDecoder().decode(verified.payload))).outcome;
}
function stateProfile(generation: string): AuthorityProfile {
  return { purpose: 'recovery-state', environment: 'staging-next', authority: AUTHORITY, keyId: KEY_ID, generation };
}
function floorProfile(generation: string): AuthorityProfile {
  return { purpose: 'recovery-floor', environment: 'staging-next', authority: AUTHORITY, generation };
}
function authorityBinding(resolve: (pathname: string) => Promise<Response>): PrivateAiServiceBinding {
  return { async fetch(request: Request) {
    const response = await resolve(new URL(request.url).pathname);
    const headers = new Headers();
    const type = response.headers.get('content-type');
    if (type) headers.set('content-type', type);
    return new Response(new Uint8Array(await response.arrayBuffer()), { status: response.status, headers });
  } };
}
function recoverySource(stateBinding: PrivateAiServiceBinding, floorBinding: PrivateAiServiceBinding, recoveryKey: CryptoKey) {
  const readState = bindPrivateAiJsonService(stateBinding), readFloor = bindPrivateAiJsonService(floorBinding);
  return createSignedRecoverySource({ environment: 'staging-next', authority: AUTHORITY, pinnedKeys: [{ keyId: KEY_ID, key: recoveryKey }],
    readSignedState: async () => (await readState(AUTHORITY_ORIGIN + AUTHORITY_PATHS['recovery-state'], stateSchema)).signedState,
    readMonotonicFloor: () => readFloor(AUTHORITY_ORIGIN + AUTHORITY_PATHS['recovery-floor'], CredentialRecoveryFloorSchema) });
}
async function assembleBroker(input: { brokerPool: Pool; executorPool: Pool; recover: () => Promise<{ generation: string; expiresAt: string }>; vaultKey: CryptoKey; store: ObjectStore; origin: string; requestPublic: CryptoKey; responsePrivate: CryptoKey }) {
  const vault = createCredentialVault({ kek: { current: async () => ({ keyId: 'drill-kek', key: input.vaultKey }), readById: async id => id === 'drill-kek' ? input.vaultKey : null }, recover: input.recover });
  const store = createBrokerCredentialStore(input.brokerPool, { ...sqlOptions, vault, recover: input.recover });
  const authorizations = createModelBrokerAuthorizations(input.executorPool, { ...sqlOptions, issuer: ISSUER, audience: REQUEST_AUDIENCE, recover: input.recover });
  const execution = createBrokerModelExecution({ cipherPool: input.brokerPool, executorPool: input.executorPool, ...sqlOptions, vault, recover: input.recover, store: input.store, authorizations, fixtureOrigin: input.origin });
  const bridge = await createBrokerBridge({ ...sqlOptions, issuer: ISSUER, requestAudience: REQUEST_AUDIENCE, brokerId: BROKER_ID, responseAudience: RESPONSE_AUDIENCE, requestKeys: new Map([[REQUEST_KID, input.requestPublic]]), responseSigningKey: input.responsePrivate, responseKeyId: RESPONSE_KID, authorizations, execution });
  return { vault, store, authorizations, execution, bridge };
}
function providerBody(model: string) {
  return { id: 'synthetic-response', object: 'response', model, status: 'completed', output: [{ id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SYNTHETIC_DRILL_OUTPUT', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } };
}

interface ChildReply { id: number; ok: boolean; value?: unknown; error?: { status?: number; code?: string; name: string; message: string } }
interface Held { authorizationRef: string; nonce: string; assertion: string; payload: { authorizationRef: string; nonce: string } }

async function runChild() {
  let brokerPool: Pool | undefined, executorPool: Pool | undefined, appPool: Pool | undefined, bridge: BrokerBridge | undefined, store: ReturnType<typeof createBrokerCredentialStore> | undefined;
  let vault: ReturnType<typeof createCredentialVault> | undefined, authorizations: ReturnType<typeof createModelBrokerAuthorizations> | undefined, issuer: ReturnType<typeof createModelBrokerAuthorizations> | undefined, recover: (() => Promise<{ generation: string; expiresAt: string }>) | undefined;
  let config: { schema: string; appUrl: string; brokerUrl: string; executorUrl: string; proxyOrigin: string; recoveryPublicJwk: JsonWebKey; requestPrivateJwk: JsonWebKey; requestPublicJwk: JsonWebKey; responsePrivateJwk: JsonWebKey; kekBytes: string; actor: Actor; secret: string; directory: string } | undefined;
  const pools: Pool[] = [];
  async function build() {
    if (!config) throw new Error('child_uninitialized');
    const recoveryKey = await crypto.subtle.importKey('jwk', config.recoveryPublicJwk, { name: 'Ed25519' }, false, ['verify']);
    const requestPublic = await importJWK(config.requestPublicJwk, 'EdDSA') as CryptoKey;
    const responsePrivate = await importJWK(config.responsePrivateJwk, 'EdDSA') as CryptoKey;
    const raw = Buffer.from(config.kekBytes, 'base64');
    const vaultKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    raw.fill(0);
    const viaProxy = async (pathname: string) => {
      const worker = pathname === AUTHORITY_PATHS['recovery-state'] ? 'state' : pathname === AUTHORITY_PATHS['recovery-floor'] ? 'floor' : '';
      if (!worker || !config) throw new Error('binding_path');
      const response = await fetch(config.proxyOrigin + '/drill-authority/' + worker + pathname, { method: 'GET', headers: { Accept: 'application/json' } });
      const headers = new Headers();
      const type = response.headers.get('content-type');
      if (type) headers.set('content-type', type);
      return new Response(Buffer.from(await response.arrayBuffer()), { status: response.status, headers });
    };
    const source = recoverySource(authorityBinding(viaProxy), authorityBinding(viaProxy), recoveryKey);
    recover = source.recover;
    const assembled = await assembleBroker({ brokerPool: brokerPool!, executorPool: executorPool!, recover, vaultKey, store: fileStore(config.directory), origin: config.proxyOrigin, requestPublic, responsePrivate });
    vault = assembled.vault; store = assembled.store; authorizations = assembled.authorizations; bridge = assembled.bridge;
    issuer = createModelBrokerAuthorizations(appPool!, { ...sqlOptions, issuer: ISSUER, audience: REQUEST_AUDIENCE, recover });
  }
  const handle = async (message: { id: number; kind: string; value?: any }) => {
    let value: unknown = null;
    if (message.kind === 'init') {
      config = message.value;
      assertIdent(config!.schema);
      const pool = (url: string) => { const created = new Pool({ connectionString: url, options: `-c search_path=${config!.schema} -c statement_timeout=20000`, max: 8 }); pools.push(created); return created; };
      brokerPool = pool(config!.brokerUrl); executorPool = pool(config!.executorUrl); appPool = pool(config!.appUrl);
      await build();
    } else if (message.kind === 'recover') value = { generation: (await recover!()).generation };
    else if (message.kind === 'rebuild') { await build(); value = { ready: true }; }
    else if (message.kind === 'claim') { await authorizations!.claim(message.value.payload); value = { accepted: true }; }
    else if (message.kind === 'issue') { await issuer!.issue(config!.actor, message.value); value = { issued: true }; }
    else if (message.kind === 'bridge') value = await bridge!.handle(message.value);
    else if (message.kind === 'rotate') { await store!.prepareRotate(config!.actor, message.value); value = { prepared: true }; }
    else if (message.kind === 'resolve') { await store!.createResolver(config!.actor, message.value); value = { created: true }; }
    else if (message.kind === 'ingestExecute') {
      const requestKey = await importJWK(config!.requestPrivateJwk, 'EdDSA') as CryptoKey;
      const intent = await store!.prepareCreate(config!.actor, { key: randomUUID(), modelConnectionId: message.value.modelConnectionId, expectedModelVersion: '1', consent: true });
      const binding = getCredentialWriteBinding(intent);
      const bytes = new TextEncoder().encode(config!.secret);
      let committed;
      try { committed = await store!.commit(config!.actor, intent, await vault!.seal(binding, bytes)); }
      finally { bytes.fill(0); }
      const activate: ModelBrokerCommand = { operation: 'activate', input: { key: randomUUID(), approvalId: message.value.approvalId, expectedApprovalVersion: '1', expectedRunVersion: '1' } };
      const issuedActivate = await issuer!.issue(config!.actor, { operation: 'activate', command: activate, nonce: randomBytes(32).toString('base64url') });
      const activateEnvelope = await bridge!.handle(await signRequest(issuedActivate, requestKey));
      const responsePublic = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: (config!.responsePrivateJwk as { x: string }).x }, { name: 'Ed25519' }, false, ['verify']);
      const outcome = await readOutcome(activateEnvelope.response, responsePublic);
      if (outcome.kind !== 'metadata') throw new Problem(409, 'model_broker_authorization_invalid', 'Activate did not return metadata.');
      const execute: ModelBrokerCommand = { operation: 'execute', input: { key: randomUUID(), stepId: outcome.step.stepId, expectedVersion: '1' } };
      const issuedExecute = await issuer!.issue(config!.actor, { operation: 'execute', command: execute, nonce: randomBytes(32).toString('base64url') });
      value = { credentialId: committed.credentialId, recoveryGeneration: committed.recoveryGeneration, activate: activateEnvelope, execute: await bridge!.handle(await signRequest(issuedExecute, requestKey)) };
    } else if (message.kind === 'close') { await Promise.all(pools.map(pool => pool.end())); value = true; }
    else throw new Error('unknown_child_message');
    process.send!({ id: message.id, ok: true, value });
  };
  process.on('message', message => { void handle(message as { id: number; kind: string; value?: any }).catch(error => { const failed = error as { id?: number }; const id = (message as { id: number }).id; process.send!({ id, ok: false, error: problemOf(error) }); void failed; }); });
  process.on('disconnect', () => process.exit(0));
  await new Promise<void>(() => {});
}

if (process.env.FP_RECOVERY_DRILL_CHILD === '1') await runChild();
else test('restoring an older PostgreSQL snapshot cannot revive a credential past the external recovery generation', { timeout: 840000 }, async () => {
  const sourceUrl = process.env.TEST_DATABASE_URL, sourceContainer = process.env.TEST_POSTGRES_CONTAINER_ID;
  const restoreUrl = process.env.TEST_RESTORE_DATABASE_URL, restoreContainer = process.env.TEST_RESTORE_POSTGRES_CONTAINER_ID;
  assert(sourceUrl && restoreUrl && sourceContainer && restoreContainer, 'Explicit owned source and restore database URLs are required.');
  assert.match(sourceContainer, /^[0-9a-f]{64}$/); assert.match(restoreContainer, /^[0-9a-f]{64}$/);
  const source = new URL(sourceUrl), restored = new URL(restoreUrl);
  assert.match(source.pathname, /^\/fp_[a-z0-9_]+$/); assert.match(restored.pathname, /^\/fp_[a-z0-9_]+$/);
  assert.equal(source.username, 'postgres'); assert.equal(restored.username, 'postgres');
  const sourceDatabase = source.pathname.slice(1), restoredDatabase = restored.pathname.slice(1);
  const sourceSocket = source.searchParams.get('host') ?? '', restoreSocket = restored.searchParams.get('host') ?? '';
  for (const [id, socket] of [[sourceContainer, sourceSocket], [restoreContainer, restoreSocket]] as const) {
    const item = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }))[0];
    assert.equal(item.Id, id); assert.equal(item.HostConfig.NetworkMode, 'none');
    assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0);
    assert.equal(item.Config.Labels?.['freedom.task'], TASK); assert.equal(item.Config.Labels?.['freedom.owner'], TASK);
    assert.equal(item.Config.Image, IMAGE); assert.ok(item.HostConfig.Tmpfs?.['/var/lib/postgresql']);
    assert.ok(item.Mounts?.some((mount: { Type?: string; Source?: string; Destination?: string }) => mount.Type === 'bind' && mount.Source === socket && mount.Destination === '/pgsocket'));
  }
  const sourceRelease = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', timeout: 30000 }).trim();
  assert.match(sourceRelease, /^[0-9a-f]{40}$/);
  const schema = `fp_rg_${process.pid}_${Date.now()}`;
  assertIdent(schema);
  const roles = { owner: `${schema}_owner`, app: `${schema}_app`, broker: `${schema}_broker`, exec: `${schema}_exec` };
  for (const role of Object.values(roles)) assertIdent(role);
  const receipt: Record<string, unknown> = { ok: false, phase: 'start', sourceRelease, generation: G, nextGeneration: G1, posts: 0, objectStoreCalls: 0, evidence: 'unavailable', ownerOperations: ['store.read', 'model-step.stop', 'store.revoke'], marks: {} };
  const started = Date.now();
  const mark = (name: string) => { (receipt.marks as Record<string, number>)[name] = Date.now() - started; };
  // workerd refuses a script or persistence path whose relative form contains "..".
  await mkdir(join(repo, '.wrangler'), { recursive: true });
  const directory = await mkdtemp(join(repo, '.wrangler', 'recovery-generation-drill-'));
  const archiveDir = join(directory, 'archive'), dumpDir = join(directory, 'dump'), objectDir = join(directory, 'objects'), backupObjectDir = join(directory, 'backup-objects'), restoredObjectDir = join(directory, 'restored-objects'), persistDir = join(directory, 'persist');
  await Promise.all([mkdir(archiveDir), mkdir(dumpDir), mkdir(objectDir), mkdir(backupObjectDir), mkdir(restoredObjectDir), mkdir(persistDir)]);
  const liveObjects = fileStore(objectDir), backupObjects = fileStore(backupObjectDir), restoredObjects = fileStore(restoredObjectDir);
  const roleUrl = (base: string, role: string) => { const url = new URL(base); url.username = role; url.password = ''; return url.toString(); };
  const poolFor = (base: string, role: string, max: number) => new Pool({ connectionString: roleUrl(base, role), options: `-c search_path=${schema} -c statement_timeout=20000`, max });
  const sourceAdmin = new Pool({ connectionString: sourceUrl, max: 4 });
  const restoreAdmin = new Pool({ connectionString: restoreUrl, max: 4 });
  const restoreGrants = new Pool({ connectionString: restoreUrl, options: `-c search_path=${schema} -c statement_timeout=30000`, max: 2 });
  const owner = poolFor(sourceUrl, roles.owner, 4);
  const app = poolFor(sourceUrl, roles.app, 8);
  const broker = poolFor(sourceUrl, roles.broker, 4);
  const executor = poolFor(sourceUrl, roles.exec, 8);
  const backup = new Pool({ connectionString: sourceUrl, options: `-c search_path=${schema} -c statement_timeout=30000`, max: 4 });
  const pools = [sourceAdmin, restoreAdmin, restoreGrants, owner, app, broker, executor, backup];
  let destApp: Pool | undefined, destBroker: Pool | undefined, destExecutor: Pool | undefined;
  let mf: Miniflare | undefined, server: Server | undefined, child: ChildProcess | undefined, posts = 0, objectStoreCalls = 0, outboundCalls = 0;
  let sourceSchema = false, sourceRoles = false, destRoles = false;
  const pgChildren = new Set<ChildProcess>();
  const stopPg = (proc: ChildProcess) => { try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { /* already exited */ } };
  const exported = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; d: string };
  const signingJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: exported.x, d: exported.d };
  const recoveryPublic = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: signingJwk.x }, { name: 'Ed25519' }, false, ['verify']);
  const requestPair = await generateKeyPair('EdDSA', { extractable: true }), responsePair = await generateKeyPair('EdDSA', { extractable: true });
  const extractableKek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const kekRaw = new Uint8Array(await crypto.subtle.exportKey('raw', extractableKek));
  const kek = await crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const kekBytes = Buffer.from(kekRaw).toString('base64');
  kekRaw.fill(0);
  const holders: { mf?: Miniflare } = {};
  const direct = async (pathname: string) => {
    const worker = pathname === AUTHORITY_PATHS['recovery-state'] ? 'state' : pathname === AUTHORITY_PATHS['recovery-floor'] ? 'floor' : '';
    if (!worker || !holders.mf) return new Response(JSON.stringify({ code: 'private_ai_authority_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    return (await holders.mf.getWorker(worker)).fetch(AUTHORITY_ORIGIN + pathname, { method: 'GET' }) as unknown as Response;
  };
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let serial = 0, childLogs = '';
  const ask = (kind: string, value?: unknown, timeoutMs = 20000) => new Promise<any>((resolveReply, rejectReply) => {
    const id = ++serial; const timer = setTimeout(() => { pending.delete(id); rejectReply(new Error('child_timeout_' + kind)); }, timeoutMs);
    pending.set(id, { resolve: valueOut => { clearTimeout(timer); resolveReply(valueOut); }, reject: error => { clearTimeout(timer); rejectReply(error); } });
    child!.send({ id, kind, value });
  });
  async function boot(generation: string, expect: 200 | 503) {
    await mf?.dispose();
    const worker = (name: 'state' | 'floor') => {
      const profile = name === 'state' ? stateProfile(generation) : floorProfile(generation);
      const bindings: Record<string, string> = { FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED: 'true', FREEDOM_AUTHORITY_PURPOSE: profile.purpose, FREEDOM_AUTHORITY_ENVIRONMENT: profile.environment, FREEDOM_AUTHORITY_PROFILE: JSON.stringify(profile) };
      if (name === 'state') bindings.FREEDOM_AUTHORITY_SIGNING_KEY = JSON.stringify(signingJwk);
      return { name, modules: true, scriptPath: join(directory, 'authority.mjs'), compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'], bindings,
        durableObjects: { AUTHORITY_GENERATION: { className: 'AuthorityGeneration', useSQLite: true } }, outboundService() { outboundCalls += 1; return new Response(null, { status: 503 }); } };
    };
    mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: persistDir, workers: [worker('state'), worker('floor')] }));
    holders.mf = mf; await mf.ready;
    for (const name of ['state', 'floor'] as const) {
      const response = await direct(AUTHORITY_PATHS[name === 'state' ? 'recovery-state' : 'recovery-floor']);
      const body = await response.json() as { code?: string; generation?: string; signedState?: string };
      assert.equal(response.status, expect, name + ' boot');
      if (expect === 503) assert.equal(body.code, 'private_ai_authority_unavailable');
      if (expect === 200 && name === 'floor') assert.equal(body.generation, generation);
    }
  }
  async function pgDump(containerId: string, args: string[], file: string): Promise<{ sha256: string; byteSize: number }> {
    assert.match(containerId, /^[0-9a-f]{64}$/);
    const proc = spawn('docker', ['exec', containerId, 'pg_dump', '-U', 'postgres', '-h', '/pgsocket', ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    pgChildren.add(proc); const stderr: Buffer[] = []; proc.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); if (stderr.length > 20) stderr.shift(); });
    const hash = createHash('sha256'); const out = createWriteStream(file); let size = 0, failed = false;
    const stop = () => { failed = true; stopPg(proc); };
    const timer = setTimeout(stop, 100000);
    proc.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 256 * 1024 * 1024) { stop(); return; } hash.update(chunk); if (!out.write(chunk)) proc.stdout.pause(); });
    out.on('drain', () => proc.stdout.resume());
    try {
      const code: number | null = await new Promise(done => { proc.once('error', () => done(1)); proc.once('close', done); });
      out.end(); await once(out, 'finish');
      if (code !== 0 || failed) { receipt.dumpError = Buffer.concat(stderr).toString('utf8').replaceAll(SECRET, '[redacted]').replace(/postgresql:\/\/\S+/gi, '[redacted]').slice(-300); throw new Error('owned_pg_dump_failed'); }
      return { sha256: hash.digest('hex'), byteSize: size };
    } finally { clearTimeout(timer); pgChildren.delete(proc); }
  }
  async function pgRestore(containerId: string, database: string, archive: ReadableStream<Uint8Array>) {
    assert.match(containerId, /^[0-9a-f]{64}$/); assertIdent(database);
    const proc = spawn('docker', ['exec', '-i', containerId, 'pg_restore', '-U', 'postgres', '-h', '/pgsocket', '--dbname', database, '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges'], { stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    pgChildren.add(proc); const stderr: Buffer[] = []; proc.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); if (stderr.length > 20) stderr.shift(); }); proc.stdin.on('error', () => {});
    let failed = false; const stop = () => { failed = true; stopPg(proc); }; const timer = setTimeout(stop, 120000);
    const input = Readable.fromWeb(archive as unknown as import('node:stream/web').ReadableStream<Uint8Array>); input.on('error', stop); input.pipe(proc.stdin);
    try {
      const code: number | null = await new Promise(done => { proc.once('error', () => done(1)); proc.once('close', done); });
      if (code !== 0 || failed) throw new Error('owned_pg_restore_failed ' + Buffer.concat(stderr).toString('utf8').replaceAll(SECRET, '[redacted]').slice(-180));
    } finally { clearTimeout(timer); pgChildren.delete(proc); }
  }
  let failure: unknown;
  try {
    receipt.phase = 'migrate';
    await sourceAdmin.query(`CREATE ROLE ${roles.owner} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE ${roles.app} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE ${roles.broker} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE ${roles.exec} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE SCHEMA ${schema} AUTHORIZATION ${roles.owner}; GRANT USAGE ON SCHEMA ${schema} TO ${roles.app},${roles.broker},${roles.exec}`);
    sourceRoles = true; sourceSchema = true;
    await restoreAdmin.query(`CREATE ROLE ${roles.app} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE ${roles.broker} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE ${roles.exec} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    destRoles = true;
    const bundle = join(directory, 'authority.mjs');
    await Promise.all([
      migrate(owner),
      build({ entryPoints: [resolve(repo, 'apps/private-ai-authority/src/worker.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] }),
    ]);
    await Promise.all([
      applyTemplate(owner, schema, '20-runtime-grants.psql', roles.app, 'runtime'),
      boot(G, 200),
    ]);
    await applyTemplate(owner, schema, '40-credential-broker-grants.psql', roles.broker, 'broker');
    await applyTemplate(owner, schema, '45-model-broker-execution-grants.psql', roles.exec, 'executor');
    await owner.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-backup',orphan_retention_seconds=1,retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=120,pin_seconds=600,max_capture_objects=10`);
    receipt.phase = 'member';
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname.startsWith('/drill-authority/')) {
          const parts = url.pathname.split('/'), worker = parts[2], path = '/' + parts.slice(3).join('/');
          if ((worker !== 'state' && worker !== 'floor') || (path !== AUTHORITY_PATHS['recovery-state'] && path !== AUTHORITY_PATHS['recovery-floor'])) { res.writeHead(404); res.end(); return; }
          const response = await direct(path); const body = Buffer.from(await response.arrayBuffer());
          const headers: Record<string, string> = {}; const type = response.headers.get('content-type'); if (type) headers['content-type'] = type;
          res.writeHead(response.status, headers); res.end(body); return;
        }
        if (req.headers.authorization !== 'Bearer ' + SECRET) { res.writeHead(401); res.end('{}'); return; }
        if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'synthetic-model', object: 'model', created: 0, owned_by: 'synthetic-fixture' })); return; }
        if (req.method === 'POST' && url.pathname === '/v1/responses') {
          posts += 1; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); void Buffer.concat(chunks);
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(providerBody('synthetic-model'))); return;
        }
        res.writeHead(404); res.end('{}');
      } catch { res.destroy(); }
    });
    const origin = await listen(server);
    const recovery = recoverySource(authorityBinding(direct), authorityBinding(direct), recoveryPublic);
    assert.equal((await recovery.recover()).generation, G);
    const assembled = await assembleBroker({ brokerPool: broker, executorPool: executor, recover: recovery.recover, vaultKey: kek, store: liveObjects, origin, requestPublic: requestPair.publicKey, responsePrivate: responsePair.privateKey });
    const issuer = createModelBrokerAuthorizations(app, { ...sqlOptions, issuer: ISSUER, audience: REQUEST_AUDIENCE, recover: recovery.recover });
    const user = randomUUID(), community = randomUUID(), session = randomUUID(), email = user + '@example.invalid', membership = randomUUID();
    await owner.query("INSERT INTO communities VALUES($1,'Synthetic recovery community')", [community]);
    await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic recovery owner','not-a-login',$4)`, [user, community, email, membership]);
    await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
    const actor: Actor = { user_id: user, community_id: community, email, display_name: 'Synthetic recovery owner', profession_membership_ref: membership, session_hash: session, csrf_token: 'synthetic' };
    const works = createPrivateWorkCommands(app, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
    const runs = createExecutionRuns(app), prerequisites = createExecutionPrerequisites(app, sqlOptions);
    const enrollment = createRuntimeRegistrations(app, { environment: 'local' }), connections = createAgentConnections(app, sqlOptions);
    const pair = await generateKeyPair('ES256', { extractable: true });
    const challenge = await enrollment.begin(actor, { key: randomUUID(), publicJwk: parseRuntimePublicJwk(await exportJWK(pair.publicKey)) });
    const proof = await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(pair.privateKey);
    const device = await enrollment.confirm(actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
    const connection = await connections.create(actor, { key: randomUUID(), runtimeDeviceId: device.runtimeDeviceId });
    await transaction(app, (q: PoolClient) => insertInitialRefreshFamily(q, connection.connectionId, new Date(connection.issuedAt), new Date(connection.expiresAt)));
    const modelA = await prerequisites.models.create(actor, { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection });
    const modelB = await prerequisites.models.create(actor, { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection });
    const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, value) => value);
    await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit) VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id, context.subject_principal.principal_id]);
    await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,'local',$4,$5,1,true,16384,32)`, [randomUUID(), context.scope.scope_id, context.subject_principal.principal_id, CLIENT_ID, JSON.stringify(selection)]);
    const approvalSteps = createModelStepService(app, { ...sqlOptions, host: createUnavailableModelStepHost() });
    async function stage(targetApp: Pool, modelId: string) {
      const localWorks = targetApp === app ? works : createPrivateWorkCommands(targetApp, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
      const localRuns = targetApp === app ? runs : createExecutionRuns(targetApp);
      const localPrerequisites = targetApp === app ? prerequisites : createExecutionPrerequisites(targetApp, sqlOptions);
      const localApprovals = targetApp === app ? approvalSteps : createModelStepService(targetApp, { ...sqlOptions, host: createUnavailableModelStepHost() });
      const work = await localWorks.create(actor, { key: randomUUID(), title: 'Synthetic recovery work', objective: 'SYNTHETIC_RECOVERY_OBJECTIVE' });
      const run = await localRuns.create(actor, { key: randomUUID(), workId: work.workId, expectedWorkVersion: '1' });
      const grant = await localPrerequisites.grants.create(actor, { key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: '1', connectionId: connection.connectionId, expectedConnectionVersion: '1', modelConnectionId: modelId, expectedModelVersion: '1', consent: true });
      const approval = await localApprovals.approvals.create(actor, { key: randomUUID(), runId: run.runId, grantId: grant.grantId, expectedRunVersion: '1', expectedGrantVersion: '1', expectedWorkVersion: '1', consent: true, maxOutputTokens: 32 });
      return { work, run, grant, approval };
    }
    const success = await stage(app, modelA.modelConnectionId), reserved = await stage(app, modelA.modelConnectionId), dispatched = await stage(app, modelA.modelConnectionId);
    mark('ready'); receipt.phase = 'ingest';
    const intent = await assembled.store.prepareCreate(actor, { key: randomUUID(), modelConnectionId: modelA.modelConnectionId, expectedModelVersion: '1', consent: true });
    const binding = getCredentialWriteBinding(intent);
    const secretBytes = new TextEncoder().encode(SECRET);
    let credential: Awaited<ReturnType<typeof assembled.store.commit>>;
    try { credential = await assembled.store.commit(actor, intent, await assembled.vault.seal(binding, secretBytes)); }
    finally { secretBytes.fill(0); }
    assert.equal(credential.recoveryGeneration, G); assert.equal(credential.state, 'active'); assert.equal(credential.generation, '1');
    const resolver = await assembled.store.createResolver(actor, { credentialId: credential.credentialId, expectedGeneration: '1' });
    const liveHost = createLocalFixtureModelStepHost({ environment: 'local', origin, recover: recovery.recover, resolveCredential: resolver });
    const liveSteps = createModelStepService(app, { ...sqlOptions, host: liveHost });
    receipt.phase = 'use';
    const activateCommand: ModelBrokerCommand = { operation: 'activate', input: { key: randomUUID(), approvalId: success.approval.approvalId, expectedApprovalVersion: '1', expectedRunVersion: '1' } };
    const issuedActivate = await issuer.issue(actor, { operation: 'activate', command: activateCommand, nonce: randomBytes(32).toString('base64url') });
    const activateOutcome = await readOutcome((await assembled.bridge.handle(await signRequest(issuedActivate, requestPair.privateKey))).response, responsePair.publicKey);
    assert.equal(activateOutcome.kind, 'metadata'); if (activateOutcome.kind !== 'metadata') throw new Error('activate');
    const executeCommand: ModelBrokerCommand = { operation: 'execute', input: { key: randomUUID(), stepId: activateOutcome.step.stepId, expectedVersion: '1' } };
    const issuedExecute = await issuer.issue(actor, { operation: 'execute', command: executeCommand, nonce: randomBytes(32).toString('base64url') });
    const executeOutcome = await readOutcome((await assembled.bridge.handle(await signRequest(issuedExecute, requestPair.privateKey))).response, responsePair.publicKey);
    assert.equal(executeOutcome.kind, 'metadata'); if (executeOutcome.kind !== 'metadata') throw new Error('execute');
    assert.equal(executeOutcome.step.state, 'succeeded'); assert.equal(executeOutcome.step.evidenceOrigin, 'synthetic_local_fixture'); assert.equal(executeOutcome.step.operational_authority, false);
    assert.equal(posts, 1);
    receipt.phase = 'dispatch';
    const activeDispatched = await liveSteps.activate(actor, { key: randomUUID(), approvalId: dispatched.approval.approvalId, expectedApprovalVersion: '1', expectedRunVersion: '1' });
    const begun = await liveSteps.begin(actor, { key: randomUUID(), stepId: activeDispatched.stepId, expectedVersion: '1' });
    assert.equal(begun.metadata.state, 'dispatched'); assert.equal(begun.metadata.aggregateVersion, '2'); assert.equal(posts, 1);
    const activeReserved = await liveSteps.activate(actor, { key: randomUUID(), approvalId: reserved.approval.approvalId, expectedApprovalVersion: '1', expectedRunVersion: '1' });
    const heldNonce = randomBytes(32).toString('base64url');
    const heldCommand: ModelBrokerCommand = { operation: 'execute', input: { key: randomUUID(), stepId: activeReserved.stepId, expectedVersion: '1' } };
    const heldPayload = await issuer.issue(actor, { operation: 'execute', command: heldCommand, nonce: heldNonce });
    const heldRequest = await signRequest(heldPayload, requestPair.privateKey);
    const held: Held = { ...heldRequest, payload: heldPayload };
    assert.equal(posts, 1);
    mark('issued'); receipt.phase = 'snapshot';
    const dumpFile = join(dumpDir, 'source.dump');
    const throwingStore: ObjectStore = { async putImmutable() { objectStoreCalls += 1; throw new Error('object_store_unused'); }, async head() { objectStoreCalls += 1; throw new Error('object_store_unused'); }, async get() { objectStoreCalls += 1; throw new Error('object_store_unused'); }, async delete() { objectStoreCalls += 1; throw new Error('object_store_unused'); } };
    const maintenance = createAssetMaintenance(backup, { store: throwingStore, enabled: true });
    const consistent = await createConsistentAssetBackup(backup, { enabled: true, target: { database: sourceDatabase, sourceSchema: schema, sourceRelease }, maintenance, source: liveObjects, destination: backupObjects, snapshotEvidence: false, databaseSnapshot: { async write(input) {
      assert.match(input.snapshotId, /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/);
      mark('dump');
      const dumped = await pgDump(sourceContainer, ['--dbname', input.database, '--schema', input.schema, '--snapshot', input.snapshotId, '--format=custom', '--no-owner', '--no-privileges'], dumpFile);
      receipt.dumpBytes = dumped.byteSize; mark('dump-done');
      return dumped;
    } } });
    const archive = await createFileArchiveStore(archiveDir);
    const setId = randomUUID();
    const sealed = await sealFrom(consistent, archive, dumpFile, backupObjects, setId);
    assert.equal(sealed.setId, setId); assert.equal(sealed.environment, 'local'); assert.equal(sealed.database, sourceDatabase);
    assert.equal(sealed.schema, schema); assert.equal(sealed.sourceRelease, sourceRelease);
    assert.equal(sealed.evidence.status, 'unavailable'); assert.equal(sealed.objects.count, 1); assert.equal(objectStoreCalls, 0); receipt.objectCount = sealed.objects.count;
    const expectations: RecoverySetIdentity = { setId, manifestSha256: sealed.manifestSha256, environment: 'local', database: sourceDatabase, schema, sourceRelease };
    await writeFile(join(directory, 'expectations.json'), JSON.stringify(expectations) + '\n', { mode: 0o600 });
    receipt.phase = 'rotate-source';
    const rotateIntent = await assembled.store.prepareRotate(actor, { key: randomUUID(), credentialId: credential.credentialId, expectedVersion: '1', replacementModelConnectionId: modelB.modelConnectionId, expectedReplacementModelVersion: '1', consent: true });
    const rotateBytes = new TextEncoder().encode(SECRET);
    try { await assembled.store.commit(actor, rotateIntent, await assembled.vault.seal(getCredentialWriteBinding(rotateIntent), rotateBytes)); }
    finally { rotateBytes.fill(0); }
    await assert.rejects(assembled.store.createResolver(actor, { credentialId: credential.credentialId, expectedGeneration: '1' }), (error: unknown) => { const problem = problemOf(error); return problem.status === 409 && problem.code === 'broker_credential_unavailable'; });
    const rotated = (await owner.query(`SELECT c.state credential_state,m.state model_state FROM broker_model_credentials c JOIN model_connections m ON m.model_connection_id=c.model_connection_id WHERE c.credential_id=$1`, [credential.credentialId])).rows[0];
    assert.equal(rotated.credential_state, 'rotated'); assert.equal(rotated.model_state, 'revoked');
    receipt.codes = { ...(receipt.codes as object), sourceRotate: '409 broker_credential_unavailable' };
    mark('sealed'); receipt.phase = 'identity';
    const expected = JSON.parse(await readFile(join(directory, 'expectations.json'), 'utf8')) as RecoverySetIdentity;
    assert.equal(expected.setId, setId); assert.equal(expected.manifestSha256, sealed.manifestSha256);
    assert.equal(expected.environment, 'local'); assert.equal(expected.database, sourceDatabase); assert.notEqual(expected.database, restoredDatabase);
    assert.equal(expected.schema, schema); assert.equal(expected.sourceRelease, sourceRelease);
    const flipped = expected.manifestSha256.slice(0, -1) + (expected.manifestSha256.endsWith('0') ? '1' : '0');
    let refusedWrites = 0;
    await assert.rejects(restoreRecoverySet({ archive, setId: expected.setId, expected: { ...expected, manifestSha256: flipped }, backupObjects: throwingStore, destinationObjects: throwingStore, restoredPool: restoreAdmin, restoredDatabase, allowUnavailableEvidence: true,
      database: { async restore() { refusedWrites += 1; throw new Error('restore_writer_called'); } },
      objectAuthority: restoredReferenceAuthorization(restoreAdmin, { database: restoredDatabase, schema, current: { mode: 'quarantine' } }) }),
    (error: unknown) => error instanceof RecoveryArchiveError && error.code === 'recovery_identity_mismatch');
    assert.equal(refusedWrites, 0); assert.equal(objectStoreCalls, 0);
    assert.equal((await restoreAdmin.query('SELECT count(*)::int n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1', [schema])).rows[0].n, 0);
    receipt.phase = 'restore';
    const [restoredSet] = await Promise.all([
      restoreRecoverySet({ archive, setId: expected.setId, expected, backupObjects, destinationObjects: restoredObjects, restoredPool: restoreAdmin, restoredDatabase, allowUnavailableEvidence: true,
        database: { restore: input => pgRestore(restoreContainer, input.database, input.archive) },
        objectAuthority: restoredReferenceAuthorization(restoreAdmin, { database: restoredDatabase, schema, current: { mode: 'quarantine' } }) }),
      boot(G1, 200),
    ]);
    assert.equal(restoredSet.status, 'database_and_objects_restored'); assert.equal(restoredSet.evidence.status, 'unavailable');
    assert.equal(restoredSet.exposure, 'quarantine_not_approved_for_exposure');
    assert.ok(restoredSet.remainingOperatorSteps.includes('fence_restored_sessions_and_external_authority'));
    assert.equal(objectStoreCalls, 0);
    const restoredRow = (await restoreAdmin.query(`SELECT state,recovery_generation::text generation,count(*) OVER() n FROM "${schema}".broker_model_credentials`)).rows;
    assert.equal(restoredRow.length, 1); assert.equal(restoredRow[0].state, 'active'); assert.equal(restoredRow[0].generation, G);
    receipt.phase = 'lockdown';
    await restoreAdmin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${roles.app},${roles.broker},${roles.exec}`);
    await assert.rejects(applyTemplate(restoreGrants, schema, '20-runtime-grants.psql', roles.app, 'runtime'), (error: unknown) => { const pg = error as { code?: string; message?: string }; return pg.code === 'P0001' && pg.message === 'Unsafe runtime operator media privileges'; });
    await lockdownRestoredMediaAcl(restoreAdmin, { target: { environment: 'local', database: restoredDatabase, schema, role: 'postgres', releaseSha: sourceRelease }, runtimeRole: roles.app });
    await applyTemplate(restoreGrants, schema, '20-runtime-grants.psql', roles.app, 'runtime');
    await applyTemplate(restoreGrants, schema, '40-credential-broker-grants.psql', roles.broker, 'broker');
    await applyTemplate(restoreGrants, schema, '45-model-broker-execution-grants.psql', roles.exec, 'executor');
    destApp = poolFor(restoreUrl, roles.app, 8); destBroker = poolFor(restoreUrl, roles.broker, 4); destExecutor = poolFor(restoreUrl, roles.exec, 8);
    pools.push(destApp, destBroker, destExecutor);
    assert.equal((await recovery.recover()).generation, G1);
    mark('restored'); receipt.phase = 'fresh-broker';
    const live = (await restoreAdmin.query(`SELECT c.state credential_state,c.recovery_generation::text credential_generation,c.expires_at>clock_timestamp() credential_live,
      a.expires_at>clock_timestamp() auth_live,a.accepted_at IS NULL unclaimed,a.recovery_generation::text auth_generation,
      s.state step_state,s.lease_expires_at>clock_timestamp() lease_live,s.aggregate_version::text step_version,r.state run_state,s.reservation_held,
      EXTRACT(EPOCH FROM (c.expires_at-clock_timestamp()))::int credential_seconds,EXTRACT(EPOCH FROM (a.expires_at-clock_timestamp()))::int auth_seconds,
      EXTRACT(EPOCH FROM (s.lease_expires_at-clock_timestamp()))::int lease_seconds
      FROM "${schema}".broker_model_credentials c, "${schema}".model_broker_authorizations a, "${schema}".model_text_steps s
      JOIN "${schema}".execution_runs r ON r.run_id=s.run_id
      WHERE c.credential_id=$1 AND a.authorization_id=$2 AND s.step_id=$3`, [credential.credentialId, held.authorizationRef, begun.metadata.stepId])).rows[0];
    if (!live?.credential_live || !live.auth_live || !live.lease_live || live.credential_state !== 'active' || live.credential_generation !== G || live.unclaimed !== true || live.step_state !== 'dispatched' || live.step_version !== '2' || live.reservation_held !== true) {
      assert.fail('liveness window closed before generation proof ' + JSON.stringify({ credential_state: live?.credential_state, credential_generation: live?.credential_generation, credential_live: live?.credential_live, auth_live: live?.auth_live, lease_live: live?.lease_live, unclaimed: live?.unclaimed, step_state: live?.step_state, step_version: live?.step_version, credential_seconds: live?.credential_seconds, auth_seconds: live?.auth_seconds, lease_seconds: live?.lease_seconds }));
    }
    child = fork(self, [], { execArgv: ['--import', 'tsx'], cwd: repo, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', FP_RECOVERY_DRILL_CHILD: '1' } });
    child.stdout!.on('data', chunk => { childLogs = (childLogs + String(chunk)).slice(-4000); }); child.stderr!.on('data', chunk => { childLogs = (childLogs + String(chunk)).slice(-4000); });
    child.on('message', (message: ChildReply) => { const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.ok) waiter.resolve(message.value); else waiter.reject(Object.assign(new Error(message.error?.message ?? 'child_failed'), message.error)); });
    child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('child_exited')); pending.clear(); });
    await ask('init', { schema, appUrl: roleUrl(restoreUrl, roles.app), brokerUrl: roleUrl(restoreUrl, roles.broker), executorUrl: roleUrl(restoreUrl, roles.exec), proxyOrigin: origin, recoveryPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: signingJwk.x }, requestPrivateJwk: await exportJWK(requestPair.privateKey), requestPublicJwk: await exportJWK(requestPair.publicKey), responsePrivateJwk: await exportJWK(responsePair.privateKey), kekBytes, actor, secret: SECRET, directory: objectDir }, 60000);
    const fresh = await ask('recover');
    assert.equal(fresh.generation, G1);
    const beforeAuth = (await restoreAdmin.query(`SELECT count(*)::int n FROM "${schema}".model_broker_authorizations`)).rows[0].n;
    const claimError = await ask('claim', { payload: held.payload }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, ...problemOf(error) }));
    assert.equal(claimError.ok, false); if (claimError.ok) throw new Error('claim');
    assert.equal(claimError.status, 403); assert.equal(claimError.code, 'model_broker_authorization_invalid');
    const issueError = await ask('issue', { operation: 'execute', command: { operation: 'execute', input: { key: randomUUID(), stepId: activeReserved.stepId, expectedVersion: '1' } }, nonce: randomBytes(32).toString('base64url') }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, ...problemOf(error) }));
    assert.equal(issueError.ok, false); if (issueError.ok) throw new Error('issue');
    assert.equal(issueError.status, 403); assert.equal(issueError.code, 'model_broker_authorization_invalid');
    assert.equal((await restoreAdmin.query(`SELECT count(*)::int n FROM "${schema}".model_broker_authorizations`)).rows[0].n, beforeAuth);
    const bridgeEnvelope = await ask('bridge', heldRequest);
    const bridgeOutcome = await readOutcome(bridgeEnvelope.response, responsePair.publicKey);
    assert.equal(bridgeOutcome.kind, 'problem'); if (bridgeOutcome.kind !== 'problem') throw new Error('bridge');
    assert.equal(bridgeOutcome.code, 'model_broker_authorization_invalid');
    const rotateError = await ask('rotate', { key: randomUUID(), credentialId: credential.credentialId, expectedVersion: '1', replacementModelConnectionId: modelB.modelConnectionId, expectedReplacementModelVersion: '1', consent: true }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, ...problemOf(error) }));
    assert.equal(rotateError.ok, false); if (rotateError.ok) throw new Error('rotate');
    assert.equal(rotateError.status, 409); assert.equal(rotateError.code, 'broker_credential_unavailable');
    assert.equal((await restoreAdmin.query(`SELECT state FROM "${schema}".broker_model_credentials WHERE credential_id=$1`, [credential.credentialId])).rows[0].state, 'active');
    assert.equal(posts, 1);
    receipt.phase = 'replay';
    let hostCalls = 0;
    const throwingHost = { verify() { hostCalls += 1; throw new Error('verify_must_not_run'); }, dispatch() { hostCalls += 1; throw new Error('dispatch_must_not_run'); } };
    const destSteps = createModelStepService(destApp, { ...sqlOptions, host: throwingHost });
    await assert.rejects(destSteps.begin(actor, { key: randomUUID(), stepId: begun.metadata.stepId, expectedVersion: '2' }), (error: unknown) => { const problem = problemOf(error); return problem.status === 409 && problem.code === 'model_step_already_consumed'; });
    assert.equal(hostCalls, 0); assert.equal(posts, 1);
    receipt.phase = 'owner-read';
    let recoveryReads = 0;
    const ownerStore = createBrokerCredentialStore(destBroker, { ...sqlOptions, vault: assembled.vault, recover: async () => { recoveryReads += 1; throw new CredentialRecoveryError(); } });
    const owned = await ownerStore.read(actor, { credentialId: credential.credentialId });
    assert.equal(owned.state, 'active'); assert.equal(owned.recoveryGeneration, G); assert.equal(recoveryReads, 0);
    receipt.phase = 'stop';
    const stopped = await destSteps.control(actor, { key: randomUUID(), stepId: begun.metadata.stepId, expectedVersion: '2', action: 'stop' });
    assert.equal(stopped.state, 'outcome_unknown');
    const stoppedSql = (await restoreAdmin.query(`SELECT s.state,s.reservation_held,r.state run_state FROM "${schema}".model_text_steps s JOIN "${schema}".execution_runs r ON r.run_id=s.run_id WHERE s.step_id=$1`, [begun.metadata.stepId])).rows[0];
    assert.equal(stoppedSql.state, 'outcome_unknown'); assert.equal(stoppedSql.run_state, 'reconciling'); assert.equal(stoppedSql.reservation_held, true);
    receipt.phase = 'rotate-forward';
    const modelC = await createExecutionPrerequisites(destApp, sqlOptions).models.create(actor, { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection });
    const forward = await stage(destApp, modelC.modelConnectionId);
    const executed = await ask('ingestExecute', { modelConnectionId: modelC.modelConnectionId, approvalId: forward.approval.approvalId }, 90000);
    assert.equal(executed.recoveryGeneration, G1);
    const forwardOutcome = await readOutcome(executed.execute.response, responsePair.publicKey);
    assert.equal(forwardOutcome.kind, 'metadata'); if (forwardOutcome.kind !== 'metadata') throw new Error('forward');
    assert.equal(forwardOutcome.step.state, 'succeeded'); assert.equal(forwardOutcome.step.evidenceOrigin, 'synthetic_local_fixture'); assert.equal(forwardOutcome.step.operational_authority, false);
    assert.equal(posts, 2);
    receipt.phase = 'forged';
    const namespace = await mf!.getDurableObjectNamespace('AUTHORITY_GENERATION', 'floor') as unknown as { idFromName(name: string): { toString(): string }; get(id: { toString(): string }): { fetch(input: string, init?: RequestInit): Promise<Response> } };
    const forgedFloor = floorProfile('99');
    const forged = await namespace.get(namespace.idFromName(authorityObjectName(floorProfile(G1)))).fetch('https://freedom-private-ai-authority.internal/current', { method: 'GET', headers: { 'x-fp-authority-profile': JSON.stringify(forgedFloor) } });
    assert.equal(forged.status, 503);
    const publicForged = await (await mf!.getWorker('floor')).fetch(AUTHORITY_ORIGIN + AUTHORITY_PATHS['recovery-floor'], { method: 'GET', headers: { 'x-fp-authority-profile': JSON.stringify(forgedFloor) } });
    assert.equal(publicForged.status, 200); assert.equal(((await publicForged.json()) as { generation: string }).generation, G1);
    receipt.phase = 'rollback';
    await boot(G, 503);
    const rollbackBody = await direct(AUTHORITY_PATHS['recovery-floor']);
    assert.equal(rollbackBody.status, 503); assert.equal(((await rollbackBody.json()) as { code: string }).code, 'private_ai_authority_unavailable');
    const forgedDuringRollback = await (await mf!.getWorker('floor')).fetch(AUTHORITY_ORIGIN + AUTHORITY_PATHS['recovery-floor'], { method: 'GET', headers: { 'x-fp-authority-profile': JSON.stringify(floorProfile(G1)) } });
    assert.equal(forgedDuringRollback.status, 503);
    await ask('rebuild');
    const rolled = await ask('recover').then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, ...problemOf(error) }));
    assert.equal(rolled.ok, false); if (rolled.ok) throw new Error('rollback recover');
    assert.equal(rolled.message, 'credential_recovery_unavailable');
    assert.equal((await restoreAdmin.query(`SELECT state FROM "${schema}".broker_model_credentials WHERE credential_id=$1`, [credential.credentialId])).rows[0].state, 'active');
    const resolveError = await ask('resolve', { credentialId: credential.credentialId, expectedGeneration: '1' }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, ...problemOf(error) }));
    assert.equal(resolveError.ok, false); if (resolveError.ok) throw new Error('resolve');
    assert.equal(resolveError.status, 409); assert.equal(resolveError.code, 'broker_credential_unavailable');
    const issueWhileDown = await ask('issue', { operation: 'execute', command: { operation: 'execute', input: { key: randomUUID(), stepId: activeReserved.stepId, expectedVersion: '1' } }, nonce: randomBytes(32).toString('base64url') }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, ...problemOf(error) }));
    assert.equal(issueWhileDown.ok, false); if (issueWhileDown.ok) throw new Error('issue down');
    assert.equal(issueWhileDown.status, 403); assert.equal(issueWhileDown.code, 'model_broker_authorization_invalid');
    assert.equal(posts, 2);
    receipt.phase = 'owner-revoke';
    const still = await ownerStore.read(actor, { credentialId: credential.credentialId });
    assert.equal(still.state, 'active'); assert.equal(recoveryReads, 0);
    const revoked = await ownerStore.revoke(actor, { key: randomUUID(), credentialId: credential.credentialId, expectedVersion: '1' });
    assert.equal(revoked.state, 'revoked'); assert.equal(recoveryReads, 0);
    receipt.phase = 'high-water';
    await boot(G1, 200);
    await ask('rebuild');
    assert.equal((await ask('recover')).generation, G1);
    assert.equal(posts, 2); assert.equal(objectStoreCalls, 0); assert.equal(outboundCalls, 0);
    receipt.posts = posts; receipt.objectStoreCalls = objectStoreCalls; receipt.outboundCalls = outboundCalls;
    receipt.codes = { identityMismatch: 'recovery_identity_mismatch', sourceRotate: '409 broker_credential_unavailable', restoredClaim: '403 model_broker_authorization_invalid', restoredIssue: '403 model_broker_authorization_invalid', restoredBridge: 'model_broker_authorization_invalid', restoredRotate: '409 broker_credential_unavailable', replayBegin: '409 model_step_already_consumed', rollbackHttp: '503 private_ai_authority_unavailable', freshRecover: 'credential_recovery_unavailable', rollbackResolve: '409 broker_credential_unavailable', rollbackIssue: '403 model_broker_authorization_invalid', forgedDo: '503', stop: 'outcome_unknown', revoke: 'revoked', forward: 'succeeded synthetic_local_fixture' };
    receipt.states = { restoredCredential: 'active', recoveryGeneration: G, afterStop: 'outcome_unknown', runAfterStop: 'reconciling', reservationHeld: true, afterRevoke: 'revoked' };
    receipt.phase = 'done'; receipt.ok = true;
  } catch (error) {
    failure = error; receipt.error = problemOf(error).message.replaceAll(kekBytes, '[redacted]').replaceAll(signingJwk.d, '[redacted]'); receipt.posts = posts; receipt.child = childLogs.replaceAll(SECRET, '[redacted]').replaceAll(kekBytes, '[redacted]').replaceAll(signingJwk.d, '[redacted]').replace(/postgresql:\/\/\S+/gi, '[redacted]').slice(-500);
  } finally {
    receipt.elapsedMs = Date.now() - started;
    console.log('recovery-generation-drill-receipt ' + JSON.stringify(receipt));
    for (const proc of pgChildren) stopPg(proc);
    if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* exited */ } }
    server?.closeAllConnections(); if (server) await new Promise<void>(done => server!.close(() => done()));
    await mf?.dispose(); holders.mf = undefined;
    await Promise.all(pools.map(pool => pool.end().catch(() => undefined)));
    const cleanupAdmin = new Pool({ connectionString: sourceUrl, max: 1 }), cleanupRestore = new Pool({ connectionString: restoreUrl, max: 1 });
    try {
      if (sourceSchema) await cleanupAdmin.query(`DROP SCHEMA ${schema} CASCADE`);
      if (sourceRoles) await cleanupAdmin.query(`DROP ROLE ${roles.app},${roles.broker},${roles.exec},${roles.owner}`);
      await cleanupRestore.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (destRoles) await cleanupRestore.query(`DROP ROLE IF EXISTS ${roles.app},${roles.broker},${roles.exec}`);
    } finally { await cleanupAdmin.end(); await cleanupRestore.end(); }
    await rm(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
});

async function sealFrom(backup: Awaited<ReturnType<typeof createConsistentAssetBackup>>, archive: Awaited<ReturnType<typeof createFileArchiveStore>>, dumpFile: string, backupObjects: ObjectStore, setId: string) {
  const dump: DumpSource = { open: async () => Readable.toWeb(createReadStream(dumpFile)) as ReadableStream<Uint8Array> };
  const { sealRecoverySet } = await import('../../packages/media-migration/backup-archive.js');
  return sealRecoverySet({ backup, setId, environment: 'local', createdAt: new Date().toISOString(), dump, archive, backupObjects });
}
