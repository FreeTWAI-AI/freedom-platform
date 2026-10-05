import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,chmod,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {createAcceptanceEgress,durableCreate,privateKeyBytes,reserveSessionBudget} from '../../scripts/lib/openrouter-acceptance-guard.js';
const budget=()=>({model:'openai/gpt-4.1-mini',expiresAt:new Date(Date.now()+3600000).toISOString(),maxUsd:10});
const request=(path:string,body?:unknown)=>new Request('https://openrouter.ai/api/v1/'+path,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer synthetic-test-only'},...(body?{body:JSON.stringify(body)}:{})});
const body={model:'openai/gpt-4.1-mini',max_completion_tokens:128,stream:false,tools:[],provider:{allow_fallbacks:false}};
test('acceptance private writes and credential reads reject overwrite, symlink, loose mode and whitespace',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-acceptance-'));try {
    await durableCreate(join(directory,'intent.json'),{synthetic:true});await assert.rejects(durableCreate(join(directory,'intent.json'),{}));
    const key=join(directory,'key');await writeFile(key,'sk-or-v1-synthetic-only',{mode:0o600});
    const bytes=await privateKeyBytes(key);assert.equal(bytes.toString(),'sk-or-v1-synthetic-only');bytes.fill(0);
    await symlink(key,join(directory,'link'));await assert.rejects(privateKeyBytes(join(directory,'link')));
    await chmod(key,0o644);await assert.rejects(privateKeyBytes(key));await chmod(key,0o600);
    await writeFile(key,'sk-or-v1-synthetic-only\n');await assert.rejects(privateKeyBytes(key));
    await chmod(directory,0o755);await assert.rejects(durableCreate(join(directory,'blocked'),{}));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('shared session reservations include prior calls and never release a spent or unknown slot',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-acceptance-'));try {
    const b=budget();await durableCreate(join(directory,'session.json'),{profile:'private-ai.provider-session-ledger/v1',maxUsd:10,
      expiresAt:b.expiresAt,priorReservedUsd:9.9,priorKnownCostUsd:0.0000532});
    const id=randomUUID();assert.equal((await reserveSessionBudget(directory,id,b)).sessionReservedUsd,10);
    await assert.rejects(reserveSessionBudget(directory,randomUUID(),b));await assert.rejects(reserveSessionBudget(directory,id,b));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('real egress gate durably fences exactly one POST, retains timeout as unknown and never persists key/body',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-acceptance-'));try {
    const b=budget();let posts=0;
    const transport:typeof fetch=async(raw,init)=>{
      const path=new URL(String(raw)).pathname;
      if(init?.method==='POST'){
        const intent=JSON.parse(await readFile(join(directory,'dispatch-intent.json'),'utf8'));assert.equal(intent.maxPosts,1);
        posts++;throw Error('synthetic-sensitive-error-never-exposed');
      }
      return Response.json({data:path.endsWith('/key')?{limit:10,usage:0,limit_reset:'daily',expires_at:b.expiresAt}:
        {id:b.model,pricing:{prompt:'0.0000004',completion:'0.0000016'}}});
    };
    const gate=createAcceptanceEgress(b,directory,transport);
    assert.equal((await gate.forward(request('key'))).status,200);
    assert.equal((await gate.forward(request('model/'+b.model))).status,200);
    const replies=await Promise.all([gate.forward(request('chat/completions',body)),gate.forward(request('chat/completions',body))]);
    assert(replies.every(r=>r.status===503));assert.equal(posts,1);assert.equal(gate.summary().dispatchUnknown,true);
    const restarted=createAcceptanceEgress(b,directory,transport);
    await restarted.forward(request('key'));await restarted.forward(request('model/'+b.model));
    assert.equal((await restarted.forward(request('chat/completions',body))).status,503);assert.equal(posts,1);
    const persisted=await readFile(join(directory,'dispatch-intent.json'),'utf8');assert(!persisted.includes('Bearer'));assert(!persisted.includes('tools'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('egress rejects foreign destinations, missing budget, high prices, expiry and changed dispatch cap before transport',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-acceptance-'));try {
    const b=budget();let calls=0;
    const transport:typeof fetch=async(raw)=>{calls++;return Response.json({data:String(raw).endsWith('/key')?{limit:10,usage:0,expires_at:b.expiresAt}:
      {id:b.model,pricing:{prompt:'1',completion:'1'}}});};
    const gate=createAcceptanceEgress(b,directory,transport);
    assert.equal((await gate.forward(new Request('https://example.invalid/'))).status,503);
    assert.equal((await gate.forward(request('chat/completions',body))).status,503);assert.equal(calls,0);
    await gate.forward(request('key'));assert.equal((await gate.forward(request('model/'+b.model))).status,503);
    assert.equal((await gate.forward(request('chat/completions',{...body,max_completion_tokens:129}))).status,503);assert.equal(calls,2);
    assert.throws(()=>createAcceptanceEgress({...b,expiresAt:new Date(0).toISOString()},directory,transport));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('native workerd uses the guard handler boundary and receives genuine transport response bytes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-acceptance-'));let mf:Miniflare|undefined;
  try {
    const b=budget(),seen:string[]=[];
    const transport:typeof fetch=async(raw,init)=>{
      seen.push(String(raw));assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic-native-only');
      if(init?.method==='POST')return Response.json({id:'synthetic-test-response',usage:{cost:0.000001},choices:[{message:{content:'synthetic guard boundary'}}]});
      return Response.json({data:String(raw).endsWith('/key')?{limit:10,usage:0,expires_at:b.expiresAt}:
        {id:b.model,pricing:{prompt:'0.0000004',completion:'0.0000016'}}});
    };
    const gate=createAcceptanceEgress(b,directory,transport);
    mf=new Miniflare(convertV4MiniflareOptions({log:new Log(LogLevel.NONE),workers:[{name:'native-client',modules:true,
      compatibilityDate:'2026-09-21',outboundService:request=>gate.forward(request as unknown as Request) as never,
      script:`export default {async fetch(){const headers={Authorization:'Bearer synthetic-native-only'};
        for(const path of ['key','model/openai/gpt-4.1-mini']) {const r=await fetch('https://openrouter.ai/api/v1/'+path,{headers});if(!r.ok)return r;}
        return fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers,body:${JSON.stringify(JSON.stringify(body))}});}};`}]}));
    const response=await mf.dispatchFetch('http://local.test/');assert.equal(response.status,200);
    const data=await response.json() as any;assert.equal(data.choices[0].message.content,'synthetic guard boundary');
    assert.equal(seen.length,3);assert.equal(gate.summary().reportedCostUsd,0.000001);assert.equal(gate.summary().posts,1);
  }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});
test('malformed provider key expiry cannot prime dispatch budget',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-acceptance-'));try {
    const b=budget();let posts=0;
    const transport:typeof fetch=async(raw,init)=>{
      if(init?.method==='POST')posts++;
      return Response.json({data:String(raw).endsWith('/key')?{limit:10,usage:0,expires_at:'not-a-date'}:
        {id:b.model,pricing:{prompt:'0.0000004',completion:'0.0000016'}}});
    };
    const gate=createAcceptanceEgress(b,directory,transport);
    assert.equal((await gate.forward(request('key'))).status,503);
    await gate.forward(request('model/'+b.model));
    assert.equal((await gate.forward(request('chat/completions',body))).status,503);assert.equal(posts,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
