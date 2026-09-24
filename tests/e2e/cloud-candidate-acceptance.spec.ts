import {test,expect} from './fixtures.js';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {e2eOrigin} from '../../packages/testing/e2e-origin.js';
import metadata from '../../contracts/preview/v1/metadata.json' with {type:'json'};
import packageMetadata from '../../package.json' with {type:'json'};
import {
  CandidateClient,OriginGuardError,PHASES,Secrets,candidateTarget,describeError,isInboxPath,loadOptions,localHarnessTarget,runCandidate,runLoad,selectPhases,summarizeLoad,
  type BrowserLike,type PhaseId,type Transport,type TransportRequest,
} from '../../scripts/verify-cloud-candidate-lib.js';
import {parseArgs,readPrivateJson,validateAccess,validateAccount} from '../../scripts/verify-cloud-candidate.js';

// Guard tests use in-memory transports. The final case is a local harness run
// against this worktree's isolated E2E server; it tests the tool, not any cloud.
const staging=candidateTarget('staging-next');
const account={email:'synthetic-candidate@example.invalid',password:'Synthetic-Password-For-Tests-0001',label:'synthetic-test'};
const access={clientId:'access-client-id-0001',clientSecret:'access-client-secret-000000001'};
type Reply={status:number;json?:unknown;headers?:Record<string,string>;cookies?:string[];bytes?:number};
function mock(handler:(request:TransportRequest)=>Reply|Promise<Reply>){
  const calls:TransportRequest[]=[];
  const transport:Transport=async request=>{
    calls.push(request);
    const reply=await handler(request),headers=new Headers({'cache-control':'no-store',...(reply.json!==undefined?{'content-type':'application/json'}:{}),...reply.headers});
    for(const cookie of reply.cookies??[])headers.append('set-cookie',cookie);
    const body=reply.json!==undefined?Buffer.from(JSON.stringify(reply.json)):Buffer.alloc(reply.bytes??0);
    return {status:reply.status,headers,body};
  };
  return {transport,calls};
}
const health=(overrides={})=>({status:'ok',mode:'staging',version:'1.2.3',money_movement_enabled:false,official:false,...overrides});
const base=(phases:PhaseId[],extra={})=>({target:staging,run:'execute' as const,phases:selectPhases(phases),expectedVersion:'1.2.3',contract:metadata,...extra});

test('import, parse and plan make no network request and report every remote phase not_run',async()=>{
  const original=globalThis.fetch;let used=0;
  globalThis.fetch=(async()=>{used++;throw Error('network');}) as typeof fetch;
  try {
    const cli=parseArgs(['plan','--target','next','--phases','guild-cache,load']);
    const report=await runCandidate({target:cli.target!,run:'plan',phases:cli.phases,expectedVersion:'1.2.3',contract:metadata});
    expect(used).toBe(0);
    expect(report).toMatchObject({run:'plan',harness:'cloud_candidate',cloud_proof:false,overall:'not_run',access_credential:'not_read',target:{origin:'https://next.freetwai.com',expected_mode:'public'}});
    expect(report.phases.map(phase=>phase.status)).toEqual(PHASES.map(()=> 'not_run'));
    expect(report.statement).toMatch(/no network request/);
    expect(cli.phases).toEqual(['preflight','health','session','guild-cache','load','logout']);
  } finally {globalThis.fetch=original;}
});

test('a preflight-only execute stays valid but is never cloud proof',async()=>{
  for(const phases of [['preflight'],[]] as PhaseId[][]){
    let requests=0;
    const report=await runCandidate({target:candidateTarget('next'),run:'execute',phases:selectPhases(phases),expectedVersion:'1.2.3',contract:metadata,transport:async()=>{requests++;throw Error('unexpected');}});
    expect(requests).toBe(0);
    expect(report.phases.find(p=>p.id==='preflight')?.status).toBe('pass');
    expect(report).toMatchObject({run:'execute',harness:'cloud_candidate',overall:'pass',cloud_proof:false});
  }
  // In-memory mock, not remote evidence: only checks that a passing network phase satisfies the metadata rule.
  const {transport,calls}=mock(()=>({status:200,json:health()}));
  const report=await runCandidate({...base(['health']),transport});
  expect(calls).toHaveLength(1);
  expect(report).toMatchObject({overall:'pass',cloud_proof:true});
});

