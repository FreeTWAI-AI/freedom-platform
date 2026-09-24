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
import {main,parseArgs,readPrivateJson,validateAccess,validateAccount} from '../../scripts/verify-cloud-candidate.js';

// Guard tests use in-memory transports. The final case is a local harness run
// against this worktree's isolated E2E server; it tests the tool, not any cloud.
const staging=candidateTarget('staging-next');
const account={email:'synthetic-candidate@example.invalid',password:'Synthetic-Password-For-Tests-0001',label:'synthetic-test'};
const access={clientId:'access-client-id-0001',clientSecret:'access-client-secret-000000001'};
type Reply={status:number;json?:unknown;text?:string;headers?:Record<string,string>;cookies?:string[];bytes?:number};
function mock(handler:(request:TransportRequest)=>Reply|Promise<Reply>){
  const calls:TransportRequest[]=[];
  const transport:Transport=async request=>{
    calls.push(request);
    const reply=await handler(request),headers=new Headers({'cache-control':'no-store',...(reply.json!==undefined||reply.text!==undefined?{'content-type':'application/json'}:{}),...reply.headers});
    for(const cookie of reply.cookies??[])headers.append('set-cookie',cookie);
    const body=reply.text!==undefined?Buffer.from(reply.text):reply.json!==undefined?Buffer.from(JSON.stringify(reply.json)):Buffer.alloc(reply.bytes??0);
    return {status:reply.status,headers,body};
  };
  return {transport,calls};
}
// Synthetic release SHA; mocks use the Worker health shape from apps/platform-api/src/worker.ts.
const sha='0123456789abcdef0123456789abcdef01234567';
const health=(overrides={})=>({status:'ok',mode:'staging',version:'1.2.3',money_movement_enabled:false,official:false,runtime:'cloudflare-workers',release_sha:sha,...overrides});
const base=(phases:PhaseId[],extra={})=>({target:staging,run:'execute' as const,phases:selectPhases(phases),expectedVersion:'1.2.3',expectedReleaseSha:sha,contract:metadata,...extra});

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
    // Plan may omit the release SHA; health is then marked as needing it for execute.
    expect(report.expected_release_sha).toBeNull();
    expect(report.phases.find(p=>p.id==='health')).toMatchObject({status:'not_run',reason:'plan_only_execute_requires_expected_release_sha'});
    const withSha=parseArgs(['plan','--target','next','--expected-release-sha',sha.toUpperCase()]);
    expect(withSha.expectedReleaseSha).toBe(sha);
    const planned=await runCandidate({target:withSha.target!,run:'plan',phases:withSha.phases,expectedVersion:'1.2.3',expectedReleaseSha:withSha.expectedReleaseSha,contract:metadata});
    expect(planned).toMatchObject({expected_release_sha:sha,cloud_proof:false,overall:'not_run'});
    expect(planned.phases.find(p=>p.id==='health')).toMatchObject({status:'not_run',reason:'plan_only'});
    expect(used).toBe(0);
  } finally {globalThis.fetch=original;}
});

