import assert from 'node:assert/strict';
import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {test} from 'node:test';
import {CommerceCredentialKeyring,sealCredential,unsealCredential,resealCredential,credentialFingerprint,_sealCredentialWithNonceForTest} from '../../modules/agent-commerce/payments/credentials.js';
import {CREDENTIAL_SEAL_VECTOR as vector} from '../../modules/agent-commerce/payments/credential-seal-vector.js';
const randomMaterial=()=>({hash_key:randomBytes(16).toString('hex').slice(0,16),hash_iv:randomBytes(16).toString('hex').slice(0,16),credit_check_code:String(randomInt(100000000)).padStart(8,'0')});
const entry=(id='current')=>`${id}:${randomBytes(32).toString('base64')}`;
const context=()=>({account_id:randomUUID(),purpose:'payment' as const,environment:'sandbox' as const,credential_version:1});
test('keyring parse enforces canonical opaque 1..8 entries and fixed errors',()=>{
  assert.equal(CommerceCredentialKeyring.parse(undefined),null);assert.equal(CommerceCredentialKeyring.parse(''),null);
  const one=entry(),eight=Array.from({length:8},(_,i)=>entry('key'+i)).join(',');
  for(const raw of [one,eight]){const ring=CommerceCredentialKeyring.parse(raw)!;assert.equal(ring.activeKeyId,raw.split(':')[0]);assert(!JSON.stringify(ring).includes(raw));assert(!inspect(ring).includes(raw));assert.deepEqual(Object.keys(ring),['activeKeyId']);}
  for(const raw of [eight+','+entry('ninth'),one+','+one,entry('BAD'),entry('-bad'),entry('a'.repeat(33)),one+' ',one+',',one.replace('=', ''),`bad:${randomBytes(31).toString('base64')}`,`bad:${randomBytes(33).toString('base64')}`,one.replace(':',': '),':',one+':extra']){
    assert.throws(()=>CommerceCredentialKeyring.parse(raw),(e:unknown)=>e instanceof Error&&e.message==='Invalid commerce credential keyring.'&&!e.message.includes(raw));
  }
});
test('sealing binds every AAD component and validates integrity; keys rotate without losing old rows',()=>{
  const old=entry('old'),next=entry('next'),ring=CommerceCredentialKeyring.parse(old)!,both=CommerceCredentialKeyring.parse(next+','+old)!;
  const ctx=context(),material=randomMaterial(),sealed=sealCredential(ring,ctx,material);
  assert.deepEqual(unsealCredential(ring,ctx,sealed),material);assert.deepEqual(unsealCredential(both,ctx,sealed),material);
  for(const changed of [{account_id:randomUUID()},{purpose:'invoice' as const},{environment:'live' as const},{credential_version:2}])assert.throws(()=>unsealCredential(both,{...ctx,...changed},sealed),{message:'Commerce credential unavailable.'});
  for(const row of [{...sealed,key_id:'missing'},{...sealed,sealed:'invalid'},{...sealed,sealed:Buffer.from(sealed.sealed,'base64').fill(0,12,28).toString('base64')}])assert.throws(()=>unsealCredential(both,ctx,row),{message:'Commerce credential unavailable.'});
  const resealed=resealCredential(both,ctx,sealed);assert.equal(resealed.key_id,'next');assert.deepEqual(unsealCredential(CommerceCredentialKeyring.parse(next)!,ctx,resealed),material);
  const input={...material,account_id:ctx.account_id,purpose:ctx.purpose,profile:'ecpay.aio.credit.v1'};
  const fingerprint=credentialFingerprint(ring,input);assert.match(fingerprint,/^[a-f0-9]{64}$/);assert.equal(credentialFingerprint(ring,input),fingerprint);
  assert.notEqual(credentialFingerprint(both,input),fingerprint);assert.notEqual(credentialFingerprint(ring,{...input,...randomMaterial()}),fingerprint);
});
test('synthetic sealed vector interoperates with a deterministic internal seam',()=>{
  const ring=CommerceCredentialKeyring.parse(vector.keyring)!;
  assert.deepEqual(unsealCredential(ring,vector.context,vector.row),vector.material);
  assert.deepEqual(_sealCredentialWithNonceForTest(ring,vector.context,vector.material,Buffer.from(Array.from({length:12},(_,i)=>i))),vector.row);
});

