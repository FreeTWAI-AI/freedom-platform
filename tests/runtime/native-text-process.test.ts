import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeTextBindingSchema, type NativeTextBinding } from '../../contracts/execution/v3/native-text-invocation.js';
import { createNativeTextStartAuthority, createSyntheticNativeTextProcessAdapter, createGrokNativeTextProcessAdapter } from '../../modules/agent-execution/adapters/native-text-process.js';
import { nativeDigest } from '../../modules/agent-execution/adapters/native-text-profile.js';
import { AdapterFault, type CliArtifact } from '../../modules/agent-execution/adapters/common.js';

let directory: string, marker: string;
const artifacts = new Map<number,CliArtifact>();
const context = () => new TextEncoder().encode('{"schema":"native-text.context/v1","title":"Synthetic","objective":"SYNTHETIC PRIVATE CONTEXT"}');
function binding(): NativeTextBinding {
  const id = randomUUID, now = Date.now(), bytes = context();
  return NativeTextBindingSchema.parse({ profile:'freedom.native-text.binding/v1',adapterProfile:'grok-1.0.46-text/v1',
    dispatchId:id(),attemptId:id(),runId:id(),workId:id(),ownerPrincipalId:id(),scopeId:id(),environment:'local',clientId:'agent-kit',
    runtimeDeviceId:id(),connectionId:id(),familyId:id(),deviceKeyThumbprint:'a'.repeat(43),grantId:id(),grantVersion:'1',
    modelConnectionId:id(),modelVersion:'1',approvalId:id(),approvalVersion:'1',inputWorkVersion:'1',runVersion:'2',
    runtimeVersion:'1',connectionVersion:'1',taskLeaseEpoch:'2',controlEpoch:'1',exportPolicyId:id(),exportPolicyRevision:'1',
    persistencePolicyRevision:'private-work.v1',recoveryGeneration:'1',requestedModelRef:'grok-4.7',expectedReportedModelRef:'grok-4.7-build',
    engineLocation:'runtime_local',processingLocation:'provider_remote',credentialCustody:'runtime_cli',billingSource:'owner_cli',
    artifactCustody:'platform_asset',capability:'assisted_local',contextSha256:nativeDigest(bytes),inputByteSize:bytes.length,
    activatedAt:new Date(now).toISOString(),leaseExpiresAt:new Date(now+90000).toISOString(),wallTimeoutMs:3000,
    maxLocalDispatches:1,providerCallLimit:'unknown',monetaryLimit:'unknown' });
}
const claim = () => { const now = Date.now(); return {issuedAt:new Date(now).toISOString(),startExpiresAt:new Date(now+5000).toISOString()}; };
const authority = () => createNativeTextStartAuthority({claim:async()=>claim(),assertCurrent:async()=>{}});
async function rejects(code: string, work: Promise<unknown>) {
  await assert.rejects(work,(e: unknown)=>e instanceof AdapterFault && e.code===code && !e.message.includes('PRIVATE'));
}
async function owned(): Promise<string[]> {
  const pids = (await readdir('/proc')).filter(x=>/^[0-9]+$/.test(x));
  const rows = await Promise.all(pids.map(async p=>[p,(await readFile(`/proc/${p}/comm`,'utf8').catch(()=>'' )).trim()]));
  return rows.filter(([,name])=>name===marker).map(([pid])=>pid);
}
async function noOwned() { for(let n=0;n<100;n++){if(!(await owned()).length)return;await delay(20);}assert.deepEqual(await owned(),[]); }
before(async()=>{
  assert.equal(process.platform,'linux','Actual native process tests require Linux; do not report a skipped pass.');
  assert.equal(process.arch,'x64');
  directory=await mkdtemp(join(tmpdir(),'fp-native-text-')); marker=`nt_${directory.slice(-8)}`;
  const sentinel=join(directory,'private-freedom-sentinel');await writeFile(sentinel,'PRIVATE FREEDOM HOST DATA');
  const controls=JSON.stringify({profile:'synthetic.native-text.controls/v1',tools:[],mcpServers:[],plugins:[],hooks:[],subagents:[],network:'denied',credentials:'none'});
  const good=JSON.stringify({profile:'synthetic.native-text.output/v1',stopReason:'end_turn',model:'grok-4.7-build',text:'Synthetic draft',tools:[]});
  const source=`#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <arpa/inet.h>
int main(int argc,char **argv){
 if(argc>2 && strcmp(argv[argc-2],"inspect")==0){
  if(MODE==1) puts("{\\\"profile\\\":\\\"synthetic.native-text.controls/v1\\\",\\\"tools\\\":[\\\"bash\\\"]}");
  else {if(MODE==10)usleep(1200000);puts(${JSON.stringify(controls)});}return 0;
 }
 prctl(PR_SET_NAME,${JSON.stringify(marker)},0,0,0);
 if(MODE==2){char out[4096];memset(out,'x',sizeof(out));for(int i=0;i<18;i++)write(1,out,sizeof(out));return 0;}
 if(MODE==3){fprintf(stderr,"PRIVATE SYNTHETIC SECRET");return 0;}
 if(MODE==4){if(fork()==0){setsid();for(;;)pause();}for(;;)pause();}
 if(MODE==5){puts("{\\\"profile\\\":\\\"synthetic.native-text.output/v1\\\",\\\"model\\\":\\\"other\\\"}");return 0;}
 if(MODE==6){puts("{\\\"tool_call\\\":\\\"bash\\\"}");return 0;}
 if(MODE==7){puts("{malformed");return 0;}
 if(MODE==8)return 1;
 if(MODE==9){if(fork()==0){setsid();for(;;)pause();}}
 char cwd[128];getcwd(cwd,sizeof(cwd));
 if(strcmp(cwd,"/workspace")!=0 || getenv("FREEDOM_ACCESS_TOKEN") || getenv("OPENAI_API_KEY") || getenv("HTTPS_PROXY") || access(${JSON.stringify(sentinel)},F_OK)==0)return 31;
 int empty_tools=0;for(int i=1;i<argc;i++){if(strstr(argv[i],"PRIVATE"))return 32;if(strcmp(argv[i],"--tools")==0 && i+1<argc && strlen(argv[i+1])==0)empty_tools=1;}if(!empty_tools)return 33;
 struct sockaddr_in addr={0};addr.sin_family=AF_INET;addr.sin_port=htons(9);inet_pton(AF_INET,"198.51.100.1",&addr.sin_addr);
 int sock=socket(AF_INET,SOCK_STREAM,0);fcntl(sock,F_SETFL,O_NONBLOCK);errno=0;int conn=connect(sock,(struct sockaddr*)&addr,sizeof(addr));if(conn>=0||errno!=ENETUNREACH)return 34;close(sock);
 char input[16385];int size=0,n=0;while((n=read(0,input+size,16384-size))>0)size+=n;input[size]=0;
 if(size==0||!strstr(input,"SYNTHETIC PRIVATE CONTEXT"))return 35;
 puts(${JSON.stringify(good)});return 0;
}`;
  const src=join(directory,'fixture.c');await writeFile(src,source);
  for(let mode=0;mode<=10;mode++){
    const executable=join(directory,`fixture-${mode}`);
    const result=spawnSync('/usr/bin/cc',['-O2',`-DMODE=${mode}`,'-o',executable,src],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:15000,maxBuffer:16384});
    assert.equal(result.status,0,result.stderr);
    artifacts.set(mode,{executable,version:'0.0.1',sha256:nativeDigest(await readFile(executable))});
  }
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});

