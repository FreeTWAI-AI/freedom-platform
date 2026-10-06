import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import type { CreateExecutionGrantInput, ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { createServer } from 'node:http';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createLocalFixtureModelStepHost, createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_machine_text_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const options = { environment: 'local' as const, clientId: 'agent-kit' };
const api = createExecutionPrerequisites(app, options), runs = createExecutionRuns(app);
const works = createPrivateWorkCommands(app, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
const enrollment = createRuntimeRegistrations(app, { environment: options.environment }), connections = createAgentConnections(app, options);
const selection: ModelSelection = { providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' };
const community = randomUUID(); let created = false;
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true; await migrate(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try { await q.query(prefix); const rows = await q.query(grants); assert.equal(rows.rowCount, 2);
    for(const row of rows.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT'); }
  catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
});
after(async () => { await app.end(); await owner.end(); try {
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);
} finally { await admin.end(); } });
beforeEach(async () => { await owner.query('TRUNCATE communities CASCADE'); await owner.query("INSERT INTO communities VALUES($1,'Synthetic prerequisites')", [community]); });
const status = (value: number) => (error: unknown) => error instanceof Problem && error.status === value;
const sqlCode = (...values: string[]) => (error: unknown) => values.includes((error as { code?: string }).code ?? '');
async function count(table: string) { return (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n; }
const tracked = ['model_connections','execution_grants','execution_attempts','scoped_transition_journal','scoped_outbox','scoped_command_receipts'];
const counts = () => Promise.all(tracked.map(count));
async function member() {
  const user = randomUUID(), session = randomUUID();
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q,c) => c);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id, context.subject_principal.principal_id]);
  return { actor, context };
}
async function fixture() {
  const f = await member(), pair = await generateKeyPair('ES256', { extractable: true });
  const challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk: parseRuntimePublicJwk(await exportJWK(pair.publicKey)) });
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(pair.privateKey);
  const device = await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  const connection = await connections.create(f.actor, { key: randomUUID(), runtimeDeviceId: device.runtimeDeviceId });
  // Real 091 initial family/head built through its server composition helper.
  // No model evidence or machine execution credentials are fabricated.
  const family = await transaction(app, q => insertInitialRefreshFamily(q, connection.connectionId, new Date(connection.issuedAt), new Date(connection.expiresAt)));
  const work = await works.create(f.actor, { key: randomUUID(), title: 'Synthetic private goal', objective: 'PRIVATE_BODY_NOT_IN_PREREQUISITES' });
  const run = await runs.create(f.actor, { key: randomUUID(), workId: work.workId, expectedWorkVersion: '1' });
  const modelInput = { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection };
  const model = await api.models.create(f.actor, modelInput);
  const grantInput: CreateExecutionGrantInput = { key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: '1',
    connectionId: connection.connectionId, expectedConnectionVersion: '1', modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true };
  return { ...f, pair, device, connection, family, work, run, model, modelInput, grantInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const attemptInput = (f: Fixture, grantId: string) => ({ key: randomUUID(), runId: f.run.runId, grantId, expectedRunVersion: '1', expectedGrantVersion: '1' });
async function currentGrant(f: Fixture) { return api.grants.create(f.actor, f.grantInput); }
async function policyOff(f: Fixture) { await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1 WHERE scope_id=$1', [f.context.scope.scope_id]); }
async function blocking(q: PoolClient) {
  const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i=0;i<200;i++) { if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return; await delay(10); }
  assert.fail('Actual PostgreSQL lock wait not observed');
}

let gets=0,posts=0,credentialExpires=()=>new Date(Date.now()+60000).toISOString(),generation='7';
const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.headers.authorization!=='Bearer synthetic-not-a-provider-key'){res.statusCode=401;res.end('{}');return;}
  if(req.method==='GET'){gets++;res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic-fixture'}));return;}
  posts++;let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const parsed=JSON.parse(body);assert.equal(parsed.model,'synthetic-model');assert.equal(parsed.tools.length,0);
    res.end(JSON.stringify({id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',
      output:[{id:'synthetic-message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PRIVATE_SYNTHETIC_MODEL_OUTPUT',annotations:[]}]}],
      usage:{input_tokens:3,output_tokens:4,total_tokens:7}}));
  });
});
let host:ReturnType<typeof createLocalFixtureModelStepHost>,steps:ReturnType<typeof createModelStepService>;
before(async()=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
  host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,
    recover:async()=>({generation,expiresAt:credentialExpires()}),resolveCredential:async()=>({key:new TextEncoder().encode('synthetic-not-a-provider-key'),expiresAt:credentialExpires()})});
  steps=createModelStepService(app,{...options,host});});
after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
beforeEach(()=>{gets=0;posts=0;generation='7';credentialExpires=()=>new Date(Date.now()+60000).toISOString();});
async function approved() {
  const f=await fixture(),grant=await currentGrant(f);
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
    VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,[randomUUID(),f.context.scope.scope_id,f.context.subject_principal.principal_id,options.environment,options.clientId,JSON.stringify(selection)]);
  const input={key:randomUUID(),runId:f.run.runId,grantId:grant.grantId,expectedRunVersion:'1',expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true as const,maxOutputTokens:20};
  const approval=await steps.approvals.create(f.actor,input);return {...f,grant,approval,approvalInput:input};
}
const activateInput=(f:Awaited<ReturnType<typeof approved>>)=>({key:randomUUID(),approvalId:f.approval.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'});

// Real member preparation only; execution credentials are issued by the tested machine authority.
export {app,owner,admin,options,member,fixture,approved,activateInput,steps,host,api,runs,works,enrollment,connections,blocking,count,posts,gets};

export const setCredentialExpiry=(value:string)=>{credentialExpires=()=>value;};