import {checkoutHarness,ok} from './hosted-checkout-harness.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {bindTenantScope} from '../../modules/tenant-workspaces/facts.js';
import {activateProviderService,retireCredentialVersion,loadServiceCredentials,listUsableCredentialVersions,resealProviderCredentials} from '../../modules/agent-commerce/payments/accounts.js';
import {createProviderAccountRoute,resolveProviderAccountRoute} from '../../modules/agent-commerce/payments/entry-routes.js';

test('provider setup HTTP, activation, retained credentials, entry routes and secret hygiene under tenant RLS',async()=>{
  const x=await checkoutHarness('fp_accounts',{publicSchema:true}),h=x.h;
  const methods=['error','log','warn','info','debug'] as const;
  const original=new Map(methods.map(method=>[method,console[method]]));
  const output:string[]=[],responses:string[]=[],secrets:string[]=[];
  for(const method of methods)console[method]=(...args:unknown[])=>{output.push(args.map(String).join(' '));};
  try{
    await x.reset();await h.pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant) VALUES(1,'active',600,86400,86400,1)`);
    const s=await x.store(),oldKey=entry('old'),ring=CommerceCredentialKeyring.parse(oldKey)!;
    const instanceVersion=(await h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1',[s.instanceId])).rows[0].version;
    ok(await x.send(s,'/upgrade',{},instanceVersion));
    let app=createApp(x.runtime,h.origin,'local',{guildLaunchpadEnabled:true,commerceCredentialKeyring:ring});
    const noKeys=createApp(x.runtime,h.origin,'local',{guildLaunchpadEnabled:true});
    const call=async(method:string,path:string,body?:unknown,version?:string,key=randomUUID(),session=s.owner,target=app)=>{
      const result=await h.call(method,path,session,body,method==='GET'?{}:{'Idempotency-Key':key,...(version?{'If-Match':`"${version}"`}:{})},target);
      responses.push(JSON.stringify(result.data));await scan();return result;
    };
    async function scan(){
      const columns=(await h.pool.query(`SELECT table_name,column_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_catalog,table_schema,table_name)
        WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.data_type IN ('text','character varying','jsonb','json')`)).rows;
      // One statement per scan checks every stored column for every secret; a query per secret and column made this file the slowest runtime test.
      if(secrets.length){
        const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
        const probes=columns.map((col,i)=>`SELECT ${i} AS i WHERE EXISTS(SELECT 1 FROM public.${quote(col.table_name)} r,unnest($1::text[]) s(secret) WHERE position(s.secret in r.${quote(col.column_name)}::text)>0)`);
        const found=(await h.pool.query<{i:number}>(probes.join(' UNION ALL '),[secrets])).rows.map(r=>`${columns[r.i].table_name}.${columns[r.i].column_name}`);
        assert.deepEqual(found,[],'plaintext credential in a stored column');
      }
      for(const secret of secrets){assert(!responses.some(r=>r.includes(secret)),'response contains credential');assert(!output.some(r=>r.includes(secret)),'log contains credential');}
    }
    const fresh=async(purpose='commerce.provider_account.write',session=s.owner,tenant=s.tenantId)=>ok(await call('POST','/me/high-risk-verifications',{tenant_id:tenant,purpose,password:DEMO_PASSWORD},undefined,randomUUID(),session),201).verification_id as string;
    const root=s.root+'/provider-accounts';
    const input={provider:'ecpay',environment:'sandbox',merchant_id:'1234567',fresh_auth_verification_id:await fresh()};
    const key=randomUUID(),created=await call('POST',root,input,undefined,key);let a=ok(created,201);
    assert.deepEqual(ok(await call('POST',root,input,undefined,key),201),a);
    assert.equal((await call('POST',root,{...input,merchant_id:'1234568'},undefined,randomUUID())).data.code,'fresh_auth_required');
    assert.equal((await call('POST',root,{...input,fresh_auth_verification_id:await fresh()})).data.code,'provider_account_exists');
    assert.equal((await call('POST',root,{...input,environment:'live',fresh_auth_verification_id:await fresh()})).data.code,'provider_environment_not_allowed');
    assert.equal((await call('POST',root,{...input,fresh_auth_verification_id:await fresh()},undefined,randomUUID(),s.owner,noKeys)).status,503);
    assert.equal((await call('GET',root,undefined,undefined,randomUUID(),s.owner,noKeys)).status,200);
    const service=root+'/'+a.account_id+'/services/payment';
    for(const merchant_id of ['123456','12345678901','abcdefg'])assert.equal((await call('POST',root,{...input,merchant_id,fresh_auth_verification_id:await fresh()})).data.code,'validation_failed');
    const expired=randomUUID();await h.pool.query(`INSERT INTO tenant_high_risk_verifications(verification_id,user_id,principal_id,session_hash,tenant_id,purpose,verified_at,expires_at)
      SELECT $1,$2,p.principal_id,se.token_hash,$3,'commerce.provider_account.write',clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '10 minutes'
      FROM principals p JOIN sessions se ON se.user_id=p.user_ref WHERE p.user_ref=$2 ORDER BY se.created_at DESC LIMIT 1`,[expired,s.owner.user.user_id,s.tenantId]);
    assert.equal((await call('POST',root,{...input,merchant_id:'1234568',fresh_auth_verification_id:expired})).data.code,'fresh_auth_required');
    let currentMaterial=randomMaterial();secrets.push(...Object.values(currentMaterial));
    const putBody={profile:'ecpay.aio.credit.v1',...currentMaterial,fresh_auth_verification_id:await fresh()};
    const putKey=randomUUID(),beforeVersion=a.version;a=ok(await call('PUT',service,putBody,beforeVersion,putKey));
    assert.equal(a.services[0].state,'draft');
    for(const invalid of [{hash_key:'short'},{hash_iv:'!'.repeat(16)},{credit_check_code:'bad'}])assert.equal((await call('PUT',service,{...putBody,...invalid,fresh_auth_verification_id:await fresh()},a.version)).data.code,'validation_failed');
    assert.equal((await call('PUT',service,{...putBody,profile:'ecpay.invoice.b2c.v1',fresh_auth_verification_id:await fresh()},a.version)).data.code,'provider_profile_invalid');
    assert.equal((await call('PUT',service.replace('/payment','/invoice'),{...putBody,profile:'ecpay.invoice.b2c.v1',fresh_auth_verification_id:await fresh()},a.version)).data.code,'validation_failed');assert.equal(a.services[0].credential_version,1);
    assert.deepEqual(ok(await call('PUT',service,putBody,beforeVersion,putKey)),a);
    const changed=randomMaterial();secrets.push(...Object.values(changed));assert.equal((await call('PUT',service,{...putBody,...changed},beforeVersion,putKey)).data.code,'idempotency_conflict');
    assert.equal((await call('PUT',service,{...putBody,fresh_auth_verification_id:await fresh('tenant.ownership.propose')},a.version)).data.code,'fresh_auth_required');
    const missing={...putBody} as Record<string,unknown>;delete missing.fresh_auth_verification_id;assert.equal((await call('PUT',service,missing,a.version)).status,403);
    assert.equal((await call('POST',service+'/suspend',{fresh_auth_verification_id:await fresh()},a.version)).data.code,'provider_service_state');
    const machine=async<T>(run:(q:import('pg').PoolClient)=>Promise<T>)=>{const result=await x.tx(async q=>{await bindTenantScope(q,s.tenantId);return run(q);});await scan();return result;};
    await machine(q=>activateProviderService(q,{accountId:a.account_id,purpose:'payment',activationRef:randomUUID()}));
    a=ok(await call('GET',root)).items[0];assert.equal(a.services[0].state,'active');
    for(const [action,state] of [['suspend','suspended'],['resume','active']] as const){a=ok(await call('POST',service+'/'+action,{fresh_auth_verification_id:await fresh()},a.version));assert.equal(a.services[0].state,state);}
    currentMaterial=randomMaterial();secrets.push(...Object.values(currentMaterial));a=ok(await call('PUT',service,{...putBody,...currentMaterial,fresh_auth_verification_id:await fresh()},a.version));
    assert.equal(a.services[0].state,'active');assert.equal(a.services[0].credential_version,2);
    assert.deepEqual(await machine(q=>listUsableCredentialVersions(q,{accountId:a.account_id,purpose:'payment'})),[2,1]);
    const loaded=await machine(q=>loadServiceCredentials(q,ring,{accountId:a.account_id,purpose:'payment'}));assert.equal(loaded.credentialVersion,2);assert(loaded.keys instanceof Object);assert(loaded.creditCheckCode instanceof Object);
    await assert.rejects(machine(q=>retireCredentialVersion(q,{accountId:a.account_id,purpose:'payment',credentialVersion:2})),{code:'provider_service_state'});
    await machine(q=>retireCredentialVersion(q,{accountId:a.account_id,purpose:'payment',credentialVersion:1}));
    assert.deepEqual(await machine(q=>listUsableCredentialVersions(q,{accountId:a.account_id,purpose:'payment'})),[2]);
    const next=CommerceCredentialKeyring.parse(entry('new')+','+oldKey)!;assert.deepEqual(await machine(q=>resealProviderCredentials(q,next,{limit:100})),{resealed:2});
    assert.equal((await machine(q=>loadServiceCredentials(q,next,{accountId:a.account_id,purpose:'payment'}))).credentialVersion,2);
    app=createApp(x.runtime,h.origin,'local',{guildLaunchpadEnabled:true,commerceCredentialKeyring:next});
    assert.equal((await call('PUT',service,putBody,beforeVersion,putKey)).data.code,'idempotency_conflict');
    let second=ok(await call('POST',root,{...input,merchant_id:'1234568',fresh_auth_verification_id:await fresh()}),201);
    const secondPath=root+'/'+second.account_id+'/services/payment';
    second=ok(await call('PUT',secondPath,{...putBody,fresh_auth_verification_id:await fresh()},second.version));
    await assert.rejects(machine(q=>activateProviderService(q,{accountId:second.account_id,purpose:'payment',activationRef:randomUUID()})),{code:'provider_service_conflict'});
    a=ok(await call('GET',root)).items[0];a=ok(await call('POST',service+'/suspend',{fresh_auth_verification_id:await fresh()},a.version));
    await machine(q=>activateProviderService(q,{accountId:second.account_id,purpose:'payment',activationRef:randomUUID()}));
    assert.equal((await call('POST',service+'/resume',{fresh_auth_verification_id:await fresh()},a.version)).data.code,'provider_service_conflict');
    second=ok(await call('GET',root)).items.find((item:any)=>item.account_id===second.account_id);
    ok(await call('POST',secondPath+'/retire',{fresh_auth_verification_id:await fresh()},second.version));
    a=ok(await call('POST',service+'/resume',{fresh_auth_verification_id:await fresh()},a.version));
    for(const [table,set] of [['commerce_provider_accounts',"merchant_id='9999999'"],['commerce_provider_account_services',"profile='ecpay.invoice.b2c.v1'"],['commerce_provider_credentials',"credential_version=42"]]){
      await assert.rejects(h.pool.query(`UPDATE ${table} SET ${set} WHERE account_id=$1`,[a.account_id]),{code:'23514'});
      await assert.rejects(h.pool.query(`DELETE FROM ${table} WHERE account_id=$1`,[a.account_id]),{code:'23514'});
    }
    const route=(await h.pool.query('SELECT route_key FROM commerce_entry_routes WHERE target_id=$1',[a.account_id])).rows[0].route_key;assert.match(route,/^[0-9a-hjkmnp-tv-z]{26}$/);
    const resolved=await x.tx(q=>resolveProviderAccountRoute(q,route));assert.deepEqual(resolved,{tenant_id:s.tenantId,instance_id:s.instanceId,account_id:a.account_id});
    const refTarget=randomUUID(),entropy=[Buffer.from('0000000000000000000000000000018d','hex'),randomBytes(16)];
    await machine(q=>createProviderAccountRoute(q,{tenantId:s.tenantId,instanceId:s.instanceId,accountId:refTarget},()=>entropy.shift()!));assert.equal(entropy.length,0);
    const other=await x.store();assert.equal((await call('POST',root,{...input,merchant_id:'1234569',fresh_auth_verification_id:await fresh('commerce.provider_account.write',other.owner,other.tenantId)})).data.code,'fresh_auth_required');assert.equal((await call('GET',root,undefined,undefined,randomUUID(),other.owner)).status,404);
    await x.tx(async q=>{await bindTenantScope(q,other.tenantId);assert.deepEqual(await listUsableCredentialVersions(q,{accountId:a.account_id,purpose:'payment'}),[]);await assert.rejects(loadServiceCredentials(q,next,{accountId:a.account_id,purpose:'payment'}),{code:'provider_account_not_found'});});
    for(const role of ['admin','operator','viewer'] as const){
      const member=(await h.person('合成帳戶管理測試')).session,principal=await h.candidate(s.owner,member.user.user_id);
      const invitation=await h.invite(s.owner,s.tenantId,principal,role);ok(invitation,201);await h.accept(member,s.tenantId,invitation);
      if(role!=='admin')await h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
        SELECT $1,$2,$3,$4::text[],'active',principal_id FROM principals WHERE user_ref=$5`,[s.tenantId,principal,s.instanceId,role==='operator'?['store:manage','store:read','store:write','store:publish','store:orders:read','store:customers:read','store:finance:read','store:orders:manage','store:fulfil','store:refund','store:invoices','store:settlements']:['store:read','store:finance:read'],s.owner.user.user_id]);
      assert.equal((await call('GET',root,undefined,undefined,randomUUID(),member)).status,200);
      const qualification=await call('POST','/me/high-risk-verifications',{tenant_id:s.tenantId,purpose:'commerce.provider_account.write',password:DEMO_PASSWORD},undefined,randomUUID(),member);
      assert.equal(qualification.status,role==='admin'?201:404);
      const exportProof=await call('POST','/me/high-risk-verifications',{tenant_id:s.tenantId,purpose:'commerce.store_export.create',password:DEMO_PASSWORD},undefined,randomUUID(),member);assert.equal(exportProof.status,404);
      const result=await call('POST',root,{...input,merchant_id:'7654321',fresh_auth_verification_id:qualification.data.verification_id??randomUUID()},undefined,randomUUID(),member);
      assert.equal(result.status,role==='admin'?201:403);if(role!=='admin')assert.equal(result.data.code,'capability_denied');
    }
    assert(await fresh('commerce.store_export.create'));
    const reader=(await h.person('合成基本讀者')).session,readerId=await h.candidate(s.owner,reader.user.user_id),readerInvite=await h.invite(s.owner,s.tenantId,readerId,'operator');await h.accept(reader,s.tenantId,readerInvite);
    await h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id) SELECT $1,$2,$3,ARRAY['store:read'],'active',principal_id FROM principals WHERE user_ref=$4`,[s.tenantId,readerId,s.instanceId,s.owner.user.user_id]);
    assert.equal((await call('GET',root,undefined,undefined,randomUUID(),reader)).status,403);
    await h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:manage'],version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[s.tenantId,readerId]);
    assert.equal((await call('GET',root,undefined,undefined,randomUUID(),reader)).status,200);
    a=ok(await call('GET',root)).items[0];a=ok(await call('POST',service+'/retire',{fresh_auth_verification_id:await fresh()},a.version));assert.equal(a.services[0].state,'retired');
    assert.equal((await call('PUT',service,{...putBody,fresh_auth_verification_id:await fresh()},a.version)).data.code,'provider_service_state');
    assert((await h.pool.query('SELECT 1 FROM commerce_control_events WHERE tenant_id=$1',[s.tenantId])).rowCount!>=8);
    const event=(await h.pool.query('SELECT event_id FROM commerce_control_events WHERE tenant_id=$1 LIMIT 1',[s.tenantId])).rows[0].event_id;
    for(const sql of ['DELETE FROM commerce_control_events WHERE event_id=$1',"UPDATE commerce_control_events SET actor_id=gen_random_uuid() WHERE event_id=$1", "UPDATE commerce_control_events SET detail='{\"unexpected\":true}'::jsonb WHERE event_id=$1"])
      await assert.rejects(h.pool.query(sql,[event]),{code:'23514'});
    await h.pool.query('UPDATE commerce_control_events SET journaled_at=clock_timestamp() WHERE event_id=$1',[event]);
    await assert.rejects(h.pool.query('UPDATE commerce_control_events SET journaled_at=NULL WHERE event_id=$1',[event]),{code:'23514'});
    await scan();
  }finally{for(const method of methods)console[method]=original.get(method)!;await x.stop();}
});
test('entry routes regenerate CDN-blocked references, stop after sixteen attempts and never bind tenant context',async()=>{
  const {createProviderAccountRoute,resolveProviderAccountRoute}=await import('../../modules/agent-commerce/payments/entry-routes.js');
  let calls=0,inserted:string|undefined;
  const q={query:async(sql:string,args:unknown[])=>{calls++;assert(!sql.includes('set_config'));if(sql.startsWith('INSERT')){inserted=args[0] as string;return {rowCount:1,rows:[]};}return {rowCount:0,rows:[]};}} as any;
  const bad=Buffer.from('0000000000000000000000000000018d','hex'),good=Buffer.alloc(16);
  let entropyCalls=0;
  await createProviderAccountRoute(q,{tenantId:randomUUID(),instanceId:randomUUID(),accountId:randomUUID()},()=>++entropyCalls===1?bad:good);
  assert.equal(entropyCalls,2);assert.equal(calls,1);assert.equal(inserted,'0'.repeat(26));
  entropyCalls=0;await assert.rejects(createProviderAccountRoute(q,{tenantId:randomUUID(),instanceId:randomUUID(),accountId:randomUUID()},()=>{entropyCalls++;return bad;}),{message:'Provider account route generation failed.'});assert.equal(entropyCalls,16);
  calls=0;assert.equal(await resolveProviderAccountRoute(q,'invalid'),null);assert.equal(calls,0);assert.equal(await resolveProviderAccountRoute(q,'0'.repeat(26)),null);assert.equal(calls,1);
});
test('Worker configuration parses optional host keys and derives provider environment without disclosing malformed values',async()=>{
  const {readWorkerConfig,workerRuntime}=await import('../../apps/platform-api/src/worker.js');
  const {ReadinessError}=await import('../../apps/platform-api/src/readiness.js');
  const raw=entry('host'),base={FREEDOM_ENV:'local',APP_ORIGIN:'http://127.0.0.1:4310',HYPERDRIVE:{connectionString:process.env.TEST_DATABASE_URL!},ASSETS:{fetch:async()=>new Response('fixture')}};
  assert.equal(readWorkerConfig(base).commerceCredentialKeyring,null);
  const config=readWorkerConfig({...base,COMMERCE_CREDENTIAL_KEYS:raw});assert.equal(config.commerceCredentialKeyring!.activeKeyId,'host');
  assert.equal(workerRuntime({...base,COMMERCE_CREDENTIAL_KEYS:raw},config).commerceCredentialKeyring,config.commerceCredentialKeyring);
  for(const [environment,expected] of [['local','sandbox'],['staging','sandbox'],['public','live']] as const){
    assert.equal(readWorkerConfig({...base,FREEDOM_ENV:environment,APP_ORIGIN:environment==='local'?base.APP_ORIGIN:'https://fixture.example.test',FREEDOM_RELEASE_SHA:'a'.repeat(40)}).commerceProviderEnvironment,expected);
  }
  for(const malformed of [raw+',',raw+' ',entry('Invalid')])assert.throws(()=>readWorkerConfig({...base,COMMERCE_CREDENTIAL_KEYS:malformed}),(e:unknown)=>e instanceof ReadinessError&&e.message==='Commerce credential keyring configuration is invalid.'&&!e.message.includes(malformed));
});