test('only the two exact candidate origins are addressable',()=>{
  for(const value of ['staging-next','https://staging-next.freetwai.com','https://staging-next.freetwai.com/'])expect(candidateTarget(value).mode).toBe('staging');
  for(const value of ['next','https://next.freetwai.com'])expect(candidateTarget(value).mode).toBe('public');
  for(const value of ['https://freetwai.com','https://staging.freetwai.com','https://www.freetwai.com','freetwai','staging','http://next.freetwai.com',
    'https://NEXT.freetwai.com','https://next.freetwai.com.','https://next.freetwai.com:443','https://next.freetwai.com:8443','https://next.freetwai.com/api',
    'https://next.freetwai.com?x=1','https://next.freetwai.com#x','https://u:p@next.freetwai.com','https://next.freetwai.com.evil.example',
    'https://evil.example/next.freetwai.com','https://nеxt.freetwai.com','https://xn--nxt-8cd.freetwai.com',' next','next ','javascript:next','constructor','__proto__'])
    expect(()=>candidateTarget(value),value).toThrow(/target must be/);
  for(const argv of [['execute','--target','next','--password','x'],['--target','next','--token=abc'],['--target','next','--target','staging-next'],['--target','next','--phases','health,drop'],
    ['--target','next','--load-requests','601'],['--target','next','--load-concurrency','0'],['--target','next','--expected-version','$(id)'],['--target','next','--dev-guild','guild_platform_engineering']])
    expect(()=>parseArgs(argv),argv.join(' ')).toThrow();
  const pasted='argv-secret-value-000000001';
  expect(()=>selectPhases(['health',pasted])).toThrow(/^unknown phase$/);
  try{parseArgs(['--target','next','--phases',pasted]);}catch(error){expect(String(error)).not.toContain(pasted);}
  for(const origin of ['https://127.0.0.1:4322','http://localhost:4322','http://127.0.0.1','http://127.0.0.1:4322/x','https://next.freetwai.com'])expect(()=>localHarnessTarget(origin)).toThrow();
});

test('client refuses other origins before sending and never follows redirects or forwards Access headers elsewhere',async()=>{
  const {transport,calls}=mock(()=>({status:302,headers:{location:'https://team.cloudflareaccess.com/cdn-cgi/access/login'}}));
  const client=new CandidateClient(staging,transport,access,new Secrets());
  for(const path of ['//evil.example/x','https://evil.example/','/\\evil.example','http://staging-next.freetwai.com/','/a b','/x#y','relative'])
    await expect(client.request('GET',path),path).rejects.toBeInstanceOf(OriginGuardError);
  expect(calls).toHaveLength(0);
  const report=await runCandidate({...base(['health']),transport,access});
  expect(calls).toHaveLength(1);
  expect(calls.every(call=>new URL(call.url).origin===staging.origin)).toBe(true);
  expect(report.phases.find(p=>p.id==='health')).toMatchObject({status:'fail',reason:'no_redirect'});
  expect(report.phases.find(p=>p.id==='health')!.checks.at(-1)).toEqual({id:'no_redirect',status:'fail',note:'access_challenge'});
  expect(report.overall).toBe('fail');expect(report.cloud_proof).toBe(false);
});

test('mode and version mismatches fail health and block every dependent phase',async()=>{
  for(const [body,check] of [[health({mode:'public'}),'mode_matches_target'],[health({version:'1.2.4'}),'version_matches_expected'],[health({official:true}),'not_official'],[health({commit_sha:'x'}),'exact_fields']] as const){
    const {transport,calls}=mock(()=>({status:200,json:body}));
    const report=await runCandidate({...base(['health','guild-cache']),transport,account});
    expect(report.phases.find(p=>p.id==='health')).toMatchObject({status:'fail',reason:check});
    for(const id of ['session','guild-cache'])expect(report.phases.find(p=>p.id===id)?.status,id).toBe('blocked');
    expect(report.phases.find(p=>p.id==='logout')).toMatchObject({status:'not_run',reason:'no_tool_session'});
    expect(calls.map(call=>new URL(call.url).pathname)).toEqual(['/api/v1/health']);
    expect(report.overall).toBe('fail');
  }
});

