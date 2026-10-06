import { rmSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import type { Pool } from 'pg';
import { transaction } from '../db/transaction.js';
import { withMemberScope } from '../resource-scopes/index.js';
import { createR2ObjectStore, type AssetR2Binding } from '../asset-storage/r2.js';
import type { ObjectStore } from '../asset-storage/index.js';
import { DEMO_PASSWORD, DEMO_USERS } from './seed.js';
import { e2eSchema } from './e2e-auth-isolation.js';
import { login } from '../../modules/identity-membership/service.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createCredentialVault } from '../../apps/credential-broker/src/vault.js';
import { createBrokerCredentialStore, getCredentialWriteBinding } from '../../apps/credential-broker/src/store.js';

/** Local browser-test fixture only. The product server does not import this file.
 * Miniflare stays on loopback with no Cloudflare account, and the proof socket
 * returns only validated v1 object keys from that bucket. */
const OBJECT_KEY = /^v1\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type ProofBucket = { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options?: { cursor?: string }): Promise<{ objects: { key: string }[]; truncated?: boolean; cursor?: string }> };

export function avatarAssetProofSocketPath(schema = e2eSchema(process.env.FREEDOM_E2E_SCHEMA)): string {
  return join(tmpdir(), `fp-e2e-avatar-r2-${schema}`, 'proof.sock');
}

