import { TENANT_CURSOR_TEST_KEY } from './tenant-cursor-fixture.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { ensureSyntheticModuleTables } from '../../packages/testing/synthetic-module-provider.js';
import { syntheticModuleProviders } from '../../packages/testing/synthetic-module-provider.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { WORK_CONTRACT_SOURCE_COMMIT } from '../../modules/module-registry/definitions.js';
import type { ModuleProviderMap } from '../../modules/module-registry/providers.js';

const origin = 'http://127.0.0.1:4310';

export type Session = { cookie: string; csrf: string; user: { user_id: string; display_name: string; email: string } };
export type Reply = { status: number; data: any; response: Response };

const SYNTH_CONTRACT = {
  family: 'guild-launchpad.synthetic',
  version: '1',
  source_commit: WORK_CONTRACT_SOURCE_COMMIT,
  artifact_sha256: '0'.repeat(64),
  behavior_profile: 'freedom.synthetic/v1',
};

export async function createRegistryHarness(prefix: string, options: { synthetic?: boolean; max?: number; providers?: ModuleProviderMap } = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
  const schema = `${prefix}_${process.pid}_${Date.now()}`;
  const admin = createPool(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: options.max ?? 12 });
  const providers = options.providers ?? (options.synthetic ? syntheticModuleProviders(pool) : undefined);
  const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true, tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY, moduleProviders: providers });
  const closed = createApp(pool, origin, 'local');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  if (options.synthetic || options.providers) await ensureSyntheticModuleTables(pool);

  async function call(method: string, path: string, session?: Session, body?: unknown, headers: Record<string, string> = {}, target = app): Promise<Reply> {
    const sent: Record<string, string> = { Origin: origin, ...headers };
    if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
    if (body !== undefined) sent['Content-Type'] = 'application/json';
    const response = await target.request(origin + '/api/v1' + path, {
      method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json() : null;
    return { status: response.status, data, response };
  }
  async function post(path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID(), target = app) {
    const headers: Record<string, string> = {};
    if (key) headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = version;
    return call('POST', path, session, body, headers, target);
  }
  const sessionOf = (reply: Reply): Session => ({
    cookie: reply.response.headers.get('set-cookie')!.split(';')[0],
    csrf: reply.data.csrf_token,
    user: reply.data.user,
  });
  async function signIn(email: string, target = app): Promise<Session> {
    const reply = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD }, undefined, randomUUID(), target);
    if (reply.status !== 200) throw new Error(`login ${reply.status} ${JSON.stringify(reply.data)}`);
    return sessionOf(reply);
  }
  async function person(name: string) {
    const id = randomUUID();
    const email = `tenant-${id}@example.test`;
    await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
      SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
    [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
    return { id, email, session: await signIn(email) };
  }
  async function createTenant(owner: Session, displayName: string, workspaceName = '櫃檯') {
    const made = await post('/tenants', owner, { display_name: displayName, workspace_name: workspaceName });
    if (made.status !== 201) throw new Error(`tenant ${made.status} ${JSON.stringify(made.data)}`);
    return { tenantId: made.data.tenant.tenant_id as string, workspaceId: made.data.workspace.workspace_id as string };
  }
  async function workspace(owner: Session, tenantId: string, name: string) {
    const made = await post(`/tenants/${tenantId}/workspaces`, owner, { name });
    if (made.status !== 201) throw new Error(`workspace ${made.status} ${JSON.stringify(made.data)}`);
    return made.data.workspace_id as string;
  }
  async function guildKeys() {
    const rows = (await pool.query<{ guild_key: string }>('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key')).rows;
    return rows.map(row => row.guild_key);
  }
  async function fullMember(userId: string, guildKey: string, tier: 'full' | 'intern' = 'full') {
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,$4,'active',$5)
      ON CONFLICT (community_id, user_id, guild_key) DO UPDATE SET state='active', member_tier=$5`,
    [randomUUID(), DEMO_COMMUNITY, userId, guildKey, tier]);
  }
  async function candidate(actor: Session, userId: string) {
    const found = await call('GET', `/tenants/invite-candidates?user_id=${userId}`, actor);
    if (found.status !== 200) throw new Error(JSON.stringify(found.data));
    return found.data.principal_id as string;
  }
  async function invite(actor: Session, tenantId: string, principalId: string, role: 'admin' | 'operator' | 'viewer') {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    return post(`/tenants/${tenantId}/invitations`, actor, {
      invitee_principal_id: principalId, role, instance_capabilities: [], expires_at: soon,
    });
  }
  async function accept(invitee: Session, tenantId: string, invitation: Reply) {
    const accepted = await post(`/tenants/${tenantId}/invitations/${invitation.data.invitation_id}/accept`, invitee, {}, `"${invitation.data.version}"`);
    if (accepted.status !== 200) throw new Error(JSON.stringify(accepted.data));
  }
  async function enable(session: Session, tenantId: string, workspaceId: string, guildKey: string, choice?: unknown, key = randomUUID()) {
    return post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, session, choice ? { guild_key: guildKey, choice } : { guild_key: guildKey }, undefined, key);
  }
  function planBody(guildKey: string, workspaceId: string, application = 'manual-workspace', release = 'manual-workspace@1.0.0', extra: Record<string, unknown> = {}) {
    return {
      guild_key: guildKey,
      workspace_id: workspaceId,
      application_key: application,
      release_ref: release,
      installation_choice: 'create_new',
      dependencies: [],
      configuration: {},
      ...extra,
    };
  }
  async function plan(session: Session, tenantId: string, body: unknown, key = randomUUID()) {
    return post(`/tenants/${tenantId}/application-launch-plans`, session, body, undefined, key);
  }
  async function launch(session: Session, tenantId: string, planned: Reply, key = randomUUID()) {
    return post(`/tenants/${tenantId}/application-installations`, session, {
      plan_id: planned.data.plan_id,
      expected_plan_version: planned.data.version,
      configuration_digest: planned.data.configuration_digest,
    }, undefined, key);
  }
  async function count(table: string, where = '', params: unknown[] = []) {
    const row = (await pool.query(`SELECT count(*)::int AS n FROM ${table} ${where}`, params)).rows[0];
    return row.n as number;
  }
  async function installSyntheticCatalog() {
    const policy = JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' });
    const inventoryReq = {
      requirement_key: 'inventory', module_key: 'synthetic-inventory', module_release_ref: 'synthetic-inventory@1.0.0',
      capabilities: ['inventory:read'], required: true, cardinality: 'one', allow_reuse: true, compatible_contracts: [SYNTH_CONTRACT],
    };
    const storefrontReq = {
      requirement_key: 'storefront', module_key: 'synthetic-storefront', module_release_ref: 'synthetic-storefront@1.0.0',
      capabilities: ['storefront:sell'], required: true, cardinality: 'one', allow_reuse: false, compatible_contracts: [SYNTH_CONTRACT],
    };
    for (const moduleKey of ['synthetic-inventory', 'synthetic-storefront']) {
      const capability = moduleKey === 'synthetic-inventory' ? 'inventory:read' : 'storefront:sell';
      await pool.query(`INSERT INTO module_definitions(
          module_key, release_ref, capabilities, data_catalog_ref, contract_ref, data_schema_version,
          portable_profile_ref, runtime_profiles, config_schema_ref, supported_upgrade_paths,
          license_review_ref, license_state, release_status, version)
        VALUES($1,$2,$3::jsonb,'synthetic.tenant/v1',$4::jsonb,'1',NULL,'["hosted-shared"]'::jsonb,$5,'[]'::jsonb,NULL,'reviewed','available',1)
        ON CONFLICT DO NOTHING`,
      [moduleKey, `${moduleKey}@1.0.0`, JSON.stringify([capability]), JSON.stringify(SYNTH_CONTRACT), `${moduleKey}.config/v1`]);
    }
    const apps = [
      ['synthetic-storefront', 'synthetic-storefront@1.0.0', '合成店面', 'reviewed', 'available', [inventoryReq, storefrontReq], 'storefront:sell', 'synthetic-storefront.config/v1'],
      ['synthetic-unresolved', 'synthetic-unresolved@1.0.0', '未審查合成', 'unresolved', 'reviewed', [inventoryReq], 'inventory:read', 'synthetic-inventory.config/v1'],
      ['synthetic-held', 'synthetic-held@1.0.0', '未上架合成', 'reviewed', 'reviewed', [inventoryReq], 'inventory:read', 'synthetic-inventory.config/v1'],
    ] as const;
    for (const [key, release, name, license, status, requirements, entry, schemaRef] of apps) {
      await pool.query(`INSERT INTO application_definitions(
          application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs,
          module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
          release_status, customization_schema_ref, license_review_ref, version)
        VALUES($1,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6::jsonb,$7,'["hosted-reviewed"]'::jsonb,$8::jsonb,$9,$10,$11,NULL,1)
        ON CONFLICT DO NOTHING`,
      [key, release, name, WORK_CONTRACT_SOURCE_COMMIT,
        JSON.stringify({ algorithm: 'sha256', value: '0'.repeat(64) }),
        JSON.stringify(requirements), entry, policy, license, status, schemaRef]);
    }
    for (const release of ['synthetic-storefront@1.0.0', 'synthetic-unresolved@1.0.0', 'synthetic-held@1.0.0']) {
      const key = release.split('@')[0];
      await pool.query(`INSERT INTO guild_application_offerings(
          offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
        SELECT $1,$2,'guild_ai_field',$3,$4,'offered',10,$5::jsonb,1
        WHERE NOT EXISTS (
          SELECT 1 FROM guild_application_offerings
          WHERE community_id=$2 AND guild_key='guild_ai_field' AND release_ref=$4)`,
      [randomUUID(), DEMO_COMMUNITY, key, release, policy]);
    }
  }
  async function reset() {
    await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
    await seedLocal(pool);
    await pool.query(`INSERT INTO tenant_capacity_policies(
        policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
        max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
      SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
      WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
    if (options.synthetic || options.providers) {
      await pool.query('TRUNCATE synthetic_module_effects, synthetic_module_faults');
      await installSyntheticCatalog();
    }
  }
  async function stop() {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
  return {
    pool, admin, app, closed, schema, origin, providers, call, post, signIn, person, createTenant, workspace,
    guildKeys, fullMember, candidate, invite, accept, enable, planBody, plan, launch, count, reset, stop, installSyntheticCatalog,
  };
}

export type RegistryHarness = Awaited<ReturnType<typeof createRegistryHarness>>;