test('real pinned subprocess receives only stdin context, fixed args and no Freedom/ambient credentials or network',async()=>{
  const adapter=createSyntheticNativeTextProcessAdapter(artifacts.get(0)!);
  assert.equal((await adapter.assess()).support,'synthetic_only');
  const previous=process.env.FREEDOM_ACCESS_TOKEN;process.env.FREEDOM_ACCESS_TOKEN='PRIVATE SYNTHETIC TOKEN';
  try {
    const b=binding(),a=authority(),input=context();
    const result=await adapter.invoke(b,a,async()=>input);
    assert.equal(result.text,'Synthetic draft');assert.equal(result.receipt.evidenceOrigin,'synthetic_local_fixture');
    assert.equal(result.receipt.outcome,'observed_success');assert.equal(result.receipt.providerCalls,'unknown');assert.equal(result.receipt.costStatus,'unknown');
    assert.equal(result.receipt.operational_authority,false);assert.equal(JSON.stringify(result.receipt).includes('PRIVATE'),false);
    assert.equal(input.every(x=>x===0),true);
    await rejects('execution_authority_unavailable',adapter.invoke(b,a,async()=>context()));
  } finally {if(previous===undefined)delete process.env.FREEDOM_ACCESS_TOKEN;else process.env.FREEDOM_ACCESS_TOKEN=previous;}
  await noOwned();
});