test('stale or rejected authentication fails closed and never reads member state',async()=>{
  const {transport,calls}=mock(request=>{
    const path=new URL(request.url).pathname;
    if(path==='/api/v1/health')return {status:200,json:health()};
    if(path==='/api/v1/auth/login')return {status:401,json:{code:'login_failed'}};
    return {status:500,json:{}};
  });
  const report=await runCandidate({...base(['guild-cache','avatar']),transport,account});
  expect(report.phases.find(p=>p.id==='session')).toMatchObject({status:'fail',reason:'login_status_401'});
  for(const id of ['guild-cache','avatar'])expect(report.phases.find(p=>p.id===id)?.status).toBe('blocked');
  expect(report.phases.find(p=>p.id==='logout')?.status).toBe('not_run');
  expect(calls.map(call=>new URL(call.url).pathname)).toEqual(['/api/v1/health','/api/v1/auth/login']);
  expect(report.overall).toBe('fail');
});

test('secrets, cookies, CSRF and remote error text never reach the report',async()=>{
  const cookie='S'.repeat(43),csrf='csrf-token-value-000000001',userId=randomUUID();
  const {transport}=mock(request=>{
    const path=new URL(request.url).pathname;
    // A hostile or broken candidate echoes secrets back in every field it controls.
    if(path==='/api/v1/health')return {status:200,json:health({version:account.password})};
    if(path==='/api/v1/auth/login')return {status:200,json:{user:{user_id:userId,email:account.email},csrf_token:csrf},cookies:[`freedom_local_session=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict`]};
    if(path==='/api/v1/session')throw Object.assign(new Error(`boom ${account.password} ${cookie} ${request.headers['CF-Access-Client-Secret']}`),{name:'TypeError'});
    return {status:200,json:{}};
  });
  const report=await runCandidate({...base(['health','session']),expectedVersion:account.password,transport,account,access});
  const text=JSON.stringify(report);
  for(const secret of [account.password,account.email,cookie,csrf,userId,access.clientId,access.clientSecret,'boom'])expect(text).not.toContain(secret);
  expect(report.redaction_applied).toBe(true);
  expect(report.phases.find(p=>p.id==='session')).toMatchObject({status:'fail',reason:'TypeError'});
  expect(describeError(Object.assign(new Error('https://x/?state=secret'),{cause:{code:'ECONNRESET'}}))).toBe('Error:ECONNRESET');
});

test('secrets that JSON escapes and long echoed secrets are redacted, never truncated into the report',async()=>{
  const escaped=['example"escaped\\password123','synthetic-line1\nline2-secret','tab\there"and\\back\r\n\u0001'];
  for(const secret of escaped){
    const secrets=new Secrets();secrets.add(secret);
    const {text,hit}=secrets.redact(JSON.stringify({version:secret,nested:[{v:`x${secret}y`}]}));
    expect(hit).toBe(true);
    expect(JSON.parse(text)).toEqual({version:'[REDACTED]',nested:[{v:'x[REDACTED]y'}]});
  }
  // A hostile candidate reflects credentials into every remote metadata field the report keeps.
  const password=escaped[0],clientSecret=`LongAccessSecret${'A'.repeat(100)}`;
  const {transport}=mock(request=>{
    const path=new URL(request.url).pathname;
    if(path==='/api/v1/health')return {status:200,json:health({mode:clientSecret,version:password})};
    return {status:200,bytes:4,headers:{'content-type':`image/webp; x=${clientSecret}`,'cache-control':`max-age=60, ${clientSecret}`}};
  });
  const report=await runCandidate({...base(['health','assets']),transport,account:{...account,password},access:{...access,clientSecret}});
  const text=JSON.stringify(report);
  expect(JSON.parse(text)).toEqual(report);
  for(const secret of [password,JSON.stringify(password).slice(1,-1),clientSecret.slice(0,16)])expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
  expect(report.phases.find(p=>p.id==='health')!.metrics).toMatchObject({mode:'omitted_too_long',version:'[REDACTED]'});
  expect(report.phases.find(p=>p.id==='assets')!.metrics!.assets).toMatchObject([{content_type:'omitted_too_long',cache_control:'omitted_too_long'}]);
  expect(report.redaction_applied).toBe(true);
});

