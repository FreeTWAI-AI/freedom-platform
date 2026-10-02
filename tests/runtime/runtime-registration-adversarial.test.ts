import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createRuntimeRegistrationChallenge } from '../../modules/agent-control/runtime-proof.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_runtime_adv_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const api = createRuntimeRegistrations(pool, { environment: 'local' });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } });
const status = (...values: number[]) => (error: unknown) => values.includes((error as { status?: number }).status ?? 0);
function keypair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' });
  assert.equal(kty,'EC');assert.equal(crv,'P-256');
  return { privateKey: pair.privateKey, publicJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: x!, y: y! } };
}
const encode = (value: string) => Buffer.from(value).toString('base64url');
const header = JSON.stringify({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' });
function proof(privateKey: KeyObject, payload: string, protectedHeader = header) {
  const signed = `${encode(protectedHeader)}.${encode(payload)}`;
  return `${signed}.${sign('sha256', Buffer.from(signed), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function member() {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic runtime review')", [community]);
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic runtime owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session,user]);
  const actor: Actor = { ...row, session_hash:session, csrf_token:'synthetic' };
  const context = await withMemberScope(pool, { actor, scope:'personal' }, async () => {}, async (_q,c) => c);
  return { actor, context };
}
async function fixture() {
  const f = await member(), keys = keypair(), input = { key:randomUUID(), publicJwk:keys.publicJwk };
  const challenge = await api.begin(f.actor,input);
  const confirm = { key:randomUUID(), challengeId:challenge.challenge_id, proof:proof(keys.privateKey,challenge.payload) };
  return { ...f, ...keys, input, challenge, confirm };
}
async function blocking(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i=0;i<300;i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL row-lock wait was not observed');
}
async function expired(actor: Actor) {
  for (let i=0;i<300;i++) {
    if ((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1',[actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('DB clock did not cross expiry');
}
async function counts() {
  return Promise.all(['runtime_registration_challenges','runtime_registrations','scoped_command_receipts','scoped_transition_journal','scoped_outbox']
    .map(async table => (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n));
}
async function nearExpiryFixture() {
  const f=await fixture();
  // A valid 300-second challenge issued in the past, inserted as synthetic
  // fixture data. Production constraints/triggers remain enabled throughout.
  const row=(await pool.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) now)
    INSERT INTO runtime_registration_challenges
    (challenge_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,begin_key,public_jwk,key_thumbprint,nonce,issued_at,expires_at)
    SELECT gen_random_uuid(),gen_random_uuid(),owner_user_id,owner_principal_id,scope_id,environment,gen_random_uuid()::text,
      public_jwk,key_thumbprint,nonce,stamp.now-interval '299 seconds',stamp.now+interval '1 second'
    FROM runtime_registration_challenges CROSS JOIN stamp WHERE challenge_id=$1 RETURNING *`,[f.challenge.challenge_id])).rows[0];
  const challenge=createRuntimeRegistrationChallenge({challenge_id:row.challenge_id,runtime_device_id:row.runtime_device_id,
    owner_member_id:row.owner_user_id,owner_principal_id:row.owner_principal_id,scope_id:row.scope_id,environment:row.environment,
    key_thumbprint:row.key_thumbprint,nonce:row.nonce,issued_at:row.issued_at.toISOString(),expires_at:row.expires_at.toISOString()});
  return {...f,challenge,confirm:{key:randomUUID(),challengeId:challenge.challenge_id,proof:proof(f.privateKey,challenge.payload)}};
}
async function challengeExpired(challengeId:string) {
  for(let i=0;i<300;i++) {
    if((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM runtime_registration_challenges WHERE challenge_id=$1',[challengeId])).rows[0].expired)return;
    await delay(10);
  }
  assert.fail('DB clock did not cross challenge expiry');
}

test('RUNTIME-ADV actual P-256 signature enrolls only a closed key-possession record; signed wrong bindings never enroll', async () => {
  const f = await fixture(), wrong = keypair();
  const parsed = JSON.parse(f.challenge.payload);
  const mutations = [
    { purpose:'execution' }, { environment:'next' }, { owner_member_id:randomUUID() },
    { owner_principal_id:randomUUID() }, { scope_id:randomUUID() }, { runtime_device_id:randomUUID() },
    { challenge_id:randomUUID() }, { nonce:Buffer.alloc(32,7).toString('base64url') },
    { key_thumbprint:Buffer.alloc(32,8).toString('base64url') }, { operational_authority:true },
  ];
  const bad = [proof(wrong.privateKey,f.challenge.payload),
    ...mutations.map(change => proof(f.privateKey,JSON.stringify({ ...parsed,...change }))),
    proof(f.privateKey,f.challenge.payload,JSON.stringify({ alg:'HS256',typ:'freedom-runtime-enrollment+jws' })),
    proof(f.privateKey,f.challenge.payload,'{"alg":"none","alg":"ES256","typ":"freedom-runtime-enrollment+jws"}'),
    proof(f.privateKey,f.challenge.payload,'{"alg":"ES256","\\u0061lg":"ES256","typ":"freedom-runtime-enrollment+jws"}'),
    proof(f.privateKey,f.challenge.payload.replace(/^\{/, '{"purpose":"runtime_enrollment",')),
    proof(f.privateKey,' '+f.challenge.payload),
  ];
  const before = await counts();
  for (const raw of bad) await assert.rejects(api.confirm(f.actor,{ ...f.confirm,key:randomUUID(),proof:raw }));
  assert.deepEqual(await counts(),before);
  const value = await api.confirm(f.actor,f.confirm);
  assert.equal(value.operational_authority,false);
  assert.equal(value.runtimeDeviceId,f.challenge.runtime_device_id);
});

test('RUNTIME-ADV base64url aliases and attacker supplied fields are rejected before any mutation', async () => {
  const f = await fixture(), parts = f.confirm.proof.split('.'), alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const signature=parts[2], last=alphabet.indexOf(signature.at(-1)!);
  assert.equal(last%16,0,'64-byte P1363 signature has four unused low bits');
  const alias=signature.slice(0,-1)+alphabet[last+1];
  assert.deepEqual(Buffer.from(alias,'base64url'),Buffer.from(signature,'base64url'));
  for (const raw of [parts.slice(0,2).join('.')+'.'+alias,f.confirm.proof+'=',f.confirm.proof+'.',f.confirm.proof+'\n',
    `${parts[0]}=.${parts[1]}.${signature}`, 'A'.repeat(20000)])
    await assert.rejects(api.confirm(f.actor,{ ...f.confirm,proof:raw }));
  for (const extra of [{ owner:f.actor.user_id },{ runtimeDeviceId:randomUUID() },{ environment:'next' },{ operational_authority:true }])
    await assert.rejects(api.begin(f.actor,{ ...f.input,key:randomUUID(),...extra }));
  for (const extra of [{ d:'secret-private-key' },{ alg:'ES256' },{ kid:'arbitrary' },{ use:'sig' }])
    await assert.rejects(api.begin(f.actor,{ key:randomUUID(),publicJwk:{ ...f.publicJwk,...extra } }));
  const x=f.publicJwk.x,lastX=alphabet.indexOf(x.at(-1)!);
  await assert.rejects(api.begin(f.actor,{ key:randomUUID(),publicJwk:{ ...f.publicJwk,x:x.slice(0,-1)+alphabet[lastX+1] } }));
  await assert.rejects(api.begin(f.actor,{ key:randomUUID(),publicJwk:{ ...f.publicJwk,x:Buffer.alloc(32).toString('base64url'),y:Buffer.alloc(32).toString('base64url') } }));
  assert.equal((await api.confirm(f.actor,f.confirm)).operational_authority,false);
});

test('RUNTIME-ADV pending public-key squatting cannot reserve another member key; only possession wins enrollment', async () => {
  const attacker=await member(), victim=await member(), keys=keypair();
  const squatted=await api.begin(attacker.actor,{key:randomUUID(),publicJwk:keys.publicJwk});
  const valid=await api.begin(victim.actor,{key:randomUUID(),publicJwk:keys.publicJwk});
  await assert.rejects(api.confirm(attacker.actor,{ key:randomUUID(),challengeId:squatted.challenge_id,proof:proof(keypair().privateKey,squatted.payload) }));
  const value=await api.confirm(victim.actor,{ key:randomUUID(),challengeId:valid.challenge_id,proof:proof(keys.privateKey,valid.payload) });
  assert.equal(value.runtimeDeviceId,valid.runtime_device_id);
  await assert.rejects(api.read(attacker.actor,{runtimeDeviceId:value.runtimeDeviceId}),status(404));
});

test('RUNTIME-ADV challenge consumption is single-use across keys while exact concurrent replay has one effect', async () => {
  const f=await fixture();
  const values=await Promise.all([api.confirm(f.actor,f.confirm),api.confirm(f.actor,f.confirm)]);
  assert.deepEqual(values[0],values[1]);
  await assert.rejects(api.confirm(f.actor,{...f.confirm,key:randomUUID()}),status(409));
  const g=await fixture();
  const results=await Promise.allSettled([api.confirm(g.actor,g.confirm),api.confirm(g.actor,{...g.confirm,key:randomUUID()})]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM runtime_registrations WHERE runtime_device_id=$1',[g.challenge.runtime_device_id])).rows[0].n,1);
});

test('RUNTIME-ADV owner authorization precedes successful receipt replay and unknown identities stay private', async () => {
  const f=await fixture(), peer=await member();
  const value=await api.confirm(f.actor,f.confirm);
  for (const challengeId of [f.challenge.challenge_id,randomUUID()])
    await assert.rejects(api.confirm(peer.actor,{...f.confirm,challengeId}),status(404));
  for (const runtimeDeviceId of [value.runtimeDeviceId,randomUUID()]) {
    await assert.rejects(api.read(peer.actor,{runtimeDeviceId}),status(404));
    await assert.rejects(api.revoke(peer.actor,{key:randomUUID(),runtimeDeviceId,expectedVersion:'1'}),status(404));
  }
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  await assert.rejects(api.confirm(f.actor,f.confirm),status(401));
  await assert.rejects(api.begin(f.actor,f.input),status(401));
  await assert.rejects(api.read(f.actor,{runtimeDeviceId:value.runtimeDeviceId}),status(401));
});

test('RUNTIME-ADV revoke uses CAS, keeps tombstones, and prevents enrolled receipt replays or new registration', async () => {
  const f=await fixture(), value=await api.confirm(f.actor,f.confirm);
  const input={key:randomUUID(),runtimeDeviceId:value.runtimeDeviceId,expectedVersion:'1'};
  await assert.rejects(api.revoke(f.actor,{...input,expectedVersion:'2'}),status(412));
  const results=await Promise.allSettled([api.revoke(f.actor,input),api.revoke(f.actor,{...input,key:randomUUID()})]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  await assert.rejects(api.confirm(f.actor,f.confirm),status(409));
  await assert.rejects(api.begin(f.actor,{...f.input,key:randomUUID()}),status(409));
  const peer=await member();
  await assert.rejects(api.begin(peer.actor,{...f.input,key:randomUUID()}),status(409));
  assert.equal((await api.read(f.actor,{runtimeDeviceId:value.runtimeDeviceId})).operational_authority,false);
});

test('RUNTIME-ADV public key reuse across host environments never accepts another environment proof', async () => {
  const f=await fixture(), next=createRuntimeRegistrations(pool,{environment:'next'});
  const second=await next.begin(f.actor,{key:randomUUID(),publicJwk:f.publicJwk});
  await assert.rejects(next.confirm(f.actor,{key:randomUUID(),challengeId:second.challenge_id,proof:f.confirm.proof}));
  await assert.rejects(next.confirm(f.actor,f.confirm),status(404));
  await api.confirm(f.actor,f.confirm);
  const value=await next.confirm(f.actor,{key:randomUUID(),challengeId:second.challenge_id,proof:proof(f.privateKey,second.payload)});
  assert.equal(value.operational_authority,false);
  await assert.rejects(api.read(f.actor,{runtimeDeviceId:value.runtimeDeviceId}),status(404));
});

for (const sink of ['scoped_command_receipts','scoped_transition_journal','scoped_outbox']) {
  test(`RUNTIME-ADV ${sink} failure rolls back challenge consume and registration atomically`,async()=>{
    const f=await fixture(), before=await counts();
    await pool.query("CREATE FUNCTION runtime_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic sink failure'; END $$");
    await pool.query(`CREATE TRIGGER runtime_test_fail BEFORE INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION runtime_test_fail()`);
    try { await assert.rejects(api.confirm(f.actor,f.confirm)); }
    finally { await pool.query(`DROP TRIGGER runtime_test_fail ON ${sink}`); await pool.query('DROP FUNCTION runtime_test_fail()'); }
    assert.deepEqual(await counts(),before);
    assert.equal((await pool.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1',[f.challenge.challenge_id])).rows[0].consumed_at,null);
    assert.equal((await api.confirm(f.actor,f.confirm)).operational_authority,false);
  });
}

test('RUNTIME-ADV raw JWS and private key never enter receipts/journal/outbox or registration columns',async()=>{
  const f=await fixture(); await api.confirm(f.actor,f.confirm);
  const forbidden=[f.confirm.proof,f.privateKey.export({format:'jwk'}).d!];
  for(const table of ['runtime_registration_challenges','runtime_registrations','scoped_command_receipts','scoped_transition_journal','scoped_outbox']) {
    const serialized=JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    for(const secret of forbidden) assert.ok(!serialized.includes(secret),`${table} leaked credential material`);
  }
});

test('RUNTIME-ADV confirmation rejects session expiry after an observed challenge row wait',async()=>{
  const f=await fixture(), holder=await pool.connect();
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1",[f.actor.session_hash]);
  await holder.query('BEGIN'); await holder.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE',[f.challenge.challenge_id]);
  const rejected=assert.rejects(api.confirm(f.actor,f.confirm),status(401));
  try { await blocking(holder); await expired(f.actor); } finally { await holder.query('ROLLBACK'); holder.release(); }
  await rejected;
  assert.equal((await pool.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1',[f.challenge.challenge_id])).rows[0].consumed_at,null);
});

test('RUNTIME-ADV revocation winning a real registration row race prevents confirmation receipt replay',async()=>{
  const f=await fixture(), value=await api.confirm(f.actor,f.confirm), holder=await pool.connect();
  await holder.query('BEGIN');
  await holder.query("UPDATE runtime_registrations SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=clock_timestamp() WHERE runtime_device_id=$1",[value.runtimeDeviceId]);
  const rejected=assert.rejects(api.confirm(f.actor,f.confirm),status(409));
  try { await blocking(holder); } finally { await holder.query('COMMIT'); holder.release(); }
  await rejected;
});

test('RUNTIME-ADV real challenge expiry across observed row lock refuses a valid unused signature',async()=>{
  const f=await nearExpiryFixture(),holder=await pool.connect();
  await holder.query('BEGIN');await holder.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE',[f.challenge.challenge_id]);
  const rejected=assert.rejects(api.confirm(f.actor,f.confirm),status(409));
  try{await blocking(holder);await challengeExpired(f.challenge.challenge_id);}finally{await holder.query('ROLLBACK');holder.release();}
  await rejected;
  assert.equal((await pool.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1',[f.challenge.challenge_id])).rows[0].consumed_at,null);
});

for(const expiry of ['session','challenge'] as const) {
  test(`RUNTIME-ADV ${expiry} expiry during actual asynchronous ES256 verification is rechecked before consumption`,async t=>{
    const f=expiry==='challenge'?await nearExpiryFixture():await fixture();
    if(expiry==='session')await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1",[f.actor.session_hash]);
    let verified!:()=>void,release!:()=>void;
    const cryptoReached=new Promise<void>(resolve=>{verified=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
    const original=globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle);
    // Preserve actual cryptographic verification and delay only its completion.
    // This observes the service's real async boundary without a fake true verifier.
    t.mock.method(globalThis.crypto.subtle,'verify',async(...args:Parameters<typeof original>)=>{
      const valid=await original(...args);assert.equal(valid,true);verified();await barrier;return valid;
    });
    const rejected=assert.rejects(api.confirm(f.actor,f.confirm),status(expiry==='session'?401:409));
    try {
      await Promise.race([cryptoReached,delay(2000).then(()=>assert.fail('Real ES256 verifier was not reached'))]);
      if(expiry==='session')await expired(f.actor);else await challengeExpired(f.challenge.challenge_id);
    }finally{release();}
    await rejected;
    assert.equal((await pool.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1',[f.challenge.challenge_id])).rows[0].consumed_at,null);
  });
}

test('RUNTIME-ADV principal and scope revocation deny currently authorized receipt replay',async()=>{
  for(const kind of ['principal','scope'] as const) {
    const f=await fixture();await api.confirm(f.actor,f.confirm);
    if(kind==='principal')await pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1",[f.context.subject_principal.principal_id]);
    else await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1",[f.context.scope.scope_id]);
    await assert.rejects(api.confirm(f.actor,f.confirm),status(403));
    await assert.rejects(api.read(f.actor,{runtimeDeviceId:f.challenge.runtime_device_id}),status(403));
  }
});

test('RUNTIME-ADV successful exact confirmation replay survives challenge expiry but a new consume cannot',async()=>{
  const f=await nearExpiryFixture(),value=await api.confirm(f.actor,f.confirm);
  await challengeExpired(f.challenge.challenge_id);
  assert.deepEqual(await api.confirm(f.actor,f.confirm),value);
  await assert.rejects(api.confirm(f.actor,{...f.confirm,key:randomUUID()}),status(409));
});

test('RUNTIME-ADV caller mutation during observed row wait cannot change snapshotted proof, identity or receipt request',async()=>{
  const f=await fixture(),peer=await fixture(),holder=await pool.connect(),input={...f.confirm},actor={...f.actor};
  await holder.query('BEGIN');await holder.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE',[f.challenge.challenge_id]);
  const operation=api.confirm(actor,input);
  try {
    await blocking(holder);actor.user_id=peer.actor.user_id;actor.session_hash=peer.actor.session_hash;
    input.challengeId=peer.challenge.challenge_id;input.proof=peer.confirm.proof;input.key=randomUUID();
  }finally{await holder.query('ROLLBACK');holder.release();}
  const value=await operation;assert.equal(value.runtimeDeviceId,f.challenge.runtime_device_id);
  assert.deepEqual(await api.confirm(f.actor,f.confirm),value);
  assert.equal((await pool.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1',[peer.challenge.challenge_id])).rows[0].consumed_at,null);
});

test('RUNTIME-ADV changed public key under an existing begin key is an application conflict with no duplicate SQL write',async()=>{
  const f=await fixture(),before=await counts();
  await assert.rejects(api.begin(f.actor,{...f.input,publicJwk:keypair().publicJwk}),error=>
    status(409)(error) && (error as {code?:string}).code==='idempotency_conflict');
  assert.deepEqual(await counts(),before);
  assert.deepEqual(await api.begin(f.actor,f.input),f.challenge);
});

test('RUNTIME-ADV missing revoke CAS precondition returns428 before any SQL mutation',async()=>{
  const f=await fixture(),value=await api.confirm(f.actor,f.confirm),before=await counts();
  await assert.rejects(api.revoke(f.actor,{key:randomUUID(),runtimeDeviceId:value.runtimeDeviceId} as Parameters<typeof api.revoke>[1]),status(428));
  assert.deepEqual(await counts(),before);
  assert.deepEqual(await api.read(f.actor,{runtimeDeviceId:value.runtimeDeviceId}),value);
});