test('unavailable effective controls stop before claim/context, copied authority and foreign environment cannot invoke',async()=>{
  let calls=0;
  const a=createNativeTextStartAuthority({claim:async()=>{calls++;return claim();},assertCurrent:async()=>{calls++;}});
  const load=async()=>{calls++;return context();};
  await rejects('effective_tool_policy_unavailable',createSyntheticNativeTextProcessAdapter(artifacts.get(1)!).invoke(binding(),a,load));
  assert.equal(calls,0);
  await rejects('execution_authority_unavailable',createSyntheticNativeTextProcessAdapter(artifacts.get(0)!).invoke(binding(),JSON.parse(JSON.stringify(a)),load));
  await rejects('unsupported_selection',createSyntheticNativeTextProcessAdapter(artifacts.get(0)!).invoke({...binding(),environment:'next'},a,load));
  assert.equal(calls,0);
});

test('claim ACK loss, invalid start windows, revocation and changed context consume the dispatch without retry',async()=>{
  const adapter=createSyntheticNativeTextProcessAdapter(artifacts.get(0)!);
  let claims=0,loads=0;
  const b=binding(),a=createNativeTextStartAuthority({claim:async()=>{claims++;throw Error('PRIVATE LOST ACK');},assertCurrent:async()=>{}});
  await rejects('outcome_unknown',adapter.invoke(b,a,async()=>{loads++;return context();}));
  await rejects('execution_authority_unavailable',adapter.invoke(b,a,async()=>context()));assert.equal(claims,1);assert.equal(loads,0);
  const tooLong=createNativeTextStartAuthority({claim:async()=>{const c=claim();return {...c,startExpiresAt:new Date(Date.parse(c.issuedAt)+5001).toISOString()};},assertCurrent:async()=>{}});
  await rejects('outcome_unknown',adapter.invoke(binding(),tooLong,async()=>context()));
  let checks=0;
  const revoked=createNativeTextStartAuthority({claim:async()=>claim(),assertCurrent:async()=>{if(++checks===2)throw Error('REVOKED');}});
  await rejects('outcome_unknown',adapter.invoke(binding(),revoked,async()=>context()));assert.equal(checks,2);
  await rejects('outcome_unknown',adapter.invoke(binding(),authority(),async()=>new TextEncoder().encode('tampered')));
});

test('concurrent attempts sharing one dispatch call the trusted claim port at most once',async()=>{
  let claims=0;
  const a=createNativeTextStartAuthority({claim:async()=>{claims++;await delay(30);return claim();},assertCurrent:async()=>{}});
  const adapter=createSyntheticNativeTextProcessAdapter(artifacts.get(0)!),b=binding();
  const outcomes=await Promise.allSettled([adapter.invoke(b,a,async()=>context()),adapter.invoke(b,a,async()=>context())]);
  assert.equal(claims,1);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
});

test('90-second lease ceiling and expired 5-second start authority block before native inference',async()=>{
  const adapter=createSyntheticNativeTextProcessAdapter(artifacts.get(0)!);const b=binding();let loads=0;
  await rejects('invalid_input',adapter.invoke({...b,leaseExpiresAt:new Date(Date.parse(b.activatedAt)+90001).toISOString()},authority(),async()=>{loads++;return context();}));
  const expired=createNativeTextStartAuthority({claim:async()=>{const now=Date.now();return{issuedAt:new Date(now).toISOString(),startExpiresAt:new Date(now+10).toISOString()};},assertCurrent:async()=>{await delay(20);}});
  await rejects('outcome_unknown',adapter.invoke(binding(),expired,async()=>{loads++;return context();}));
  assert.equal(loads,0);await noOwned();
});

test('real oversized stdout, stderr secrets, mismatched model, tool calls, malformed JSON and nonzero exit are unknown',async()=>{
  for(const mode of [2,3,5,6,7,8])await rejects('outcome_unknown',createSyntheticNativeTextProcessAdapter(artifacts.get(mode)!).invoke(binding(),authority(),async()=>context()));
  await noOwned();
});