/** In-memory candidate for guild-cache: real-shaped routes plus knobs for stale reads and failed cleanup lookups. */
function guildCandidate(knobs:{stale?:'join'|'leave';failAfterJoin?:'status500'|'throw'}={}){
  const csrf='csrf-mock-token-0000000001',userId=randomUUID(),sessions=new Set<string>(),receipts=new Map<string,Reply>();
  let logins=0,state:string|null=null,version=0,joined=false,stale=0,staleEligible=false;
  const server=mock(request=>{
    const path=new URL(request.url).pathname,cookie=/^freedom_local_session=(.+)$/.exec(request.headers.Cookie??'')?.[1];
    if(path==='/api/v1/health')return {status:200,json:health()};
    if(path==='/api/v1/auth/login'){const value=`S${++logins}`.padEnd(43,'x');sessions.add(value);
      return {status:200,json:{user:{user_id:userId,email:account.email},csrf_token:csrf},cookies:[`freedom_local_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`]};}
    if(!cookie||!sessions.has(cookie))return {status:401,json:{code:cookie?'session_expired':'login_required'}};
    if(path==='/api/v1/auth/logout'){
      if(request.headers.Origin!==staging.origin)return {status:403,json:{code:'origin_rejected'}};
      if(request.headers['X-CSRF-Token']!==csrf)return {status:403,json:{code:'csrf_rejected'}};
      sessions.delete(cookie);return {status:200,json:{},cookies:['freedom_local_session=; Path=/; Max-Age=0']};
    }
    if(path==='/api/v1/session')return {status:200,json:{user:{user_id:userId}}};
    if(path==='/api/v1/me/guild-preferences')return {status:200,json:{primary_guild_key:'guild_platform_engineering'}};
    if(path==='/api/v1/me/skill-books')return {status:200,json:{items:[]}};
    if(path==='/api/v1/me/development/skill/video-autopilot'){
      if(joined&&knobs.failAfterJoin==='status500')return {status:500,json:{code:'internal'}};
      const eligible=stale>0?(stale--,staleEligible):state==='active';
      return {status:200,json:{eligible,enabled:false,consent:null,guilds:[{guild_key:'guild_ai_vibe',state}],keys:[],grant:null,app:{configured:false}}};
    }
    if(path==='/api/v1/guilds/directory'){
      if(joined&&knobs.failAfterJoin==='status500')return {status:500,json:{code:'internal'}};
      if(joined&&knobs.failAfterJoin==='throw')throw Object.assign(new Error('reset'),{name:'TypeError'});
      return {status:200,json:{items:[{guild_key:'guild_ai_vibe',membership:state?{state,aggregate_version:version}:null}]}};
    }
    const key=request.headers['Idempotency-Key'];
    if(key&&receipts.has(key))return receipts.get(key)!;
    let reply:Reply;
    if(path==='/api/v1/guilds/guild_ai_vibe/join'){state='active';version++;joined=true;if(knobs.stale==='join'){stale=1;staleEligible=false;}
      reply={status:200,json:{state,aggregate_version:version},headers:{etag:`"${version}"`}};}
    else if(path==='/api/v1/guilds/guild_ai_vibe/leave'){
      if(request.headers['If-Match']!==`"${version}"`)return {status:412,json:{code:'version_conflict'}};
      state='left';version++;if(knobs.stale==='leave'){stale=1;staleEligible=true;}
      reply={status:200,json:{state,aggregate_version:version},headers:{etag:`"${version}"`}};}
    else return {status:404,json:{code:'not_found'}};
    if(key)receipts.set(key,reply);
    return reply;
  });
  return {...server,membership:()=>state};
}
const guildCleanup=(report:Awaited<ReturnType<typeof runCandidate>>)=>report.cleanup.items.find(item=>item.item==='test guild membership guild_ai_vibe')?.state;

