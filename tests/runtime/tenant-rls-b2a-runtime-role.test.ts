import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';
import { applyOwnerAccountStatus } from '../../modules/tenant-workspaces/security-path.js';
import { migrate } from '../../scripts/database.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Tenant runtime RLS requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const origin = 'http://127.0.0.1:4346';
const stamp = `${process.pid}_${Date.now()}`;
const schema = `e1b_${stamp}`;
const migrator = `e1bm_${stamp}`;
const runtimeRole = `e1br_${stamp}`;
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'admin-b2a-runtime-tests';
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const verifier = createAdminAccessVerifier({
  issuer, audience, csrfSecret: 'test-fixture-admin-csrf-secret-123456789',
  keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'admin-test', alg: 'RS256' }] }),
});
const admin = new Pool({ connectionString, max: 2 });
function roleUrl(role: string) {
  const url = new URL(connectionString!);
  url.username = role;
  url.password = '';
  return url.toString();
}
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=20000`, max: 2 });
const runtime = new Pool({
  connectionString: roleUrl(runtimeRole),
  options: `-c search_path=${schema} -c statement_timeout=20000`,
  max: 1,
  connectionTimeoutMillis: 8000,
});
for (const pool of [admin, owner, runtime]) pool.on('error', () => undefined);
const app = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, adminVerifier: verifier });

type Session = { cookie: string; csrf: string; user: { user_id: string } };
type AdminWho = { id: string; email: string; jwt: string; csrf: string };
type Reply = { status: number; data: any };
type Person = { id: string; email: string; session: Session };
const roster = {
  opener: { id: randomUUID(), email: 'b2a-opener@example.test', name: '開啟者', capabilities: ['tenant.recovery.open', 'tenant.recovery.review', 'tenant.recovery.execute'] },
  reviewer: { id: randomUUID(), email: 'b2a-reviewer@example.test', name: '核准者', capabilities: ['tenant.recovery.review', 'tenant.recovery.execute', 'tenant.recovery.read'] },
  executor: { id: randomUUID(), email: 'b2a-executor@example.test', name: '執行者', capabilities: ['tenant.recovery.execute'] },
  bare: { id: randomUUID(), email: 'b2a-bare@example.test', name: '無權限', capabilities: [] as string[] },
};
const admins: Record<keyof typeof roster, AdminWho> = {
  opener: { id: roster.opener.id, email: roster.opener.email, jwt: '', csrf: '' },
  reviewer: { id: roster.reviewer.id, email: roster.reviewer.email, jwt: '', csrf: '' },
  executor: { id: roster.executor.id, email: roster.executor.email, jwt: '', csrf: '' },
  bare: { id: roster.bare.id, email: roster.bare.email, jwt: '', csrf: '' },
};
let created = false;

function unset(value: unknown) { return value == null || value === ''; }
function later(hours = 1) { return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(); }
async function quiet() {
  const row = (await runtime.query<{ p: string | null; t: string | null; s: string | null; a: string | null; n: number }>(
    `SELECT pg_catalog.current_setting('freedom.principal_id', true) AS p,
            pg_catalog.current_setting('freedom.tenant_id', true) AS t,
            pg_catalog.current_setting('freedom.tenant_scope_id', true) AS s,
            pg_catalog.current_setting('freedom.platform_admin_id', true) AS a,
            (SELECT count(*)::int FROM tenants) AS n`)).rows[0];
  assert.equal(unset(row.p) && unset(row.t) && unset(row.s) && unset(row.a), true, JSON.stringify(row));
  assert.equal(row.n, 0);
}
async function applyGrants() {
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const general = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtimeRole}"`);
  const capacity = template.split('-- BEGIN TENANT CAPACITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const authority = template.split('-- BEGIN TENANT AUTHORITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try {
    await q.query(general);
    const statements = await q.query(capacity);
    assert.equal(statements.rowCount, 1);
    await q.query(Object.values(statements.rows[0])[0] as string);
    const authorityStatements = await q.query(authority);
    assert.equal(authorityStatements.rowCount, 2);
    for (const statement of authorityStatements.rows) await q.query(Object.values(statement)[0] as string);
    await q.query('COMMIT');
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch { /* keep the grant error */ }
    throw error;
  } finally { q.release(); }
}
async function sign(email: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email, sub: 'verified-human-fixture', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600 })
    .setProtectedHeader({ alg: 'RS256', kid: 'admin-test' }).sign(pair.privateKey);
}
function pgError(error: unknown): { code?: string; message: string } {
  const row = error as { code?: string; message?: string };
  return { code: row.code, message: row.message ?? String(error) };
}