test('timeout and abort kill owned process namespace including setsid descendants, without resubmission',async()=>{
  const adapter=createSyntheticNativeTextProcessAdapter(artifacts.get(4)!);
  const b={...binding(),wallTimeoutMs:100};const a=authority();const started=Date.now();
  await rejects('outcome_unknown',adapter.invoke(b,a,async()=>context()));assert.ok(Date.now()-started<2500);await noOwned();
  await rejects('execution_authority_unavailable',adapter.invoke(b,a,async()=>context()));
  const controller=new AbortController(),pending=adapter.invoke(binding(),authority(),async()=>context(),controller.signal);
  let seen=false;for(let n=0;n<100;n++){if((await owned()).length){seen=true;break;}await delay(10);}assert.equal(seen,true);
  controller.abort();await rejects('outcome_unknown',pending);await noOwned();
});

test('immediate parent exit with descendant-held pipe is bounded; stale authority after observed output suppresses result',async()=>{
  const started=Date.now();assert.equal((await createSyntheticNativeTextProcessAdapter(artifacts.get(9)!).invoke(binding(),authority(),async()=>context())).text,'Synthetic draft');
  assert.ok(Date.now()-started<2500);await noOwned();
  let checks=0;const a=createNativeTextStartAuthority({claim:async()=>claim(),assertCurrent:async()=>{if(++checks===3)throw Error('REVOKED AFTER OUTPUT');}});
  await rejects('outcome_unknown',createSyntheticNativeTextProcessAdapter(artifacts.get(0)!).invoke(binding(),a,async()=>context()));assert.equal(checks,3);
});

test('original executable mutation after claim cannot change the FD-pinned bytes; next invocation rejects',async()=>{
  const original=artifacts.get(0)!,executable=join(directory,'mutable');await writeFile(executable,await readFile(original.executable));await chmod(executable,0o700);
  const adapter=createSyntheticNativeTextProcessAdapter({...original,executable});
  const a=createNativeTextStartAuthority({claim:async()=>{await writeFile(executable,'mutated original');return claim();},assertCurrent:async()=>{}});
  assert.equal((await adapter.invoke(binding(),a,async()=>context())).text,'Synthetic draft');
  await rejects('artifact_mismatch',adapter.invoke(binding(),authority(),async()=>context()));
});

test('Grok production profile cannot be turned on with a fixture binary or public authority metadata',async()=>{
  let calls=0;const adapter=createGrokNativeTextProcessAdapter(artifacts.get(0)!.executable);
  assert.equal((await adapter.assess()).support,'unavailable');
  await rejects('artifact_mismatch',adapter.invoke(binding(),authority(),async()=>{calls++;return context();}));
  assert.equal(calls,0);
});

for (const future of [false, true]) test((future ? 'future' : 'expired') + ' lease does not consume claim authority or load context', async () => {
  const adapter = createSyntheticNativeTextProcessAdapter(artifacts.get(0)!);
    const b = binding(), now = Date.now();
    const invalid = { ...b, activatedAt: new Date(now + (future ? 60000 : -90000)).toISOString(),
      leaseExpiresAt: new Date(now + (future ? 150000 : -1)).toISOString() };
    let claims = 0, loads = 0;
    const a = createNativeTextStartAuthority({ claim: async () => { claims++; return claim(); }, assertCurrent: async () => {} });
    await rejects('execution_authority_unavailable', adapter.invoke(invalid, a, async () => { loads++; return context(); }));
    assert.equal(claims, 0); assert.equal(loads, 0);
    const valid = { ...b, activatedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 90000).toISOString() };
    assert.equal((await adapter.invoke(valid, a, async () => { loads++; return context(); })).text, 'Synthetic draft');
    assert.equal(claims, 1); assert.equal(loads, 1);
});

test('lease expiry during the real native controls probe is rechecked before the one-use claim', async () => {
  const adapter = createSyntheticNativeTextProcessAdapter(artifacts.get(10)!);
  let claims = 0, loads = 0;
  const a = createNativeTextStartAuthority({ claim: async () => { claims++; return claim(); }, assertCurrent: async () => {} });
  const b = binding(), short = { ...b, leaseExpiresAt: new Date(Date.now() + 1000).toISOString() };
  await rejects('execution_authority_unavailable', adapter.invoke(short, a, async () => { loads++; return context(); }));
  assert.equal(claims, 0); assert.equal(loads, 0);
  assert.equal((await adapter.invoke({ ...b, activatedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now()+90000).toISOString() }, a,
    async () => { loads++; return context(); })).text, 'Synthetic draft');
  assert.equal(claims, 1); assert.equal(loads, 1); await noOwned();
});