test('guild-cache passes only when the first read after each commit is current; a stale first read fails even if the next is fresh',async()=>{
  const control=guildCandidate();
  const passed=await runCandidate({...base(['guild-cache']),transport:control.transport,account});
  expect(passed.phases.find(p=>p.id==='guild-cache')).toMatchObject({status:'pass'});
  expect(passed.phases.find(p=>p.id==='guild-cache')!.metrics).toMatchObject({after_join:{eligible:true,enabled:false,grant:'none'},after_leave:{eligible:false,enabled:false}});
  expect(guildCleanup(passed)).toBe('restored');expect(control.membership()).toBe('left');
  for(const [stale,check,final] of [['join','join_first_read_eligible','left'],['leave','leave_first_read_revoked','left']] as const){
    const server=guildCandidate({stale});
    const report=await runCandidate({...base(['guild-cache']),transport:server.transport,account});
    expect(report.phases.find(p=>p.id==='guild-cache'),stale).toMatchObject({status:'fail',reason:check});
    expect(report.cloud_proof).toBe(false);
    // No retry past the stale read: exactly one status GET follows the write.
    const paths=server.calls.map(call=>`${call.method} ${new URL(call.url).pathname}`),write=paths.lastIndexOf(`POST /api/v1/guilds/guild_ai_vibe/${stale}`);
    expect(paths.slice(write+1).filter(path=>path==='GET /api/v1/me/development/skill/video-autopilot')).toHaveLength(1);
    expect(guildCleanup(report)).toBe('restored');expect(server.membership()).toBe(final);
  }
});

test('guild-cache cleanup reports restore_failed, never restored, when the membership lookup fails',async()=>{
  for(const failAfterJoin of ['status500','throw'] as const){
    const server=guildCandidate({failAfterJoin});
    const report=await runCandidate({...base(['guild-cache']),transport:server.transport,account});
    expect(report.phases.find(p=>p.id==='guild-cache')?.status,failAfterJoin).toBe('fail');
    expect(guildCleanup(report),failAfterJoin).toBe('restore_failed');
    expect(report.cleanup.required).toBe(true);
    // The lookup failure is not turned into a check or a leave attempt.
    const finalCalls=server.calls.slice(server.calls.findLastIndex(call=>new URL(call.url).pathname==='/api/v1/guilds/directory')+1);
    expect(finalCalls.some(call=>call.method==='POST'&&new URL(call.url).pathname.endsWith('/leave'))).toBe(false);
  }
});

test('inbox paths and every descendant are matched, including encoded and doubled-slash forms',()=>{
  for(const path of ['/api/v1/me/notifications','/api/v1/me/notifications/n1/read','/api/v1/me/conversations','/api/v1/me/conversations/c1/messages',
    '/api/v1/me/channels','/api/v1/me/channels/guild/k/messages','/api/v1//me/channels','/API/v1/me/Conversations','/api/v1/me/%63onversations','/api/v1/me/%E0%A4%A'])
    expect(isInboxPath(path),path).toBe(true);
  for(const path of ['/api/v1/session','/api/v1/me/notificationsx','/api/v1/me/guild-preferences','/api/v1/me/channel','/'])expect(isInboxPath(path),path).toBe(false);
});

test('load metrics report measured counts, errors and percentiles and nothing when nothing ran',async()=>{
  expect(summarizeLoad([],0)).toEqual({requests:0,status_counts:{},network_errors:{},failed:0,error_rate:null,p50_ms:null,p95_ms:null,p99_ms:null,duration_ms:0,achieved_rps:null});
  let index=0;
  const {transport,calls}=mock(()=>{const i=index++;if(i%5===4)throw Object.assign(new Error('timeout'),{name:'TimeoutError'});return {status:i%5===3?503:200,bytes:10};});
  const summary=await runLoad(new CandidateClient(staging,transport,null,new Secrets()),loadOptions({requests:20,concurrency:3,rps:30,timeoutMs:1000}));
  expect(calls).toHaveLength(20);
  expect(calls.every(call=>call.method==='GET'&&!call.headers.Cookie)).toBe(true);
  expect(summary).toMatchObject({requests:20,status_counts:{'200':12,'503':4},network_errors:{TimeoutError:4},failed:8,error_rate:0.4});
  expect(summary.p50_ms).not.toBeNull();expect(summary.duration_ms).toBeGreaterThanOrEqual(600);
  expect(()=>loadOptions({requests:10000})).toThrow();expect(()=>loadOptions({rps:1000})).toThrow();
  const {transport:failing}=mock(()=>({status:503}));
  const report=await runCandidate({...base(['load']),transport:failing,load:loadOptions({requests:5,rps:30})});
  expect(report.phases.find(p=>p.id==='load')).toMatchObject({status:'fail',reason:'error_rate_within_threshold'});
});