describe('T-024 P-B2a as the non-owner runtime role', { concurrency: 1 }, () => {
  before(async () => {
    assert.ok(migrator.length < 63 && runtimeRole.length < 63 && schema.length < 63);
    await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE SCHEMA ${schema} AUTHORIZATION ${migrator};
      GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    created = true;
    await migrate(owner);
    await applyGrants();
    await seedLocal(owner);
    await owner.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
    await owner.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
      VALUES (1,'active',600,86400,86400,1)`);
    for (const key of Object.keys(roster) as Array<keyof typeof roster>) {
      const row = roster[key];
      await owner.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)`, [row.id, DEMO_COMMUNITY, row.email, row.name]);
      for (const capability of row.capabilities) {
        await owner.query(`INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES($1,$2)`, [row.id, capability]);
      }
      const jwt = await sign(row.email);
      const csrf = (await verifier(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }))).csrfToken;
      admins[key] = { id: row.id, email: row.email, jwt, csrf };
    }
  });
  after(async () => {
    await runtime.end();
    await owner.end();
    try {
      if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole}; DROP ROLE ${migrator}`);
    } finally { await admin.end(); }
  });

  async function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
    try {
      const response = await app.request(origin + path, { method, headers, body });
      const text = await response.text();
      const type = response.headers.get('content-type') ?? '';
      return { status: response.status, data: type.includes('application/json') && text ? JSON.parse(text) : null };
    } finally { await quiet(); }
  }
  function memberHeaders(session?: Session, version?: string, key?: string) {
    const headers: Record<string, string> = { Origin: origin };
    if (session) { headers.Cookie = session.cookie; headers['X-CSRF-Token'] = session.csrf; }
    if (key !== undefined || version !== undefined) headers['Content-Type'] = 'application/json';
    if (key !== undefined) headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = version.startsWith('"') ? version : `"${version}"`;
    return headers;
  }
  async function member(method: string, path: string, session?: Session, body?: unknown, version?: string, key = randomUUID()) {
    const sending = body !== undefined;
    return call(method, '/api/v1' + path, memberHeaders(session, sending ? version : undefined, sending ? key : undefined), sending ? JSON.stringify(body) : undefined);
  }
  async function adminCall(who: AdminWho, method: string, path: string, body?: unknown, version?: string) {
    const headers: Record<string, string> = {
      Origin: origin, 'Cf-Access-Jwt-Assertion': who.jwt, 'X-Admin-CSRF': who.csrf,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = randomUUID();
      if (version !== undefined) headers['If-Match'] = version.startsWith('"') ? version : `"${version}"`;
    }
    return call(method, '/admin/api' + path, headers, body === undefined ? undefined : JSON.stringify(body));
  }
  async function signIn(email: string): Promise<Session> {
    const response = await app.request(origin + '/api/v1/auth/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: DEMO_PASSWORD }),
    });
    const data = await response.json() as { csrf_token: string; user: Session['user']; code?: string };
    assert.equal(response.status, 200, JSON.stringify(data));
    await quiet();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, user: data.user };
  }
  async function person(name: string): Promise<Person> {
    const id = randomUUID();
    const email = `tenant-${id}@example.test`;
    await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
      SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
    [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
    return { id, email, session: await signIn(email) };
  }
  async function createTenant(actor: Session, name: string) {
    const made = await member('POST', '/tenants', actor, { display_name: name, workspace_name: name + '櫃' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    return made.data.tenant as { tenant_id: string; display_name: string; my_membership: { principal_id: string } };
  }
  async function candidate(actor: Session, userId: string) {
    const found = await member('GET', `/tenants/invite-candidates?user_id=${userId}`, actor);
    assert.equal(found.status, 200, JSON.stringify(found.data));
    return found.data.principal_id as string;
  }
  async function verify(session: Session, tenantId: string, purpose: string) {
    const response = await member('POST', '/me/high-risk-verifications', session, { password: DEMO_PASSWORD, purpose, tenant_id: tenantId });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.verification_id as string;
  }
  async function propose(actor: Session, tenantId: string, to: string) {
    const verificationId = await verify(actor, tenantId, 'tenant.ownership.propose');
    const made = await member('POST', `/tenants/${tenantId}/ownership-transfers`, actor, {
      to_principal_id: to, from_role_after: 'admin', expires_at: later(), reason: '交給下一位擁有者', fresh_auth_verification_id: verificationId,
    });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    return made.data as { transfer_id: string; version: string; state: string; tenant_display_name: string };
  }
  async function transferState(transferId: string) {
    return (await owner.query<{ state: string; version: string }>(
      `SELECT state, version::text AS version FROM tenant_ownership_transfers WHERE transfer_id=$1`, [transferId])).rows[0];
  }
  async function overdue(tenantId: string, fromPrincipal: string, toPrincipal: string) {
    return (await owner.query<{ transfer_id: string; version: string }>(`INSERT INTO tenant_ownership_transfers(
      tenant_id, from_principal_id, to_principal_id, from_role_after, state, expires_at, tenant_authorization_revision, reason)
      VALUES ($1,$2,$3,'admin','pending',clock_timestamp()-interval '1 minute',
        (SELECT authorization_revision FROM tenants WHERE tenant_id=$1),'已過期的移交')
      RETURNING transfer_id, version::text AS version`, [tenantId, fromPrincipal, toPrincipal])).rows[0];
  }
  async function tenantStatus(tenantId: string) {
    return (await owner.query<{ status: string }>(`SELECT status FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0].status;
  }
  async function countWhere(sql: string, params: unknown[]) {
    return (await owner.query<{ n: number }>(sql, params)).rows[0].n;
  }
  async function runtimeFailure(setupSql: string, setup: unknown[], statement: string, params: unknown[]) {
    const q = await runtime.connect();
    try {
      await q.query('BEGIN');
      try {
        await q.query(setupSql, setup);
        await q.query(statement, params);
        return { code: 'ok', message: 'statement succeeded' };
      } catch (error) {
        return pgError(error);
      } finally { await q.query('ROLLBACK'); }
    } finally { q.release(); }
  }
  async function bindSql(tenantId: string | null, principalId: string | null) {
    const scope = tenantId
      ? (await owner.query<{ scope_id: string }>(`SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1`, [tenantId])).rows[0].scope_id
      : '';
    return {
      sql: `SELECT pg_catalog.set_config('freedom.tenant_id', $1, true),
                   pg_catalog.set_config('freedom.tenant_scope_id', $2, true),
                   pg_catalog.set_config('freedom.principal_id', $3, true)`,
      params: [tenantId ?? '', scope, principalId ?? ''],
    };
  }

  test('T-024 authority tables stay writable only by the owner, and the new policies are visible', async () => {
    const flags = (await runtime.query<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; polname: string | null; polcmd: string | null; using_expr: string | null; check_expr: string | null }>(
      `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity, p.polname, p.polcmd,
              pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expr,
              pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
       WHERE n.nspname=current_schema() AND c.relname IN (
         'tenant_high_risk_verifications','tenant_ownership_transfers','tenant_recovery_cases','tenants',
         'tenant_authority_policies','platform_admin_tenant_recovery_capabilities')
       ORDER BY c.relname, p.polname`)).rows;
    console.log(JSON.stringify({ check: 'b2a_policies', rows: flags }));
    for (const name of ['tenant_authority_policies', 'platform_admin_tenant_recovery_capabilities']) {
      assert.equal(flags.find(row => row.table_name === name)?.relrowsecurity, false, name);
      assert.equal(flags.some(row => row.table_name === name && row.polname), false, name);
    }
    const policies = flags.filter(row => row.polname).map(row => `${row.table_name}:${row.polname}`);
    for (const name of [
      'tenant_high_risk_verifications:tenant_high_risk_verifications_tenant',
      'tenant_ownership_transfers:tenant_ownership_transfers_tenant',
      'tenant_ownership_transfers:tenant_ownership_transfers_recipient_read',
      'tenant_ownership_transfers:tenant_ownership_transfers_recipient_expire',
      'tenant_ownership_transfers:tenant_ownership_transfers_principal_invalidate',
      'tenant_recovery_cases:tenant_recovery_cases_tenant',
      'tenant_recovery_cases:tenant_recovery_cases_proposed_owner_read',
      'tenant_recovery_cases:tenant_recovery_cases_platform_admin_read',
      'tenants:tenants_counterparty_read',
    ]) assert.equal(policies.includes(name), true, name);
    async function denied(sql: string, params: unknown[] = []) {
      const q = await runtime.connect();
      try {
        await q.query('BEGIN');
        let code = 'ok';
        try { await q.query(sql, params); }
        catch (error) { code = pgError(error).code ?? 'error'; }
        await q.query('ROLLBACK');
        assert.equal(code, '42501', sql);
      } finally { q.release(); }
    }
    await denied(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
      VALUES (2,'retired',600,86400,86400,1)`);
    await denied(`UPDATE tenant_authority_policies SET status='retired'`);
    await denied(`INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES($1,'tenant.recovery.read')`, [admins.bare.id]);
    await denied(`UPDATE platform_admin_tenant_recovery_capabilities SET revoked_at=clock_timestamp()`);
    await denied(`DELETE FROM platform_admin_tenant_recovery_capabilities`);
    const grantSql = (await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8'))
      .split('-- BEGIN TENANT AUTHORITY POLICY GRANTS\n')[1].split('\n\\gexec')[0];
    assert.match(grantSql, /GRANT SELECT, UPDATE \(policy_lock\)/);
    assert.match(grantSql, /GRANT SELECT, UPDATE \(capability_lock\)/);
    const locking = await runtime.connect();
    try {
      await locking.query('BEGIN');
      const locked = await locking.query(`SELECT capability_id FROM platform_admin_tenant_recovery_capabilities
        WHERE revoked_at IS NULL ORDER BY capability_id FOR SHARE`);
      assert.ok((locked.rowCount ?? 0) >= 1);
      await locking.query(`UPDATE platform_admin_tenant_recovery_capabilities SET capability_lock=DEFAULT`);
      await locking.query('ROLLBACK');
    } finally { locking.release(); }
    assert.equal((await runtime.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_authority_policies WHERE status='active'`)).rows[0].n, 1);
    assert.ok((await runtime.query<{ n: number }>(`SELECT count(*)::int AS n FROM platform_admin_tenant_recovery_capabilities`)).rows[0].n >= 1);
    await quiet();
  });

  test('T-024 one disable evaluates a sole-owner tenant and a co-owned tenant, then reactivation restores only the first', async () => {
    const holder = await person('擁有者');
    const coOwner = await person('共同擁有者');
    const recipient = await person('接收者');
    const bystander = await person('旁觀者');
    const sole = await createTenant(holder.session, '空間甲');
    const shared = await createTenant(holder.session, '空間乙');
    const other = await createTenant(bystander.session, '空間丙');
    const recipientPrincipal = await candidate(holder.session, recipient.id);
    const holderPrincipal = sole.my_membership.principal_id;
    const coPrincipal = await candidate(holder.session, coOwner.id);
    await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [shared.tenant_id, coPrincipal]);
    const sent = await propose(holder.session, sole.tenant_id, recipientPrincipal);
    const received = await propose(coOwner.session, shared.tenant_id, holderPrincipal);
    const untouched = await propose(bystander.session, other.tenant_id, recipientPrincipal);
    const disabled = await adminCall(admins.opener, 'POST', `/members/${holder.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1');
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
    assert.equal(await tenantStatus(sole.tenant_id), 'recovery_required');
    assert.equal(await tenantStatus(shared.tenant_id), 'active');
    assert.equal(await tenantStatus(other.tenant_id), 'active');
    assert.equal((await transferState(sent.transfer_id)).state, 'invalidated');
    assert.equal((await transferState(received.transfer_id)).state, 'invalidated');
    assert.equal((await transferState(untouched.transfer_id)).state, 'pending');
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_authority_audit WHERE tenant_id=$1 AND reason_code='owner_account_disabled'`, [sole.tenant_id]), 1);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_authority_audit WHERE tenant_id=$1 AND reason_code='owner_account_disabled'`, [shared.tenant_id]), 0);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM scoped_transition_journal j JOIN resource_scopes s ON s.scope_id=j.scope_id
      WHERE s.tenant_ref=$1 AND j.operation='tenant.security.owner_disabled'`, [sole.tenant_id]), 1);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM scoped_outbox o JOIN resource_scopes s ON s.scope_id=o.scope_id
      WHERE s.tenant_ref=$1 AND o.event_type='freedom.tenant.recovery.required.v1'`, [sole.tenant_id]), 1);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM scoped_outbox o JOIN resource_scopes s ON s.scope_id=o.scope_id
      WHERE s.tenant_ref=$1 AND o.event_type='freedom.tenant.recovery.required.v1'`, [shared.tenant_id]), 0);
    const restored = await adminCall(admins.opener, 'POST', `/members/${holder.id}/status`, { active: true, reason: '會員要求恢復帳號。' }, '2');
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(await tenantStatus(sole.tenant_id), 'active');
    assert.equal(await tenantStatus(shared.tenant_id), 'active');
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_authority_audit WHERE tenant_id=$1 AND reason_code='owner_account_reactivated'`, [sole.tenant_id]), 1);
  });

  test('T-024 fresh verification is consumed by propose, accept changes the owner, and every expiry path commits expired', async () => {
    const maker = await person('擁有者');
    const recipient = await person('接收者');
    const tenant = await createTenant(maker.session, '移交空間');
    const to = await candidate(maker.session, recipient.id);
    const verificationId = await verify(maker.session, tenant.tenant_id, 'tenant.ownership.propose');
    const fresh = (await owner.query<{ consumed_at: Date | null; consumed_by: string | null }>(
      `SELECT consumed_at, consumed_by FROM tenant_high_risk_verifications WHERE verification_id=$1`, [verificationId])).rows[0];
    assert.equal(fresh.consumed_at, null);
    assert.equal(fresh.consumed_by, null);
    const proposed = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers`, maker.session, {
      to_principal_id: to, from_role_after: 'admin', expires_at: later(), reason: '交給下一位擁有者', fresh_auth_verification_id: verificationId,
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.data));
    const consumed = (await owner.query<{ consumed_at: Date | null; consumed_by: string | null }>(
      `SELECT consumed_at, consumed_by FROM tenant_high_risk_verifications WHERE verification_id=$1`, [verificationId])).rows[0];
    assert.ok(consumed.consumed_at instanceof Date);
    assert.match(consumed.consumed_by ?? '', /^[0-9a-f]{64}$/);
    const reused = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers`, maker.session, {
      to_principal_id: to, from_role_after: 'viewer', expires_at: later(), reason: '同一份驗證不能再用', fresh_auth_verification_id: verificationId,
    });
    assert.equal(reused.status, 403, JSON.stringify(reused.data));
    assert.equal(reused.data.code, 'fresh_auth_required');
    const acceptVerification = await verify(recipient.session, tenant.tenant_id, 'tenant.ownership.accept');
    const accepted = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers/${proposed.data.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: acceptVerification,
    }, `"${proposed.data.version}"`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.transfer.state, 'accepted');
    assert.equal(accepted.data.my_role, 'owner');
    const owners = (await owner.query<{ principal_id: string; role: string; status: string }>(
      `SELECT principal_id, role, status FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [tenant.tenant_id])).rows;
    assert.deepEqual(owners.map(row => row.principal_id), [to]);

    async function pair(name: string) {
      const left = await person('擁有者' + name);
      const right = await person('接收者' + name);
      const space = await createTenant(left.session, name);
      const recipientId = await candidate(left.session, right.id);
      return { left, right, space, recipientId };
    }
    const proposedOverdue = await pair('提案過期');
    const oldPropose = await overdue(proposedOverdue.space.tenant_id, proposedOverdue.space.my_membership.principal_id, proposedOverdue.recipientId);
    const replaced = await propose(proposedOverdue.left.session, proposedOverdue.space.tenant_id, proposedOverdue.recipientId);
    assert.equal((await transferState(oldPropose.transfer_id)).state, 'expired');
    assert.equal(replaced.state, 'pending');

    const acceptOverdue = await pair('接受過期');
    const oldAccept = await overdue(acceptOverdue.space.tenant_id, acceptOverdue.space.my_membership.principal_id, acceptOverdue.recipientId);
    const acceptVerificationId = await verify(acceptOverdue.right.session, acceptOverdue.space.tenant_id, 'tenant.ownership.accept');
    const staleAccept = await member('POST', `/tenants/${acceptOverdue.space.tenant_id}/ownership-transfers/${oldAccept.transfer_id}/accept`, acceptOverdue.right.session, {
      accept_scope: true, fresh_auth_verification_id: acceptVerificationId,
    }, `"${oldAccept.version}"`);
    assert.equal(staleAccept.status, 409, JSON.stringify(staleAccept.data));
    assert.equal(staleAccept.data.code, 'transfer_expired');
    assert.equal((await transferState(oldAccept.transfer_id)).state, 'expired');

    const cancelOverdue = await pair('取消過期');
    const oldCancel = await overdue(cancelOverdue.space.tenant_id, cancelOverdue.space.my_membership.principal_id, cancelOverdue.recipientId);
    const staleCancel = await member('POST', `/tenants/${cancelOverdue.space.tenant_id}/ownership-transfers/${oldCancel.transfer_id}/cancel`, cancelOverdue.left.session, { reason: '取消這次擁有權移交' });
    assert.equal(staleCancel.status, 409, JSON.stringify(staleCancel.data));
    assert.equal(staleCancel.data.code, 'transfer_expired');
    assert.equal((await transferState(oldCancel.transfer_id)).state, 'expired');

    const declineOverdue = await pair('拒絕過期');
    const oldDecline = await overdue(declineOverdue.space.tenant_id, declineOverdue.space.my_membership.principal_id, declineOverdue.recipientId);
    const staleDecline = await member('POST', `/tenants/${declineOverdue.space.tenant_id}/ownership-transfers/${oldDecline.transfer_id}/decline`, declineOverdue.right.session, {});
    assert.equal(staleDecline.status, 409, JSON.stringify(staleDecline.data));
    assert.equal(staleDecline.data.code, 'transfer_expired');
    assert.equal((await transferState(oldDecline.transfer_id)).state, 'expired');

    const readOverdue = await pair('讀取過期');
    const oldRead = await overdue(readOverdue.space.tenant_id, readOverdue.space.my_membership.principal_id, readOverdue.recipientId);
    const read = await member('GET', `/tenants/${readOverdue.space.tenant_id}/ownership-transfers/${oldRead.transfer_id}`, readOverdue.left.session);
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.state, 'expired');
    assert.equal((await transferState(oldRead.transfer_id)).state, 'expired');

    const listOverdue = await pair('清單過期');
    const oldList = await overdue(listOverdue.space.tenant_id, listOverdue.space.my_membership.principal_id, listOverdue.recipientId);
    const listed = await member('GET', `/tenants/${listOverdue.space.tenant_id}/ownership-transfers`, listOverdue.left.session);
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.equal(listed.data.items.some((item: { transfer_id: string }) => item.transfer_id === oldList.transfer_id), false);
    assert.equal((await transferState(oldList.transfer_id)).state, 'expired');

    const mineOverdue = await pair('收件過期');
    const oldMine = await overdue(mineOverdue.space.tenant_id, mineOverdue.space.my_membership.principal_id, mineOverdue.recipientId);
    const mine = await member('GET', '/me/tenant-ownership-transfers', mineOverdue.right.session);
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    assert.equal(mine.data.items.some((item: { transfer_id: string }) => item.transfer_id === oldMine.transfer_id), false);
    assert.equal((await transferState(oldMine.transfer_id)).state, 'expired');

    const failure = await pair('失效寫入');
    const pending = await propose(failure.left.session, failure.space.tenant_id, failure.recipientId);
    await owner.query(`UPDATE tenants SET authorization_revision=authorization_revision+1 WHERE tenant_id=$1`, [failure.space.tenant_id]);
    const failureVerification = await verify(failure.right.session, failure.space.tenant_id, 'tenant.ownership.accept');
    const changed = await member('POST', `/tenants/${failure.space.tenant_id}/ownership-transfers/${pending.transfer_id}/accept`, failure.right.session, {
      accept_scope: true, fresh_auth_verification_id: failureVerification,
    }, `"${pending.version}"`);
    assert.equal(changed.status, 409, JSON.stringify(changed.data));
    assert.equal(changed.data.code, 'transfer_authority_changed');
    assert.equal((await transferState(pending.transfer_id)).state, 'invalidated');
  });

  test('T-024 my transfer and recovery lists cross two tenants and stop at the caller', async () => {
    const makerA = await person('甲擁有者');
    const makerB = await person('乙擁有者');
    const recipient = await person('跨空間接收者');
    const stranger = await person('另一位接收者');
    const memberA = await person('甲的成員');
    const spaceA = await createTenant(makerA.session, '清單甲');
    const spaceB = await createTenant(makerB.session, '清單乙');
    const spaceC = await createTenant(makerA.session, '清單丙');
    const recipientPrincipal = await candidate(makerA.session, recipient.id);
    const strangerPrincipal = await candidate(makerA.session, stranger.id);
    const memberPrincipal = await candidate(makerA.session, memberA.id);
    await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'viewer','active',clock_timestamp())`, [spaceA.tenant_id, memberPrincipal]);
    const transferA = await propose(makerA.session, spaceA.tenant_id, recipientPrincipal);
    const transferB = await propose(makerB.session, spaceB.tenant_id, recipientPrincipal);
    const transferC = await propose(makerA.session, spaceC.tenant_id, strangerPrincipal);
    const mine = await member('GET', '/me/tenant-ownership-transfers', recipient.session);
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    const mineIds = mine.data.items.map((item: { transfer_id: string }) => item.transfer_id).sort();
    assert.deepEqual(mineIds, [transferA.transfer_id, transferB.transfer_id].sort());
    const names = new Map(mine.data.items.map((item: { transfer_id: string; tenant_display_name: string }) => [item.transfer_id, item.tenant_display_name]));
    assert.equal(names.get(transferA.transfer_id), '清單甲');
    assert.equal(names.get(transferB.transfer_id), '清單乙');
    const strangerMine = await member('GET', '/me/tenant-ownership-transfers', stranger.session);
    assert.equal(strangerMine.status, 200, JSON.stringify(strangerMine.data));
    assert.deepEqual(strangerMine.data.items.map((item: { transfer_id: string }) => item.transfer_id), [transferC.transfer_id]);
    const hiddenList = await member('GET', `/tenants/${spaceB.tenant_id}/ownership-transfers`, memberA.session);
    const hiddenOne = await member('GET', `/tenants/${spaceB.tenant_id}/ownership-transfers/${transferB.transfer_id}`, memberA.session);
    assert.equal(hiddenList.status, 404, JSON.stringify(hiddenList.data));
    assert.equal(hiddenList.data.code, 'transfer_not_found');
    assert.equal(hiddenOne.status, 404, JSON.stringify(hiddenOne.data));
    assert.equal(hiddenOne.data.code, 'transfer_not_found');
    const bound = await bindSql(null, recipientPrincipal);
    const visibleTenants = (await (async () => {
      const q = await runtime.connect();
      try {
        await q.query('BEGIN');
        await q.query(bound.sql, bound.params);
        const rows = (await q.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenants ORDER BY tenant_id`)).rows.map(row => row.tenant_id);
        await q.query('ROLLBACK');
        return rows;
      } finally { q.release(); }
    })()).sort();
    assert.deepEqual(visibleTenants, [spaceA.tenant_id, spaceB.tenant_id].sort());

    assert.equal((await adminCall(admins.opener, 'POST', `/members/${makerA.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1')).status, 200);
    assert.equal((await adminCall(admins.opener, 'POST', `/members/${makerB.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1')).status, 200);
    const openedA = await adminCall(admins.opener, 'POST', '/tenant-recovery-cases', {
      tenant_id: spaceA.tenant_id, proposed_owner_principal_id: recipientPrincipal, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
    });
    const openedB = await adminCall(admins.opener, 'POST', '/tenant-recovery-cases', {
      tenant_id: spaceB.tenant_id, proposed_owner_principal_id: recipientPrincipal, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
    });
    assert.equal(openedA.status, 201, JSON.stringify(openedA.data));
    assert.equal(openedB.status, 201, JSON.stringify(openedB.data));
    const cases = await member('GET', '/me/tenant-recovery-cases', recipient.session);
    assert.equal(cases.status, 200, JSON.stringify(cases.data));
    const caseIds = cases.data.items.map((item: { case_id: string }) => item.case_id).sort();
    assert.deepEqual(caseIds, [openedA.data.case_id, openedB.data.case_id].sort());
    const caseNames = new Map(cases.data.items.map((item: { case_id: string; tenant_display_name: string }) => [item.case_id, item.tenant_display_name]));
    assert.equal(caseNames.get(openedA.data.case_id), '清單甲');
    assert.equal(caseNames.get(openedB.data.case_id), '清單乙');
    const memberCases = await member('GET', '/me/tenant-recovery-cases', memberA.session);
    assert.equal(memberCases.status, 200, JSON.stringify(memberCases.data));
    assert.deepEqual(memberCases.data.items, []);
    assert.equal(memberCases.data.source_version, '1');
    const memberAccept = await member('POST', `/me/tenant-recovery-cases/${openedB.data.case_id}/accept`, memberA.session, {
      accept_scope: true, fresh_auth_verification_id: randomUUID(),
    }, '"1"');
    assert.equal(memberAccept.status, 404, JSON.stringify(memberAccept.data));
    assert.equal(memberAccept.data.code, 'recovery_case_not_found');
    await quiet();
  });

  test('T-024 an admin with the capability opens, reads, approves, executes and closes, and a bare admin is refused', async () => {
    const maker = await person('復原擁有者');
    const recipient = await person('復原接收者');
    const next = await person('下一個接收者');
    const tenant = await createTenant(maker.session, '復原空間');
    const other = await createTenant(next.session, '關閉空間');
    const to = await candidate(maker.session, recipient.id);
    assert.equal((await adminCall(admins.opener, 'POST', `/members/${maker.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1')).status, 200);
    assert.equal((await adminCall(admins.opener, 'POST', `/members/${next.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1')).status, 200);
    const bare = await adminCall(admins.bare, 'POST', '/tenant-recovery-cases', {
      tenant_id: tenant.tenant_id, proposed_owner_principal_id: to, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
    });
    assert.equal(bare.status, 403, JSON.stringify(bare.data));
    assert.equal(bare.data.code, 'recovery_authority_required');
    const opened = await adminCall(admins.opener, 'POST', '/tenant-recovery-cases', {
      tenant_id: tenant.tenant_id, proposed_owner_principal_id: to, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.data));
    assert.equal(opened.data.state, 'evidence_required');
    const seen = await adminCall(admins.reviewer, 'GET', `/tenant-recovery-cases/${opened.data.case_id}`);
    assert.equal(seen.status, 200, JSON.stringify(seen.data));
    assert.equal(seen.data.case_id, opened.data.case_id);
    assert.equal(seen.data.tenant_id, tenant.tenant_id);
    assert.equal(typeof seen.data.evidence_ref, 'string');
    const approved = await adminCall(admins.reviewer, 'POST', `/tenant-recovery-cases/${opened.data.case_id}/approve`, {
      approved_scope: ['tenant.owner.restore'], expires_at: later(6), reason: '證據足夠，核准恢復擁有者',
    }, '1');
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.version, '2');
    const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.recovery.accept');
    const accepted = await member('POST', `/me/tenant-recovery-cases/${opened.data.case_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: verificationId,
    }, '"2"');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.version, '3');
    assert.equal(accepted.data.recipient_accepted, true);
    const executed = await adminCall(admins.executor, 'POST', `/tenant-recovery-cases/${opened.data.case_id}/execute`, {}, '3');
    assert.equal(executed.status, 200, JSON.stringify(executed.data));
    assert.equal(executed.data.case?.state, 'executed');
    assert.equal(await tenantStatus(tenant.tenant_id), 'active');
    const ownerRow = (await owner.query<{ principal_id: string; status: string }>(
      `SELECT m.principal_id, m.status FROM tenant_memberships m
       WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active'`, [tenant.tenant_id])).rows;
    assert.deepEqual(ownerRow.map(row => row.principal_id), [to]);
    const terminal = await adminCall(admins.reviewer, 'POST', `/tenant-recovery-cases/${opened.data.case_id}/close`, { decision: 'cancelled', reason: '復原已執行，不能再關閉' }, '4');
    assert.equal(terminal.status, 409, JSON.stringify(terminal.data));
    assert.equal(terminal.data.code, 'recovery_case_terminal');
    const second = await adminCall(admins.opener, 'POST', '/tenant-recovery-cases', {
      tenant_id: other.tenant_id, proposed_owner_principal_id: to, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
    });
    assert.equal(second.status, 201, JSON.stringify(second.data));
    const closed = await adminCall(admins.reviewer, 'POST', `/tenant-recovery-cases/${second.data.case_id}/close`, { decision: 'cancelled', reason: '這次復原取消' }, '1');
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.equal(closed.data.state, 'cancelled');
    assert.equal((await owner.query<{ state: string }>(`SELECT state FROM tenant_recovery_cases WHERE case_id=$1`, [second.data.case_id])).rows[0].state, 'cancelled');
  });

  test('T-024 a bound insert is stored and a row for another tenant is rejected', async () => {
    const maker = await person('插入擁有者');
    const recipient = await person('插入接收者');
    const spaceA = await createTenant(maker.session, '插入甲');
    const spaceB = await createTenant(maker.session, '插入乙');
    const to = await candidate(maker.session, recipient.id);
    const from = spaceA.my_membership.principal_id;
    const sessionHash = (await owner.query<{ token_hash: string }>(
      `SELECT token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [maker.id])).rows[0].token_hash;
    await owner.query(`UPDATE tenants SET status='recovery_required' WHERE tenant_id=$1`, [spaceB.tenant_id]);
    const highRisk = `INSERT INTO tenant_high_risk_verifications(user_id,principal_id,session_hash,tenant_id,purpose,expires_at)
      VALUES($1,$2,$3,$4,'tenant.ownership.propose',clock_timestamp()+interval '10 minutes') RETURNING verification_id`;
    const transfer = `INSERT INTO tenant_ownership_transfers(tenant_id,from_principal_id,to_principal_id,from_role_after,state,expires_at,tenant_authorization_revision,reason)
      VALUES($1,$2,$3,'admin','pending',clock_timestamp()+interval '1 hour',1,$4) RETURNING transfer_id`;
    const recovery = `INSERT INTO tenant_recovery_cases(tenant_id,state,proposed_owner_principal_id,reason,evidence_ref,opened_by_admin_id)
      VALUES($1,'evidence_required',$2,$3,$4,$5) RETURNING case_id`;
    const beforeCounts = {
      verifications: await countWhere(`SELECT count(*)::int AS n FROM tenant_high_risk_verifications`, []),
      transfers: await countWhere(`SELECT count(*)::int AS n FROM tenant_ownership_transfers`, []),
      cases: await countWhere(`SELECT count(*)::int AS n FROM tenant_recovery_cases`, []),
    };
    async function inserted(setup: { sql: string; params: unknown[] }, statement: string, params: unknown[]) {
      const q = await runtime.connect();
      try {
        await q.query('BEGIN');
        try {
          await q.query(setup.sql, setup.params);
          return (await q.query(statement, params)).rows[0];
        } finally { await q.query('ROLLBACK'); }
      } finally { q.release(); }
    }
    assert.ok(await inserted(await bindSql(spaceA.tenant_id, from), highRisk, [maker.id, from, sessionHash, spaceA.tenant_id]));
    assert.ok(await inserted(await bindSql(spaceA.tenant_id, from), transfer, [spaceA.tenant_id, from, to, '執行期插入']));
    assert.ok(await inserted(await bindSql(spaceB.tenant_id, to), recovery, [spaceB.tenant_id, to, '執行期復原', randomUUID(), admins.opener.id]));
    const wrongVerification = await runtimeFailure((await bindSql(spaceA.tenant_id, from)).sql, (await bindSql(spaceA.tenant_id, from)).params, highRisk, [maker.id, from, sessionHash, spaceB.tenant_id]);
    assert.equal(wrongVerification.code, '42501', wrongVerification.message);
    const wrongTransferBound = await runtimeFailure((await bindSql(spaceA.tenant_id, from)).sql, (await bindSql(spaceA.tenant_id, from)).params, transfer, [spaceB.tenant_id, from, to, '跨租戶移交']);
    const wrongRecoveryBound = await runtimeFailure((await bindSql(spaceA.tenant_id, from)).sql, (await bindSql(spaceA.tenant_id, from)).params, recovery, [spaceB.tenant_id, to, '跨租戶復原', randomUUID(), admins.opener.id]);
    console.log(JSON.stringify({
      check: 'b2a_cross_tenant_insert',
      transfer: wrongTransferBound.code, transfer_message: wrongTransferBound.message,
      recovery: wrongRecoveryBound.code, recovery_message: wrongRecoveryBound.message,
    }));
    // Those BEFORE INSERT triggers read tenants as the invoker, before WITH CHECK.
    // Another tenant's context hides the row, so the trigger raises 23514.
    assert.equal(wrongTransferBound.code, '23514', wrongTransferBound.message);
    assert.match(wrongTransferBound.message, /tenant is missing/);
    assert.equal(wrongRecoveryBound.code, '23514', wrongRecoveryBound.message);
    assert.match(wrongRecoveryBound.message, /recovery_required/);
    const unboundTransfer = await runtimeFailure((await bindSql(null, from)).sql, (await bindSql(null, from)).params, transfer, [spaceA.tenant_id, from, to, '未綁租戶移交']);
    const unboundRecovery = await runtimeFailure((await bindSql(null, from)).sql, (await bindSql(null, from)).params, recovery, [spaceB.tenant_id, to, '未綁租戶復原', randomUUID(), admins.opener.id]);
    assert.equal(unboundTransfer.code, '42501', unboundTransfer.message);
    assert.equal(unboundRecovery.code, '42501', unboundRecovery.message);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_high_risk_verifications`, []), beforeCounts.verifications);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_ownership_transfers`, []), beforeCounts.transfers);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_recovery_cases`, []), beforeCounts.cases);
    await quiet();
  });

  function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  async function sessionHashOf(userId: string) {
    return (await owner.query<{ token_hash: string }>(
      `SELECT token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0].token_hash;
  }
  async function expiredProof(userId: string, principalId: string, tenantId: string, purpose: string) {
    return (await owner.query<{ verification_id: string }>(`INSERT INTO tenant_high_risk_verifications(user_id,principal_id,session_hash,tenant_id,purpose,verified_at,expires_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute') RETURNING verification_id`,
    [userId, principalId, await sessionHashOf(userId), tenantId, purpose])).rows[0].verification_id;
  }
  async function authorityFootprint(tenantId: string) {
    const tenantRow = (await owner.query<{ status: string; revision: string }>(
      `SELECT status, authorization_revision::text AS revision FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
    const memberships = (await owner.query(`SELECT principal_id, role, status, version::text AS version FROM tenant_memberships WHERE tenant_id=$1 ORDER BY principal_id`, [tenantId])).rows;
    const counts = (await owner.query<{ audit: number; receipts: number; outbox: number; journal: number }>(`SELECT
      (SELECT count(*)::int FROM tenant_authority_audit WHERE tenant_id=$1) AS audit,
      (SELECT count(*)::int FROM scoped_command_receipts) AS receipts,
      (SELECT count(*)::int FROM scoped_outbox) AS outbox,
      (SELECT count(*)::int FROM scoped_transition_journal) AS journal`, [tenantId])).rows[0];
    return { tenant: tenantRow, memberships, counts };
  }
  async function recoveryFootprint(tenantId: string, caseId: string) {
    const tenantRow = (await owner.query<{ status: string; revision: string }>(
      `SELECT status, authorization_revision::text AS revision FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
    const memberships = (await owner.query(`SELECT principal_id, role, status FROM tenant_memberships WHERE tenant_id=$1 ORDER BY principal_id`, [tenantId])).rows;
    const recovery = (await owner.query(`SELECT state, version::text AS version, recipient_accepted_at IS NOT NULL AS accepted FROM tenant_recovery_cases WHERE case_id=$1`, [caseId])).rows[0];
    const counts = (await owner.query<{ audit: number; outbox: number }>(`SELECT
      (SELECT count(*)::int FROM tenant_authority_audit WHERE tenant_id=$1) AS audit,
      (SELECT count(*)::int FROM scoped_outbox o JOIN resource_scopes s ON s.scope_id=o.scope_id WHERE s.tenant_ref=$1) AS outbox`, [tenantId])).rows[0];
    return { tenant: tenantRow, memberships, recovery, counts };
  }
  async function blockedBy(pid: number) {
    for (let i = 0; i < 400; i += 1) {
      const waiting = (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0].n;
      if (waiting >= 1) return;
      await delay(25);
    }
    assert.fail(`expected a waiter on ${pid}`);
  }
  async function raceDisable(userA: string, userB: string) {
    const clients = new Pool({
      connectionString: roleUrl(runtimeRole),
      options: `-c search_path=${schema} -c statement_timeout=60000`,
      max: 2,
    });
    clients.on('error', () => undefined);
    const clientA = await clients.connect();
    const clientB = await clients.connect();
    let failed: unknown;
    let holder: 'a' | 'b' | null = null;
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      await clientA.query('UPDATE users SET active=false WHERE user_id=$1', [userA]);
      await clientB.query('UPDATE users SET active=false WHERE user_id=$1', [userB]);
      const pidA = (await clientA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pidB = (await clientB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const done = { a: false, b: false };
      const pathA = applyOwnerAccountStatus(clientA, userA, false).then(() => { done.a = true; }, error => { failed = error; done.a = true; });
      const pathB = applyOwnerAccountStatus(clientB, userB, false).then(() => { done.b = true; }, error => { failed = error; done.b = true; });
      for (let i = 0; i < 200 && !failed; i += 1) {
        const blockedByA = (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND $1=ANY(pg_blocking_pids(pid))', [pidA, pidB])).rowCount ?? 0;
        const blockedByB = (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND $1=ANY(pg_blocking_pids(pid))', [pidB, pidA])).rowCount ?? 0;
        if (blockedByA > 0 && blockedByB > 0) throw new Error('deadlock: each security path is waiting on the other');
        if (blockedByA > 0) { holder = 'a'; break; }
        if (blockedByB > 0) { holder = 'b'; break; }
        if (done.a && done.b) break;
        await delay(20);
      }
      if (failed) throw failed;
      if (holder === 'a') { await pathA; await clientA.query('COMMIT'); await pathB; await clientB.query('COMMIT'); }
      else if (holder === 'b') { await pathB; await clientB.query('COMMIT'); await pathA; await clientA.query('COMMIT'); }
      else { await pathA; await pathB; await clientA.query('COMMIT'); await clientB.query('COMMIT'); }
      if (failed) throw failed;
      return holder;
    } finally {
      await clientA.query('ROLLBACK').catch(() => undefined);
      await clientB.query('ROLLBACK').catch(() => undefined);
      clientA.release();
      clientB.release();
      await clients.end();
    }
  }
  async function loginableOwners(tenantId: string) {
    return (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships m
      JOIN principals p ON p.principal_id=m.principal_id AND p.status='active'
      JOIN users u ON u.user_id=p.user_ref AND u.active
      WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active'`, [tenantId])).rows[0].n;
  }
  async function recoveryEvents(tenantId: string) {
    return countWhere(`SELECT count(*)::int AS n FROM scoped_outbox o JOIN resource_scopes s ON s.scope_id=o.scope_id
      WHERE s.tenant_ref=$1 AND o.event_type='freedom.tenant.recovery.required.v1'`, [tenantId]);
  }

  test('T-024 an expired fresh proof is refused and a current proof still succeeds', async () => {
    const maker = await person('期限擁有者');
    const recipient = await person('期限接收者');
    const tenant = await createTenant(maker.session, '期限空間');
    const to = await candidate(maker.session, recipient.id);
    const from = tenant.my_membership.principal_id;
    const transfersBefore = await countWhere(`SELECT count(*)::int AS n FROM tenant_ownership_transfers WHERE tenant_id=$1`, [tenant.tenant_id]);
    const expiredPropose = await expiredProof(maker.id, from, tenant.tenant_id, 'tenant.ownership.propose');
    const deniedPropose = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers`, maker.session, {
      to_principal_id: to, from_role_after: 'admin', expires_at: later(), reason: '交給下一位擁有者', fresh_auth_verification_id: expiredPropose,
    });
    assert.equal(deniedPropose.status, 403, JSON.stringify(deniedPropose.data));
    assert.equal(deniedPropose.data.code, 'fresh_auth_required');
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_ownership_transfers WHERE tenant_id=$1`, [tenant.tenant_id]), transfersBefore);
    const proposed = await propose(maker.session, tenant.tenant_id, to);
    assert.equal(proposed.state, 'pending');

    const beforeAccept = await authorityFootprint(tenant.tenant_id);
    const transferBefore = await transferState(proposed.transfer_id);
    const expiredAccept = await expiredProof(recipient.id, to, tenant.tenant_id, 'tenant.ownership.accept');
    const deniedAccept = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers/${proposed.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: expiredAccept,
    }, proposed.version);
    assert.equal(deniedAccept.status, 403, JSON.stringify(deniedAccept.data));
    assert.equal(deniedAccept.data.code, 'fresh_auth_required');
    assert.deepEqual(await authorityFootprint(tenant.tenant_id), beforeAccept);
    assert.deepEqual(await transferState(proposed.transfer_id), transferBefore);
    const acceptVerification = await verify(recipient.session, tenant.tenant_id, 'tenant.ownership.accept');
    const accepted = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers/${proposed.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: acceptVerification,
    }, proposed.version);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.my_role, 'owner');

    const recoveryOwner = await person('復原期限擁有者');
    const recoveryRecipient = await person('復原期限接收者');
    const recoveryTenant = await createTenant(recoveryOwner.session, '復原期限');
    const recoveryTo = await candidate(recoveryOwner.session, recoveryRecipient.id);
    assert.equal((await adminCall(admins.opener, 'POST', `/members/${recoveryOwner.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1')).status, 200);
    const opened = await adminCall(admins.opener, 'POST', '/tenant-recovery-cases', {
      tenant_id: recoveryTenant.tenant_id, proposed_owner_principal_id: recoveryTo, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.data));
    const approved = await adminCall(admins.reviewer, 'POST', `/tenant-recovery-cases/${opened.data.case_id}/approve`, {
      approved_scope: ['tenant.owner.restore'], expires_at: later(6), reason: '證據足夠，核准恢復擁有者',
    }, '1');
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const beforeRecovery = await recoveryFootprint(recoveryTenant.tenant_id, opened.data.case_id);
    const expiredRecovery = await expiredProof(recoveryRecipient.id, recoveryTo, recoveryTenant.tenant_id, 'tenant.recovery.accept');
    const deniedRecovery = await member('POST', `/me/tenant-recovery-cases/${opened.data.case_id}/accept`, recoveryRecipient.session, {
      accept_scope: true, fresh_auth_verification_id: expiredRecovery,
    }, '2');
    assert.equal(deniedRecovery.status, 403, JSON.stringify(deniedRecovery.data));
    assert.equal(deniedRecovery.data.code, 'fresh_auth_required');
    assert.deepEqual(await recoveryFootprint(recoveryTenant.tenant_id, opened.data.case_id), beforeRecovery);
    const currentRecovery = await verify(recoveryRecipient.session, recoveryTenant.tenant_id, 'tenant.recovery.accept');
    const acceptedRecovery = await member('POST', `/me/tenant-recovery-cases/${opened.data.case_id}/accept`, recoveryRecipient.session, {
      accept_scope: true, fresh_auth_verification_id: currentRecovery,
    }, '2');
    assert.equal(acceptedRecovery.status, 200, JSON.stringify(acceptedRecovery.data));
    assert.equal(acceptedRecovery.data.recipient_accepted, true);
  });

  test('T-024 accept refuses a disabled target tenant scope, including a replay', async () => {
    const maker = await person('範圍擁有者');
    const recipient = await person('範圍接收者');
    const tenant = await createTenant(maker.session, '範圍空間');
    const to = await candidate(maker.session, recipient.id);
    const proposed = await propose(maker.session, tenant.tenant_id, to);
    const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.ownership.accept');
    await owner.query(`UPDATE resource_scopes SET status='disabled' WHERE kind='tenant' AND tenant_ref=$1`, [tenant.tenant_id]);
    const before = await authorityFootprint(tenant.tenant_id);
    const transferBefore = await transferState(proposed.transfer_id);
    const denied = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers/${proposed.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: verificationId,
    }, proposed.version);
    assert.equal(denied.status, 403, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'scope_disabled');
    assert.notEqual(denied.status, 404);
    assert.notEqual(denied.status, 500);
    assert.deepEqual(await authorityFootprint(tenant.tenant_id), before);
    assert.deepEqual(await transferState(proposed.transfer_id), transferBefore);
    await owner.query(`UPDATE resource_scopes SET status='active' WHERE kind='tenant' AND tenant_ref=$1`, [tenant.tenant_id]);
    const key = randomUUID();
    const accepted = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers/${proposed.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: verificationId,
    }, proposed.version, key);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.my_role, 'owner');
    const afterAccept = await authorityFootprint(tenant.tenant_id);
    const acceptedTransfer = await transferState(proposed.transfer_id);
    await owner.query(`UPDATE resource_scopes SET status='disabled' WHERE kind='tenant' AND tenant_ref=$1`, [tenant.tenant_id]);
    const replay = await member('POST', `/tenants/${tenant.tenant_id}/ownership-transfers/${proposed.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: verificationId,
    }, proposed.version, key);
    assert.equal(replay.status, 403, JSON.stringify(replay.data));
    assert.equal(replay.data.code, 'scope_disabled');
    assert.notEqual(replay.status, 404);
    assert.notEqual(replay.status, 500);
    assert.deepEqual(await authorityFootprint(tenant.tenant_id), afterAccept);
    assert.deepEqual(await transferState(proposed.transfer_id), acceptedTransfer);
  });

  test('T-024 execute refuses a capability revoked while the tenant row is locked', async () => {
    const maker = await person('鎖擁有者');
    const recipient = await person('鎖接收者');
    const tenant = await createTenant(maker.session, '鎖空間');
    const to = await candidate(maker.session, recipient.id);
    assert.equal((await adminCall(admins.opener, 'POST', `/members/${maker.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1')).status, 200);
    const opened = await adminCall(admins.opener, 'POST', '/tenant-recovery-cases', {
      tenant_id: tenant.tenant_id, proposed_owner_principal_id: to, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.data));
    assert.equal((await adminCall(admins.reviewer, 'POST', `/tenant-recovery-cases/${opened.data.case_id}/approve`, {
      approved_scope: ['tenant.owner.restore'], expires_at: later(6), reason: '證據足夠，核准恢復擁有者',
    }, '1')).status, 200);
    const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.recovery.accept');
    const accepted = await member('POST', `/me/tenant-recovery-cases/${opened.data.case_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: verificationId,
    }, '2');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    const before = await recoveryFootprint(tenant.tenant_id, opened.data.case_id);
    const holder = await owner.connect();
    let released = false;
    try {
      await holder.query('BEGIN');
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [tenant.tenant_id]);
      const pending = adminCall(admins.executor, 'POST', `/tenant-recovery-cases/${opened.data.case_id}/execute`, {}, '3');
      await blockedBy(pid);
      await owner.query(`UPDATE platform_admin_tenant_recovery_capabilities SET revoked_at=clock_timestamp()
        WHERE admin_id=$1 AND capability='tenant.recovery.execute' AND revoked_at IS NULL`, [admins.executor.id]);
      await holder.query('COMMIT');
      released = true;
      const denied = await Promise.race([pending, delay(20000).then(() => { throw new Error('execute did not finish'); })]);
      assert.equal(denied.status, 403, JSON.stringify(denied.data));
      assert.equal(denied.data.code, 'recovery_authority_required');
      assert.equal(JSON.stringify(denied.data).includes(opened.data.case_id), false);
    } finally {
      if (!released) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    assert.deepEqual(await recoveryFootprint(tenant.tenant_id, opened.data.case_id), before);
  });

  test('T-024 two owners disabled before either commit still require recovery', async () => {
    const maker = await person('競態擁有者');
    const other = await person('競態另一位');
    const tenant = await createTenant(maker.session, '競態空間');
    const otherPrincipal = await candidate(maker.session, other.id);
    await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [tenant.tenant_id, otherPrincipal]);
    const holder = await raceDisable(maker.id, other.id);
    assert.equal(holder === 'a' || holder === 'b', true, `the two security paths did not serialize (holder=${String(holder)})`);
    assert.equal(await tenantStatus(tenant.tenant_id), 'recovery_required');
    assert.equal(await loginableOwners(tenant.tenant_id), 0);
    assert.equal(await recoveryEvents(tenant.tenant_id), 1);
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_authority_audit WHERE tenant_id=$1 AND reason_code='owner_account_disabled'`, [tenant.tenant_id]), 1);
  });

  test('T-024 two co-owned tenants disabled together do not deadlock', async () => {
    const maker = await person('雙空間擁有者');
    const other = await person('雙空間另一位');
    const first = await createTenant(maker.session, '雙空間甲');
    const second = await createTenant(maker.session, '雙空間乙');
    const otherPrincipal = await candidate(maker.session, other.id);
    await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [first.tenant_id, otherPrincipal]);
    await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [second.tenant_id, otherPrincipal]);
    await raceDisable(maker.id, other.id);
    assert.equal(await tenantStatus(first.tenant_id), 'recovery_required');
    assert.equal(await tenantStatus(second.tenant_id), 'recovery_required');
    assert.equal(await loginableOwners(first.tenant_id), 0);
    assert.equal(await loginableOwners(second.tenant_id), 0);
    assert.equal(await recoveryEvents(first.tenant_id), 1);
    assert.equal(await recoveryEvents(second.tenant_id), 1);
  });

  test('T-024 the deferred owner check sees the bound tenant and rejects the last owner at commit', async () => {
    const maker = await person('檢查擁有者');
    const other = await person('檢查另一位');
    const tenant = await createTenant(maker.session, '檢查空間');
    const otherPrincipal = await candidate(maker.session, other.id);
    await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [tenant.tenant_id, otherPrincipal]);
    const makerPrincipal = tenant.my_membership.principal_id;
    const scopeId = (await owner.query<{ scope_id: string }>(
      `SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1`, [tenant.tenant_id])).rows[0].scope_id;
    async function asTenant(principalId: string, statement: string, params: unknown[]) {
      const q = await runtime.connect();
      let updateCode = 'ok';
      let commitCode = 'committed';
      try {
        await q.query('BEGIN');
        await q.query(`SELECT pg_catalog.set_config('freedom.principal_id', $1, true),
                              pg_catalog.set_config('freedom.tenant_id', $2, true),
                              pg_catalog.set_config('freedom.tenant_scope_id', $3, true)`, [principalId, tenant.tenant_id, scopeId]);
        try {
          await q.query(statement, params);
        } catch (error) {
          updateCode = pgError(error).code ?? 'error';
          throw error;
        }
        await q.query('COMMIT');
      } catch (error) {
        if (updateCode === 'ok') commitCode = pgError(error).code ?? 'unknown';
        await q.query('ROLLBACK').catch(() => undefined);
      } finally { q.release(); }
      return { updateCode, commitCode };
    }
    const kept = await asTenant(makerPrincipal,
      `UPDATE tenant_memberships SET role='admin', updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`,
      [tenant.tenant_id, makerPrincipal]);
    assert.equal(kept.updateCode, 'ok');
    assert.equal(kept.commitCode, 'committed');
    assert.equal((await owner.query<{ role: string }>(`SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, makerPrincipal])).rows[0].role, 'admin');
    assert.equal((await owner.query<{ role: string }>(`SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, otherPrincipal])).rows[0].role, 'owner');
    const denied = await asTenant(otherPrincipal,
      `UPDATE tenant_memberships SET role='viewer', updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`,
      [tenant.tenant_id, otherPrincipal]);
    assert.equal(denied.updateCode, 'ok');
    assert.equal(denied.commitCode, '23514');
    assert.equal((await owner.query<{ role: string }>(`SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, otherPrincipal])).rows[0].role, 'owner');
    await quiet();
  });

  test('T-024 disabling a co-owner invalidates the transfer that person sent in the tenant that stays active', async () => {
    const holder = await person('共同寄出者');
    const coOwner = await person('共同留下者');
    const recipient = await person('共同接收者');
    const shared = await createTenant(holder.session, '共同空間');
    const coPrincipal = await candidate(holder.session, coOwner.id);
    const recipientPrincipal = await candidate(holder.session, recipient.id);
    await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [shared.tenant_id, coPrincipal]);
    const sent = await propose(holder.session, shared.tenant_id, recipientPrincipal);
    const verificationId = await verify(recipient.session, shared.tenant_id, 'tenant.ownership.accept');
    const revisionBefore = (await owner.query<{ revision: string }>(
      `SELECT authorization_revision::text AS revision FROM tenants WHERE tenant_id=$1`, [shared.tenant_id])).rows[0].revision;
    const disabled = await adminCall(admins.opener, 'POST', `/members/${holder.id}/status`, { active: false, reason: '會員要求暫停帳號。' }, '1');
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
    const afterDisable = (await owner.query<{ status: string; revision: string; state: string; version: string }>(`SELECT t.status, t.authorization_revision::text AS revision, tr.state, tr.version::text AS version
      FROM tenants t JOIN tenant_ownership_transfers tr ON tr.tenant_id=t.tenant_id WHERE tr.transfer_id=$1`, [sent.transfer_id])).rows[0];
    assert.equal(afterDisable.status, 'active');
    assert.equal(afterDisable.revision, revisionBefore);
    assert.equal(afterDisable.state, 'invalidated');
    assert.equal(afterDisable.version, String(Number(sent.version) + 1));
    const restored = await adminCall(admins.opener, 'POST', `/members/${holder.id}/status`, { active: true, reason: '會員要求恢復帳號。' }, '2');
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(await tenantStatus(shared.tenant_id), 'active');
    assert.equal((await transferState(sent.transfer_id)).state, 'invalidated');
    const denied = await member('POST', `/tenants/${shared.tenant_id}/ownership-transfers/${sent.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: verificationId,
    }, sent.version);
    assert.equal(denied.status, 409, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'transfer_authority_changed');
    assert.equal((await transferState(sent.transfer_id)).state, 'invalidated');
    assert.equal(await countWhere(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [shared.tenant_id]), 2);
  });
});