async function seedRevokedByok(pool: Pool) {
  const clientId = 'e2e-avatar-asset-fixture';
  const options = { environment: 'local' as const, clientId };
  const selection = { providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote' as const,
    artifactCustody: 'platform_asset' as const, credentialCustody: 'platform_vault' as const, engineLocation: 'platform' as const, billingSource: 'user_byok' as const };
  const { actor } = await login(pool, DEMO_USERS[1].email, DEMO_PASSWORD);
  await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async () => {});
  const enrollment = createRuntimeRegistrations(pool, { environment: 'local' });
  const connections = createAgentConnections(pool, options);
  const prerequisites = createExecutionPrerequisites(pool, options);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const challenge = await enrollment.begin(actor, { key: randomUUID(), publicJwk: parseRuntimePublicJwk(await exportJWK(signing.publicKey)) });
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(signing.privateKey);
  const device = await enrollment.confirm(actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  const connection = await connections.create(actor, { key: randomUUID(), runtimeDeviceId: device.runtimeDeviceId });
  await transaction(pool, q => insertInitialRefreshFamily(q, connection.connectionId, new Date(connection.issuedAt), new Date(connection.expiresAt)));
  const model = await prerequisites.models.create(actor, { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection });
  const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const recover = async () => ({ generation: '1', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const vault = createCredentialVault({ kek: { current: async () => ({ keyId: 'synthetic-e2e-avatar-kek', key: kek }), readById: async id => id === 'synthetic-e2e-avatar-kek' ? kek : null }, recover });
  const store = createBrokerCredentialStore(pool, { ...options, vault, recover });
  const intent = await store.prepareCreate(actor, { key: randomUUID(), modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true });
  const secret = new TextEncoder().encode('synthetic-e2e-byok-not-a-provider-key');
  let sealed;
  try { sealed = await vault.seal(getCredentialWriteBinding(intent), secret); }
  finally { secret.fill(0); }
  const metadata = await store.commit(actor, intent, sealed);
  const revoked = await store.revoke(actor, { key: randomUUID(), credentialId: metadata.credentialId, expectedVersion: '1' });
  if (revoked.state !== 'revoked') throw new Error('Avatar fixture owner revoke did not revoke the credential.');
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [actor.session_hash]);
  const maker = (await pool.query(`SELECT (SELECT count(*)::int FROM model_connections WHERE owner_user_id=$1) models,
    (SELECT count(*)::int FROM broker_model_credentials WHERE owner_user_id=$1) credentials`, [DEMO_USERS[0].user_id])).rows[0];
  if (maker.models !== 0 || maker.credentials !== 0) throw new Error('Avatar fixture must not create a model key for the no-key member.');
  const states = (await pool.query(`SELECT c.state AS credential_state, m.state AS model_state,
      (SELECT count(*)::int FROM broker_credential_vault v WHERE v.credential_id=c.credential_id) vaults
    FROM broker_model_credentials c JOIN model_connections m ON m.model_connection_id=c.model_connection_id
    WHERE c.owner_user_id=$1`, [DEMO_USERS[1].user_id])).rows;
  if (states.length !== 1 || states[0].credential_state !== 'revoked' || states[0].model_state !== 'revoked' || states[0].vaults !== 1) {
    throw new Error('Avatar fixture revoked-key seed is not revoked.');
  }
}

export async function createAvatarAssetBrowserFixture(pool: Pool, origin: string): Promise<{ store: ObjectStore; close: () => Promise<void> }> {
  const schema = e2eSchema(process.env.FREEDOM_E2E_SCHEMA);
  const serverPort = (await pool.query(`SELECT current_setting('port') AS port`)).rows[0].port;
  if (process.env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE !== '1' || process.env.FREEDOM_E2E_PRIVATE_AI_FIXTURE === '1'
    || serverPort === '54339'
    || (await pool.query('SELECT current_schema() AS schema')).rows[0].schema !== schema
    || new URL(origin).hostname !== '127.0.0.1') throw new Error('Avatar asset browser fixture isolation required.');
  const dir = join(tmpdir(), `fp-e2e-avatar-r2-${schema}`);
  const socketPath = join(dir, 'proof.sock');
  let created = false, mf: Miniflare | undefined, proof: Server | undefined, closed = false;
  const removeDir = () => {
    if (!created) return;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* workerd may still hold a file */ }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    // Unlink before dispose. A group SIGTERM also kills workerd; waiting on dispose used to
    // outlive the process and skip both this directory and the server's DROP SCHEMA.
    if (proof) proof.close();
    removeDir();
    if (mf) await Promise.race([mf.dispose().catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, 1500))]);
    removeDir();
    if (created) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await mkdir(dir, { mode: 0o700 });
    created = true;
    await chmod(dir, 0o700);
    const policy = await pool.query(`UPDATE avatar_storage_policy SET mode='r2_only', policy_revision='e2e-avatar-asset-1',
      persistence_allowed=true, retained_byte_limit=10485760 WHERE profile='member.avatar' RETURNING mode`);
    if (policy.rowCount !== 1 || policy.rows[0].mode !== 'r2_only') throw new Error('Avatar asset browser fixture could not enable r2_only.');
    await seedRevokedByok(pool);
    if (process.env.WRANGLER_SEND_METRICS === undefined) process.env.WRANGLER_SEND_METRICS = 'false';
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'fp-e2e-avatar-r2', modules: true,
      script: 'export default { fetch(){return new Response(null,{status:503})}}',
      compatibilityDate: '2026-09-21', r2Buckets: ['MEDIA'] }],
      resourcePersistencePath: dir, log: new Log(LogLevel.NONE), host: '127.0.0.1', port: 0, logRequests: false }));
    await mf.ready;
    const bucket = await mf.getR2Bucket('MEDIA') as unknown as AssetR2Binding & ProofBucket;
    const store = createR2ObjectStore(bucket);
    proof = createServer(socket => {
      socket.on('error', () => socket.destroy());
      let raw = '', responded = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reply = (body: string) => {
        if (responded || socket.destroyed || socket.writableEnded) return;
        responded = true;
        clearTimeout(timer);
        socket.end(body + '\n');
      };
      timer = setTimeout(() => reply('{"ok":false}'), 2000);
      // Attach the reader before decoding so a unix-socket payload already in the
      // kernel buffer is not dropped by setEncoding.
      socket.on('data', chunk => {
        if (responded) return;
        raw += chunk;
        if (raw.length > 512) { clearTimeout(timer); socket.destroy(); return; }
        const newline = raw.indexOf('\n');
        if (newline < 0) return;
        const line = raw.slice(0, newline);
        void (async () => {
          let body = '{"ok":false}';
          try {
            const message = JSON.parse(line) as { op?: string; key?: string };
            if (message.op === 'list') {
              const keys: string[] = [];
              let cursor: string | undefined;
              do {
                const page = await bucket.list(cursor ? { cursor } : {});
                for (const object of page.objects) if (OBJECT_KEY.test(object.key)) keys.push(object.key);
                cursor = page.truncated ? page.cursor : undefined;
              } while (cursor);
              body = JSON.stringify({ ok: true, keys });
            } else if (message.op === 'get' && typeof message.key === 'string' && OBJECT_KEY.test(message.key)) {
              const object = await bucket.get(message.key);
              if (object) {
                const bytes = Buffer.from(await object.arrayBuffer());
                body = JSON.stringify({ ok: true, sha256: createHash('sha256').update(bytes).digest('hex'), byte_size: bytes.length, bytes_b64: bytes.toString('base64') });
              }
            }
          } catch { body = '{"ok":false}'; }
          reply(body);
        })();
      });
      socket.setEncoding('utf8');
    });
    await new Promise<void>((resolve, reject) => { proof!.once('error', reject); proof!.listen(socketPath, () => resolve()); });
    await chmod(socketPath, 0o600);
    return { store, close };
  } catch (error) { await close(); throw error; }
}