test('credential files must be private, synthetic and bound to the candidate origin',async()=>{
  expect(()=>validateAccount({...raw(),email:'maker@local.test'},staging)).toThrow(/demo/);
  expect(()=>validateAccount({...raw(),password:'freedom-local-demo'},staging)).toThrow(/dedicated/);
  expect(()=>validateAccount({...raw(),candidate_origin:'https://next.freetwai.com'},staging)).toThrow(/different origin/);
  expect(()=>validateAccount({...raw(),synthetic:false},staging)).toThrow(/synthetic/);
  expect(()=>validateAccount({...raw(),role:'admin'},staging)).toThrow(/exactly/);
  expect(validateAccount(raw(),staging).label).toBe('synthetic-test');
  expect(()=>validateAccess({candidate_origin:'https://staging.freetwai.com',client_id:access.clientId,client_secret:access.clientSecret},staging)).toThrow(/different origin/);
  const directory=await mkdtemp(join(tmpdir(),'cloud-candidate-'));
  try {
    const file=join(directory,'account.json');await writeFile(file,JSON.stringify(raw()),{mode:0o644});await chmod(file,0o644);
    await expect(readPrivateJson(file,'account')).rejects.toThrow(/chmod 600/);
    await chmod(file,0o600);expect(await readPrivateJson(file,'account')).toMatchObject({label:'synthetic-test'});
    await expect(readPrivateJson('account.json','account')).rejects.toThrow(/absolute/);
    await expect(readPrivateJson(undefined,'account')).rejects.toThrow(/not configured/);
  } finally {await rm(directory,{recursive:true,force:true});}
  function raw(){return {candidate_origin:staging.origin,label:'synthetic-test',email:account.email,password:account.password,synthetic:true} as Record<string,unknown>;}
});

/**
 * Removes exactly the generated harness user and rows it owns, children first, in one
 * transaction; then proves nothing referencing that user (by foreign-key metadata) or
 * journaled by it remains. Catalog and shared fixture rows are never touched.
 */
async function removeHarnessUser(db:Pool,id:string,email:string){
  expect(email).toMatch(/^cloud-candidate-[0-9a-f-]{36}@local\.test$/);
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const q=(sql:string)=>client.query(sql,[id]);
    await q('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=$1)');
    await q('DELETE FROM transition_journal WHERE actor_ref=$1');
    for(const table of ['member_social_links','member_avatars','onboarding_assessments','member_skill_book_grants','guild_member_preferences',
      'positioning_profession_memberships','member_accounts','command_receipts','sessions'])await q(`DELETE FROM ${table} WHERE user_id=$1`);
    const removed=await client.query('DELETE FROM users WHERE user_id=$1 AND email=$2',[id,email]);
    expect(removed.rowCount).toBeLessThanOrEqual(1);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{client.release();}
  const count=async(sql:string,values:unknown[])=>(await db.query(`SELECT count(*)::int AS n FROM ${sql}`,values)).rows[0].n as number;
  expect(await count('users WHERE user_id=$1 OR email=$2',[id,email])).toBe(0);
  const references=(await db.query(`SELECT c.conrelid::regclass::text AS tab,a.attname AS col FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.contype='f' AND c.confrelid='users'::regclass`)).rows as {tab:string;col:string}[];
  expect(references.length).toBeGreaterThan(5);
  for(const {tab,col} of references)expect(await count(`${tab} WHERE "${col}"=$1`,[id]),`${tab}.${col}`).toBe(0);
  expect(await count('transition_journal WHERE actor_ref=$1 OR aggregate_id=$1',[id])).toBe(0);
}