test('execute requires an exact expected release SHA before any request',async()=>{
  // Every network selection adds health; preflight alone stays networkless.
  for(const phases of [['load'],['protocol'],['assets','anonymous'],['session']])expect(selectPhases(phases),phases.join()).toContain('health');
  expect(selectPhases(['preflight'])).toEqual(['preflight']);
  for(const argv of [['execute','--target','next'],['execute','--target','next','--phases','load']])expect(()=>parseArgs(argv)).toThrow(/--expected-release-sha/);
  for(const value of [sha.slice(1),sha+'0','g'.repeat(40),sha.slice(0,7),'']) expect(()=>parseArgs(['execute','--target','next','--expected-release-sha',value]),value).toThrow();
  expect(parseArgs(['execute','--target','next','--expected-release-sha',sha]).expectedReleaseSha).toBe(sha);
  const original=globalThis.fetch;let used=0;
  globalThis.fetch=(async()=>{used++;throw Error('network');}) as typeof fetch;
  try{await expect(main(['execute','--target','next'],{})).rejects.toThrow(/--expected-release-sha/);}finally{globalThis.fetch=original;}
  expect(used).toBe(0);
  // Library callers get the same guard in preflight: health is blocked, nothing is sent.
  for(const expectedReleaseSha of [null,'abc',sha.toUpperCase()]){
    let requests=0;
    const report=await runCandidate({...base(['health','protocol']),expectedReleaseSha,transport:async()=>{requests++;throw Error('unexpected');}});
    expect(requests,String(expectedReleaseSha)).toBe(0);
    expect(report.phases.find(p=>p.id==='preflight')).toMatchObject({status:'fail',reason:'expected_release_sha_set'});
    expect(report.phases.find(p=>p.id==='health')?.status).toBe('blocked');
    expect(report.cloud_proof).toBe(false);
  }
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
  expect(report).toMatchObject({overall:'pass',cloud_proof:true,expected_release_sha:sha});
  expect(report.phases.find(p=>p.id==='health')!.metrics).toMatchObject({provenance:{runtime:'cloudflare-workers',release_sha:sha}});
  // A network phase that bypasses health (library caller) never claims cloud provenance.
  const {transport:protocolOnly}=mock(()=>({status:200,json:metadata}));
  const bypass=await runCandidate({...base([]),phases:['preflight','protocol'],transport:protocolOnly});
  expect(bypass).toMatchObject({overall:'pass',cloud_proof:false});
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

test('mode, version, Worker runtime and release SHA mismatches fail health and block every dependent phase',async()=>{
  const {runtime:_runtime,release_sha:_release,...legacyNode}=health(),{release_sha:_missing,...noSha}=health();
  for(const [body,check] of [[health({mode:'public'}),'mode_matches_target'],[health({version:'1.2.4'}),'version_matches_expected'],[health({official:true}),'not_official'],[health({commit_sha:'x'}),'exact_fields'],
    [legacyNode,'exact_fields'],[noSha,'exact_fields'],[health({runtime:'node'}),'runtime_cloudflare_workers'],[health({runtime:null}),'runtime_cloudflare_workers'],
    [health({release_sha:'fedcba9876543210fedcba9876543210fedcba98'}),'release_sha_matches_expected'],[health({release_sha:sha.toUpperCase()}),'release_sha_matches_expected'],
    [health({release_sha:sha.slice(0,7)}),'release_sha_matches_expected'],[health({release_sha:null}),'release_sha_matches_expected']] as const){
    const {transport,calls}=mock(()=>({status:200,json:body}));
    const report=await runCandidate({...base(['health','guild-cache']),transport,account});
    expect(report.phases.find(p=>p.id==='health')).toMatchObject({status:'fail',reason:check});
    for(const id of ['session','guild-cache'])expect(report.phases.find(p=>p.id===id)?.status,id).toBe('blocked');
    expect(report.phases.find(p=>p.id==='logout')).toMatchObject({status:'not_run',reason:'no_tool_session'});
    expect(calls.map(call=>new URL(call.url).pathname)).toEqual(['/api/v1/health']);
    expect(report.overall).toBe('fail');expect(report.cloud_proof).toBe(false);
    expect(report.phases.find(p=>p.id==='health')!.metrics?.provenance,check).toBeUndefined();
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

/** Join response override: body version (`raw` is sent verbatim as JSON text) and ETag (null omits it). */
type JoinWire={version?:unknown;raw?:string;etag?:string|null};
/** In-memory candidate for guild-cache: real-shaped routes plus knobs for stale reads, failed cleanup lookups and the join wire shape. */
function guildCandidate(knobs:{stale?:'join'|'leave';failAfterJoin?:'status500'|'throw';startVersion?:number;join?:(version:number)=>JoinWire}={}){
  const csrf='csrf-mock-token-0000000001',userId=randomUUID(),sessions=new Set<string>(),receipts=new Map<string,Reply>();
  let logins=0,state:string|null=null,version=knobs.startVersion??0,joined=false,stale=0,staleEligible=false;
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
      const wire=knobs.join?.(version)??{},etag=wire.etag===undefined?`"${version}"`:wire.etag;
      reply={status:200,...(wire.raw!==undefined?{text:`{"state":"active","aggregate_version":${wire.raw}}`}:{json:{state,aggregate_version:'version' in wire?wire.version:version}}),headers:etag===null?{}:{etag}};}
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

test('guild join accepts an exact strong or edge-weakened ETag for a positive safe body version and always sends a strong If-Match',async()=>{
  const leaveIfMatch=(calls:TransportRequest[])=>calls.filter(call=>call.method==='POST'&&new URL(call.url).pathname.endsWith('/leave')).map(call=>call.headers['If-Match']);
  for(const [etag,kind] of [[(v:number)=>`"${v}"`,'strong'],[(v:number)=>`W/"${v}"`,'weak']] as const){
    const server=guildCandidate({join:v=>({etag:etag(v)})});
    const report=await runCandidate({...base(['guild-cache']),transport:server.transport,account});
    const phase=report.phases.find(p=>p.id==='guild-cache')!;
    expect(phase,kind).toMatchObject({status:'pass',metrics:{join_etag:kind}});
    expect(phase.checks).toContainEqual({id:'join_active_versioned',status:'pass'});
    for(const check of ['stale_version_rejected_412','join_first_read_eligible','leave_first_read_revoked','join_receipt_replayed','retained_receipt_does_not_restore_authority'])expect(phase.checks,check).toContainEqual({id:check,status:'pass'});
    // Stale (version+1), then the real leave: both strong, built from the body version, never the response ETag.
    expect(leaveIfMatch(server.calls)).toEqual(['"2"','"1"']);
    expect(guildCleanup(report)).toBe('restored');expect(server.membership()).toBe('left');
  }
  // At the largest safe body version the stale header is incremented losslessly as a decimal string.
  const max=Number.MAX_SAFE_INTEGER,boundary=guildCandidate({startVersion:max-1,join:v=>({etag:`W/"${v}"`})});
  const edge=await runCandidate({...base(['guild-cache']),transport:boundary.transport,account});
  expect(edge.phases.find(p=>p.id==='guild-cache')).toMatchObject({status:'pass',metrics:{join_etag:'weak'}});
  expect(leaveIfMatch(boundary.calls)).toEqual(['"9007199254740992"','"9007199254740991"']);
});

test('guild join fails on a mismatched or malformed ETag and on any non positive-safe-integer body version, and still restores membership',async()=>{
  const cases:[string,(v:number)=>JoinWire][]=[
    ['mismatch strong',v=>({etag:`"${v+1}"`})],['mismatch weak',v=>({etag:`W/"${v+1}"`})],['missing',()=>({etag:null})],['unquoted',v=>({etag:String(v)})],
    ['half quoted',v=>({etag:`"${v}`})],['leading zero',v=>({etag:`"0${v}"`})],['wildcard',()=>({etag:'*'})],['list',v=>({etag:`"${v}", W/"${v}"`})],
    ['lowercase weak',v=>({etag:`w/"${v}"`})],['weak whitespace',v=>({etag:`W/ "${v}"`})],['inner whitespace',v=>({etag:`" ${v}"`})],
    ['string version',v=>({version:String(v)})],['zero',()=>({version:0,etag:'"0"'})],['negative',()=>({version:-1,etag:'"-1"'})],
    ['fractional',()=>({version:1.5,etag:'"1.5"'})],['nonfinite',()=>({raw:'1e999',etag:'"Infinity"'})],['null',()=>({version:null,etag:'"null"'})],
    ['unsafe',()=>({version:2**53,etag:`"${2**53}"`})],['unsafe raw',()=>({raw:'9007199254740993',etag:'"9007199254740993"'})],
  ];
  for(const [label,join] of cases){
    const server=guildCandidate({join});
    const report=await runCandidate({...base(['guild-cache']),transport:server.transport,account});
    const phase=report.phases.find(p=>p.id==='guild-cache')!;
    expect(phase,label).toMatchObject({status:'fail',reason:'join_active_versioned',metrics:{join_etag:'invalid'}});
    expect(phase.checks.at(-1),label).toEqual({id:'join_active_versioned',status:'fail',note:'etag invalid'});
    expect(report.cloud_proof).toBe(false);
    // No stale or leave write was attempted from the rejected response; cleanup left through a fresh directory read.
    const leaves=server.calls.filter(call=>call.method==='POST'&&new URL(call.url).pathname.endsWith('/leave'));
    expect(leaves,label).toHaveLength(1);expect(leaves[0].headers['If-Match']).toBe('"1"');
    expect(guildCleanup(report),label).toBe('restored');expect(server.membership(),label).toBe('left');
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
 * Scripted browser for route lifecycle regressions. Requests go through the tool's route
 * handler as in Playwright, where the route event is not awaited: a rejected handler is an
 * unhandled rejection, so here it is collected in `escaped`. No network, no real page.
 */
type RouteScript={fetch?:(path:string,closed:Promise<void>)=>unknown;fulfill?:(path:string)=>void;abort?:(path:string,isClosed:boolean)=>void;closeError?:Error};
const browserCookie='B'.repeat(43);
function scriptedBrowser(script:RouteScript){
  const log={escaped:[] as unknown[],fetched:[] as string[],aborted:[] as string[],fulfilled:[] as string[],pagesClosed:0,contextClosed:false};
  let handler:((route:unknown)=>Promise<unknown>)|null=null,jar:Record<string,unknown>[]=[],markClosed=()=>{};
  const closed=new Promise<void>(resolve=>{markClosed=resolve;});
  const request=async(path:string)=>{
    let outcome='none';
    const route={
      request:()=>({url:()=>staging.origin+path,headers:()=>({accept:'*/*'})}),
      continue:async()=>{},
      fetch:async()=>{log.fetched.push(path);return await script.fetch?.(path,closed)??{status:200};},
      fulfill:async()=>{script.fulfill?.(path);outcome='fulfilled';log.fulfilled.push(path);},
      abort:async()=>{script.abort?.(path,log.contextClosed);outcome='aborted';log.aborted.push(path);},
    };
    await handler!(route).catch(error=>{log.escaped.push(error);});
    return outcome;
  };
  const navigate=async()=>{if(await request('/')!=='fulfilled')throw new Error(`net::ERR_FAILED at ${staging.origin}/`);return {status:()=>200};};
  const page={
    on(){},goto:navigate,reload:navigate,evaluate:async()=>'',getByLabel:()=>({fill:async()=>{}}),
    getByRole:(_role:string,{name}:{name:string})=>({waitFor:async()=>{},click:async()=>{
      if(name==='登入'){await request('/api/v1/auth/login');jar=[{name:'freedom_local_session',value:browserCookie,secure:true,httpOnly:true,sameSite:'Strict'}];void request('/api/v1/work-items');}
      else{await request('/api/v1/auth/logout');jar=[];}
    }}),
    // A request the page starts while teardown runs.
    close:async()=>{log.pagesClosed++;void request('/api/v1/late');},
  };
  const context={
    route:async(_pattern:string,h:(route:unknown)=>Promise<unknown>)=>{handler=h;},newPage:async()=>page,on(){},pages:()=>[page],cookies:async()=>jar,
    close:async()=>{log.contextClosed=true;markClosed();if(script.closeError)throw script.closeError;},
  };
  return {browser:{newContext:async()=>context} as BrowserLike,log};
}
/** Candidate API for browser tests: the tool session plus the browser's session cookie. */
function browserCandidate(){
  const csrf='csrf-browser-mock-00000001',userId=randomUUID(),sessions=new Set([browserCookie]);let logins=0;
  const server=mock(request=>{
    const path=new URL(request.url).pathname,cookie=/^freedom_local_session=(.+)$/.exec(request.headers.Cookie??'')?.[1];
    if(path==='/api/v1/health')return {status:200,json:health()};
    if(path==='/api/v1/auth/login'){const value=`T${++logins}`.padEnd(43,'x');sessions.add(value);
      return {status:200,json:{user:{user_id:userId,email:account.email},csrf_token:csrf},cookies:[`freedom_local_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`]};}
    if(!cookie||!sessions.has(cookie))return {status:401,json:{code:cookie?'session_expired':'login_required'}};
    if(path==='/api/v1/session')return {status:200,json:{user:{user_id:userId},csrf_token:csrf}};
    if(path==='/api/v1/auth/logout'){
      if(request.headers.Origin!==staging.origin)return {status:403,json:{code:'origin_rejected'}};
      if(request.headers['X-CSRF-Token']!==csrf)return {status:403,json:{code:'csrf_rejected'}};
      sessions.delete(cookie);return {status:200,json:{},cookies:['freedom_local_session=; Path=/; Max-Age=0']};
    }
    return {status:404,json:{code:'not_found'}};
  });
  return {...server,sessions};
}
async function withoutUnhandled<T>(run:()=>Promise<T>){
  const seen:unknown[]=[],listener=(error:unknown)=>{seen.push(error);};
  process.on('unhandledRejection',listener);
  try{const result=await run();await new Promise(resolve=>setTimeout(resolve,50));return {result,unhandled:seen};}
  finally{process.off('unhandledRejection',listener);}
}
const targetClosed=()=>Object.assign(new Error(`Target page, context or browser has been closed ${staging.origin}/api/v1/work-items`),{name:'TargetClosedError'});

test('browser route: a failing route.fetch is aborted, reported by error class only and never escapes',async()=>{
  const server=browserCandidate();
  const {browser,log}=scriptedBrowser({fetch:path=>{if(path==='/')throw new TypeError(`fetch failed ${staging.origin}/?token=${access.clientSecret}`);}});
  const {result:report,unhandled}=await withoutUnhandled(()=>runCandidate({...base(['browser']),transport:server.transport,account,access,browser}));
  expect(unhandled).toEqual([]);expect(log.escaped).toEqual([]);
  const phase=report.phases.find(p=>p.id==='browser')!;
  // The navigation error stays the reason; the routing failure is recorded beside it.
  expect(phase).toMatchObject({status:'fail',reason:'Error'});
  expect(phase.checks).toContainEqual({id:'no_routing_failures',status:'fail',note:'see metrics.routing_failures'});
  expect(phase.metrics).toMatchObject({routing_failures:{'fetch:TypeError':1},routing_failures_during_teardown:{},teardown:{context_close:'ok',routes_pending_after_close:0}});
  expect(log.fetched).toEqual(['/']);expect(log.fulfilled).toEqual([]);expect(log.aborted).toEqual(['/','/api/v1/late']);
  expect(report.cleanup.items).toContainEqual({phase:'browser',item:'browser session of the synthetic account',state:'restored'});
  expect(report.overall).toBe('fail');expect(report.cloud_proof).toBe(false);
  const text=JSON.stringify(report);
  for(const secret of ['fetch failed','token=','net::ERR_FAILED',access.clientSecret])expect(text).not.toContain(secret);
});

test('browser route: fulfill failing then abort "already handled" is contained, reported, and the browser session is still revoked',async()=>{
  const server=browserCandidate();let pages=0;
  const {browser,log}=scriptedBrowser({
    // The reload's fulfill fails after Playwright marked the route handled, so the abort throws too.
    fulfill:path=>{if(path==='/'&&++pages===2)throw new Error(`Protocol error (Fetch.fulfillRequest): Invalid InterceptionId ${staging.origin}/`);},
    abort:path=>{if(path==='/')throw new Error('Route is already handled!');},
  });
  const {result:report,unhandled}=await withoutUnhandled(()=>runCandidate({...base(['session','browser']),transport:server.transport,account,access,browser}));
  expect(unhandled).toEqual([]);expect(log.escaped).toEqual([]);
  const phase=report.phases.find(p=>p.id==='browser')!;
  expect(phase).toMatchObject({status:'fail',reason:'Error'});
  expect(phase.metrics!.routing_failures).toEqual({'fulfill:Error':1,'abort_after_fulfill:Error':1});
  expect(phase.checks).toContainEqual({id:'no_routing_failures',status:'fail',note:'see metrics.routing_failures'});
  // UI logout never ran: teardown revoked the browser's cookie through the exact-origin client.
  expect(server.sessions.has(browserCookie)).toBe(false);
  const revoke=server.calls.filter(call=>call.headers.Cookie===`freedom_local_session=${browserCookie}`);
  expect(revoke.map(call=>`${call.method} ${new URL(call.url).pathname}`)).toEqual(['GET /api/v1/session','POST /api/v1/auth/logout']);
  expect(revoke.every(call=>new URL(call.url).origin===staging.origin&&call.headers['CF-Access-Client-Id']===access.clientId)).toBe(true);
  expect(report.cleanup.items).toContainEqual({phase:'browser',item:'browser session of the synthetic account',state:'restored'});
  // The API tool session is still logged out by its own phase.
  expect(report.phases.find(p=>p.id==='logout')?.status).toBe('pass');
  expect([...server.sessions]).toEqual([]);
  const text=JSON.stringify(report);
  for(const secret of ['already handled','InterceptionId',browserCookie])expect(text).not.toContain(secret);
});

test('browser teardown: routes pending at context close are drained, nothing new is fetched, and close failures are reported',async()=>{
  // A background request whose fetch only settles when the context closes.
  const pendingUntilClose:RouteScript={
    fetch:async(path,closed)=>{if(path==='/api/v1/work-items'){await closed;throw targetClosed();}},
    abort:(path,isClosed)=>{if(path==='/api/v1/work-items'&&isClosed)throw targetClosed();},
  };
  const server=browserCandidate(),{browser,log}=scriptedBrowser(pendingUntilClose);
  const {result:report,unhandled}=await withoutUnhandled(()=>runCandidate({...base(['browser']),transport:server.transport,account,access,browser,browserDrainMs:100}));
  expect(unhandled).toEqual([]);expect(log.escaped).toEqual([]);
  const phase=report.phases.find(p=>p.id==='browser')!;
  expect(phase.status).toBe('pass');
  expect(phase.checks).toContainEqual({id:'browser_teardown_clean',status:'pass'});
  expect(phase.metrics).toMatchObject({
    routing_failures:{},
    routing_failures_during_teardown:{'fetch:TargetClosedError':1,'abort_after_fetch:TargetClosedError':1},
    teardown:{routes_pending_at_close:1,context_close:'ok',routes_pending_after_close:0},
  });
  // Started during teardown: aborted before any fetch.
  expect(log.fetched).not.toContain('/api/v1/late');expect(log.aborted).toContain('/api/v1/late');
  expect(log.pagesClosed).toBe(1);expect(log.contextClosed).toBe(true);
  expect(phase.metrics!.teardown).toMatchObject({unexpected_routing_failures:0});
  expect(report.cleanup.items).toContainEqual({phase:'browser',item:'browser session of the synthetic account',state:'restored'});
  expect(JSON.stringify(report)).not.toContain('Target page');

  // A failing context.close is contained and fails the phase with its class.
  const failing=browserCandidate(),scripted=scriptedBrowser({...pendingUntilClose,closeError:Object.assign(new Error(`close ${staging.origin}`),{name:'ProtocolError'})});
  const {result:closeReport,unhandled:closeUnhandled}=await withoutUnhandled(()=>runCandidate({...base(['session','browser']),transport:failing.transport,account,access,browser:scripted.browser,browserDrainMs:100}));
  expect(closeUnhandled).toEqual([]);expect(scripted.log.escaped).toEqual([]);
  expect(closeReport.phases.find(p=>p.id==='browser')).toMatchObject({status:'fail',reason:'browser_teardown_clean',metrics:{teardown:{context_close:'ProtocolError',routes_pending_after_close:0}}});
  expect(closeReport.phases.find(p=>p.id==='logout')?.status).toBe('pass');
});

test('browser teardown: an unexpected fetch rejection settling at context close fails browser_teardown_clean',async()=>{
  const server=browserCandidate(),{browser,log}=scriptedBrowser({
    fetch:async(path,closed)=>{if(path==='/api/v1/work-items'){await closed;throw new TypeError(`fetch failed ${staging.origin}/api/v1/work-items?token=${access.clientSecret}`);}},
    abort:(path,isClosed)=>{if(path==='/api/v1/work-items'&&isClosed)throw targetClosed();},
  });
  const {result:report,unhandled}=await withoutUnhandled(()=>runCandidate({...base(['browser']),transport:server.transport,account,access,browser,browserDrainMs:100}));
  expect(unhandled).toEqual([]);expect(log.escaped).toEqual([]);
  const phase=report.phases.find(p=>p.id==='browser')!;
  expect(phase).toMatchObject({status:'fail',reason:'browser_teardown_clean'});
  // The in-session check passed; the failure is attributed to teardown, not hidden in a metric.
  expect(phase.checks).toContainEqual({id:'no_routing_failures',status:'pass'});
  expect(phase.checks.at(-1)).toEqual({id:'browser_teardown_clean',status:'fail',note:'see metrics.teardown'});
  expect(phase.metrics).toMatchObject({
    routing_failures:{},
    routing_failures_during_teardown:{'fetch:TypeError':1,'abort_after_fetch:TargetClosedError':1},
    teardown:{routes_pending_at_close:1,context_close:'ok',routes_pending_after_close:0,unexpected_routing_failures:1},
  });
  expect(log.fetched).not.toContain('/api/v1/late');expect(log.contextClosed).toBe(true);
  expect(report.cleanup.items).toContainEqual({phase:'browser',item:'browser session of the synthetic account',state:'restored'});
  expect(report.overall).toBe('fail');expect(report.cloud_proof).toBe(false);
  const text=JSON.stringify(report);
  for(const secret of ['fetch failed','token=',access.clientSecret])expect(text).not.toContain(secret);
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
    expect(report).toMatchObject({harness:'local_harness',cloud_proof:false,overall:'incomplete',expected_release_sha:null});
    // The local Node server has no runtime or release_sha; the harness proves no deployed SHA.
    const healthPhase=report.phases.find(p=>p.id==='health')!;
    expect(healthPhase.metrics).toMatchObject({provenance:'not_asserted_local_node'});
    expect(healthPhase.checks.map(check=>check.id)).not.toContain('release_sha_matches_expected');
    expect(report.statement).toMatch(/not evidence of any cloud deployment/);
    // The signed-in shell requests inbox previews by itself; every one was aborted, none answered.
    for(const prefix of ['/api/v1/me/notifications','/api/v1/me/conversations'])expect(inbox.requested.some(path=>path===prefix),prefix).toBe(true);
    expect(inbox.responses).toBe(0);
    expect(inbox.failed).toHaveLength(inbox.requested.length);
    expect(inbox.failed.every(text=>/BLOCKED_BY_CLIENT/.test(text))).toBe(true);
    const browserPhase=report.phases.find(p=>p.id==='browser')!;
    expect(browserPhase.metrics).toMatchObject({inbox_requests_blocked:inbox.requested.length,member_inbox:'not_covered'});
    expect(browserPhase.checks).toContainEqual({id:'no_inbox_response_received',status:'pass'});
    for(const check of ['no_routing_failures','browser_teardown_clean'])expect(browserPhase.checks).toContainEqual({id:check,status:'pass'});
    expect(browserPhase.metrics).toMatchObject({routing_failures:{},teardown:{context_close:'ok',routes_pending_after_close:0}});
    expect(report.cleanup.items).toContainEqual({phase:'browser',item:'browser session of the synthetic account',state:'restored'});
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