test('local harness: real session, CSRF, guild grant/revoke freshness, avatar, browser and load against the isolated E2E server',async({browser,e2eAuthPool})=>{
  test.setTimeout(120000);
  const id=randomUUID(),email=`cloud-candidate-${id}@local.test`;
  // Observes the tool's own browser context: inbox paths only, method and path only.
  const inbox={requested:[] as string[],responses:0,failed:[] as string[]};
  const observed:BrowserLike={newContext:async options=>{
    const context=await browser.newContext(options);
    const watch=(url:string)=>isInboxPath(new URL(url).pathname);
    context.on('request',request=>{if(watch(request.url()))inbox.requested.push(new URL(request.url()).pathname);});
    context.on('response',response=>{if(watch(response.url()))inbox.responses++;});
    context.on('requestfailed',request=>{if(watch(request.url()))inbox.failed.push(request.failure()?.errorText??'');});
    return context;
  }};
  let failure:unknown=null;
  try {
    await e2eAuthPool.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,community_id,$2,'Cloud candidate harness',password_hash,$3 FROM users WHERE email='maker@local.test'",[id,email,randomUUID()]);
    const target=localHarnessTarget(e2eOrigin());
    const report=await runCandidate({target,run:'execute',phases:selectPhases(['health','protocol','assets','anonymous','session','browser','guild-cache','github-handoff','avatar','load']),
      expectedVersion:packageMetadata.version,contract:metadata,account:{email,password:'freedom-local-demo',label:'local-harness'},browser:observed,load:loadOptions({requests:24,concurrency:4,rps:30,timeoutMs:5000})});
    const status=Object.fromEntries(report.phases.map(p=>[p.id,p.status]));
    const failures=report.phases.filter(p=>p.status==='fail').map(p=>`${p.id}:${p.reason}`);
    expect(failures).toEqual([]);
    expect(status).toEqual({preflight:'pass',health:'pass',protocol:'pass',assets:'pass',anonymous:'pass',session:'pass',browser:'pass','guild-cache':'pass','github-handoff':'not_run',avatar:'pass',load:'pass',logout:'pass'});
    expect(report.phases.find(p=>p.id==='github-handoff')?.reason).toBe('github_oauth_not_configured_on_candidate');
    expect(report).toMatchObject({harness:'local_harness',cloud_proof:false,overall:'incomplete'});
    expect(report.statement).toMatch(/not evidence of any cloud deployment/);
    // The signed-in shell requests inbox previews by itself; every one was aborted, none answered.
    for(const prefix of ['/api/v1/me/notifications','/api/v1/me/conversations'])expect(inbox.requested.some(path=>path===prefix),prefix).toBe(true);
    expect(inbox.responses).toBe(0);
    expect(inbox.failed).toHaveLength(inbox.requested.length);
    expect(inbox.failed.every(text=>/BLOCKED_BY_CLIENT/.test(text))).toBe(true);
    const browserPhase=report.phases.find(p=>p.id==='browser')!;
    expect(browserPhase.metrics).toMatchObject({inbox_requests_blocked:inbox.requested.length,member_inbox:'not_covered'});
    expect(browserPhase.checks).toContainEqual({id:'no_inbox_response_received',status:'pass'});
    const guild=report.phases.find(p=>p.id==='guild-cache')!;
    expect(guild.metrics).toMatchObject({baseline:{eligible:false,enabled:false},after_join:{eligible:true,enabled:false,grant:'none'},after_leave:{eligible:false,enabled:false,test_guild_state:'left'}});
    expect((guild.metrics!.after_leave as {skill_book_count:number}).skill_book_count).toBe(guild.metrics!.skill_books_after_join);
    for(const check of ['join_first_read_eligible','join_second_read_eligible','leave_first_read_revoked','leave_second_read_revoked'])expect(guild.checks).toContainEqual({id:check,status:'pass'});
    expect(report.phases.find(p=>p.id==='load')!.metrics).toMatchObject({requests:24,failed:0,error_rate:0});
    expect(report.cleanup.items).toContainEqual({phase:'guild-cache',item:'test guild membership guild_ai_vibe',state:'restored'});
    expect(report.cleanup.required).toBe(true);
    const text=JSON.stringify(report);for(const secret of [email,id,'freedom-local-demo'])expect(text).not.toContain(secret);
    // Database facts: the tool restored authority and revoked every session it created.
    expect((await e2eAuthPool.query("SELECT state FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key='guild_ai_vibe'",[id])).rows).toEqual([{state:'left'}]);
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[id])).rows[0].n).toBe(0);
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[id])).rows[0].n).toBeGreaterThanOrEqual(3);
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM member_avatars WHERE user_id=$1 AND image_bytes IS NOT NULL',[id])).rows[0].n).toBe(0);
  } catch(error){failure=error;}
  // Always remove the generated user and its own rows; neither failure hides the other.
  try{await removeHarnessUser(e2eAuthPool,id,email);}catch(error){failure=failure?new AggregateError([failure,error],'test and cleanup both failed'):error;}
  if(failure)throw failure;
});
