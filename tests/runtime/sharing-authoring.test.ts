import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {authoringDraftState,setSharingDraftAccount,sharingMutationState,type SharingMutationState} from '../../apps/portal-web/src/modules/authoring-drafts.js';
import {performModuleMutation} from '../../apps/portal-web/src/modules/shared.js';
import {skillPublicationPath} from '../../apps/portal-web/src/modules/SkillPublication.js';

let session=0;
beforeEach(()=>setSharingDraftAccount('owner',++session));
const state=()=>sharingMutationState({userId:'owner',type:'skill'});
function transport(){
 const calls:{path:string;body:unknown;options:unknown}[]=[];
 const pending:{resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[];
 const client={post:(path:string,body:unknown,options:unknown)=>{
  calls.push({path,body:structuredClone(body),options:structuredClone(options)});
  return new Promise((resolve,reject)=>pending.push({resolve,reject}));
 }} as unknown as PortalClient;
 return {client,calls,pending};
}
test('same-session remount reads input consent and success; request state remains single-flight',async()=>{
 const first=authoringDraftState('owner','input',{text:'',consent:false,receipt:null as string|null});
 first.write({text:'private',consent:true,receipt:null});
 const remounted=authoringDraftState('owner','input',{text:'',consent:false,receipt:null as string|null});
 assert.deepEqual(remounted.read(),{text:'private',consent:true,receipt:null});
 const {client,calls,pending}=transport(),original=state();let notices=0;original.listeners.add(()=>notices++);
 const request=performModuleMutation<{id:string}>(client,original,'/manual',{text:'private'},3);
 assert.strictEqual(state(),original);assert.equal(state().snapshot.busy,true);
 assert.equal(await performModuleMutation(client,state(),'/manual',{text:'private'},3),undefined);assert.equal(calls.length,1);
 pending[0].resolve({id:'saved'});const receipt=await request;first.write(value=>({...value,receipt:receipt!.id}));
 assert.equal(remounted.read().receipt,'saved');assert.equal(original.snapshot.busy,false);assert(notices>=2);
});
test('a committed response loss survives remount and retries the exact key body and version',async()=>{
 const {client,calls,pending}=transport();const body={title:'saved once',consent_to_share:true};
 const request=performModuleMutation(client,state(),'/publish',body,7);pending[0].reject(new ApiError({message:'Lost acknowledgement',network:true}));
 assert.equal(await request,undefined);assert.equal(state().snapshot.lastFailureUnknown,true);assert.equal(state().keys.size,1);
 const retry=performModuleMutation(client,state(),'/publish',{...body},7);assert.deepEqual(calls[1],calls[0]);
 pending[1].resolve({id:'original-server-object'});assert.deepEqual(await retry,{id:'original-server-object'});assert.equal(state().keys.size,0);assert.equal(state().snapshot.lastFailureUnknown,false);
});
test('different path body or version cannot reuse an unknown request key',async()=>{
 const {client,calls,pending}=transport();
 for(const [path,body,version] of [['/publish',{title:'one'},7],['/publish',{title:'two'},7],['/publish',{title:'one'},8],['/other',{title:'one'},7]] as const){
  const request=performModuleMutation(client,state(),path,body,version);pending.at(-1)!.reject(new ApiError({message:'unknown',network:true}));await request;
 }
 assert.equal(new Set(calls.map(c=>(c.options as any).idempotencyKey)).size,4);
 const retry=performModuleMutation(client,state(),'/publish',{title:'one'},7);assert.deepEqual(calls.at(-1),calls[0]);pending.at(-1)!.resolve({saved:true});await retry;
});
test('same session refresh preserves all retained drafts and request identity',()=>{
 const draft=authoringDraftState('owner','input','');draft.write('retained');const original=state();original.keys.set('unknown','original-key');
 setSharingDraftAccount('owner',session);
 assert.equal(draft.live(),true);assert.equal(draft.read(),'retained');assert.strictEqual(state(),original);
});
for(const boundary of ['logout','expiry','switch','same-user replacement'] as const)test(`${boundary} clears all types and fences late request success`,async()=>{
 const draft=authoringDraftState('owner','input',''),consent=authoringDraftState('owner','consent',false);draft.write('private');consent.write(true);
 const old=state(),{client,pending}=transport();const request=performModuleMutation(client,old,'/manual',{title:'old owner'});
 if(boundary==='switch')setSharingDraftAccount('other',++session);
 else if(boundary==='same-user replacement')setSharingDraftAccount('owner',++session);
 else {setSharingDraftAccount(null,++session);setSharingDraftAccount('owner',++session);}
 assert.equal(draft.live(),false);draft.write('late write');pending[0].resolve({id:'old owner result'});assert.equal(await request,undefined);
 assert.equal(authoringDraftState('owner','input','').read(),'');assert.equal(authoringDraftState('owner','consent',false).read(),false);
 assert.notStrictEqual(state(),old);assert.equal(state().snapshot.busy,false);assert.equal(state().keys.size,0);
});
test('late failure is fenced too and cannot poison a new session error or busy state',async()=>{
 const old=state(),{client,pending}=transport();const request=performModuleMutation(client,old,'/manual',{});
 setSharingDraftAccount('owner',++session);const replacement=state();pending[0].reject(new ApiError({message:'old error',network:true}));await request;
 assert.deepEqual(replacement.snapshot,{busy:false,error:null,lastFailureUnknown:false});
});
test('existing unscoped MemberBlocking retry contract retains lastFailureUnknown and original CAS tuple',async()=>{
 const local:SharingMutationState={keys:new Map(),snapshot:{busy:false,error:null,lastFailureUnknown:false},listeners:new Set(),live:()=>true};
 const {client,calls,pending}=transport();let request=performModuleMutation(client,local,'/me/blocks/peer/block',{},5);
 pending[0].reject(new ApiError({message:'unknown',network:true}));await request;assert.equal(local.snapshot.lastFailureUnknown,true);
 request=performModuleMutation(client,local,'/me/blocks/peer/block',{},5);assert.deepEqual(calls[0],calls[1]);pending[1].resolve({updated:true});await request;assert.equal(local.snapshot.lastFailureUnknown,false);
 request=performModuleMutation(client,local,'/me/blocks/peer/unblock',{},6);pending[2].reject(new ApiError({message:'conflict',status:409}));await request;assert.equal(local.snapshot.lastFailureUnknown,false);assert.equal(local.keys.size,0);
});
test('canonical skill destination requires acknowledged published status and a valid same-site path',()=>{
 const path='/development/submissions/10000000-0000-4000-8000-000000000099';
 assert.equal(skillPublicationPath({status:'published',public_path:path}),path);
 for(const status of ['ready_for_review','awaiting_upload','draft'])assert.equal(skillPublicationPath({status,public_path:path}),null);
 for(const public_path of ['https://example.org',path+'?token=secret','//example.org', '/development/submissions/not-a-uuid'])assert.equal(skillPublicationPath({status:'published',public_path}),null);
});

test('draft lifetime follows PortalClient session semantics without retaining credentials',()=>{
 const client=new PortalClient();client.csrfToken='synthetic-first-session';
 setSharingDraftAccount('owner',client.sessionGeneration);const draft=authoringDraftState('owner','client-session','');draft.write('retained');
 const firstGeneration=client.sessionGeneration;client.csrfToken='synthetic-first-session';setSharingDraftAccount('owner',client.sessionGeneration);
 assert.equal(client.sessionGeneration,firstGeneration);assert.equal(draft.read(),'retained');
 client.csrfToken='synthetic-replacement-session';setSharingDraftAccount('owner',client.sessionGeneration);
 assert.notEqual(client.sessionGeneration,firstGeneration);assert.equal(draft.live(),false);assert.equal(authoringDraftState('owner','client-session','').read(),'');
});

test('setError identity and equal snapshots do not retrigger the Guilds dependent load effect',async()=>{
 // Narrow hook-host model of useRef/useCallback/external-store semantics. This
 // executes the production hook, but is not a substitute for the browser case.
 const {transformSync}=await import('esbuild');
 const {readFileSync}=await import('node:fs');
 const {runInNewContext}=await import('node:vm');
 const slots:any[]=[];let cursor=0,dirty=false,notifications=0;
 const same=(a:unknown[],b:unknown[])=>a.length===b.length&&a.every((item,index)=>Object.is(item,b[index]));
 const hooks={
  useRef:(initial:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initial});},
  useCallback:(callback:unknown,deps:unknown[])=>{const index=cursor++,previous=slots[index];if(!previous||!same(previous.deps,deps))slots[index]={callback,deps};return slots[index].callback;},
  useSyncExternalStore:(subscribe:(notify:()=>void)=>()=>void,read:()=>unknown)=>{
   const index=cursor++;let slot=slots[index];if(!slot)slot=slots[index]={value:read()};
   slot.unsubscribe?.();slot.unsubscribe=subscribe(()=>{notifications++;const next=read();if(!Object.is(next,slot.value)){slot.value=next;dirty=true;}});return slot.value=read();
  },
 };
 const source=readFileSync(new URL('../../apps/portal-web/src/modules/shared.tsx',import.meta.url),'utf8');
 const compiled=transformSync(source,{loader:'tsx',format:'cjs',target:'es2023'}).code;
 const module={exports:{} as any};
 runInNewContext(compiled,{module,exports:module.exports,require:(name:string)=>{
  if(name==='react')return hooks;if(name==='../api')return {ApiError};if(name==='./authoring-drafts')return {sharingMutationState};throw Error('Unexpected hook dependency '+name);
 },crypto});
 const client={} as PortalClient;let previousSetError:unknown,previousLoad:unknown,loads=0,latest:any;
 function render(){
  cursor=0;dirty=false;latest=module.exports.useModuleMutation(client);
  if(previousSetError)assert.strictEqual(latest.setError,previousSetError,'React state-setter identity must stay stable for the same mutation state');
  previousSetError=latest.setError;
  // Mirrors PositioningPanels Guilds: load depends on setError and the effect
  // depends on load. Replacing that callback repeatedly must not reload Guilds.
  const load=hooks.useCallback(()=>{loads++;latest.setError(null);},[client,false,latest.setError]) as ()=>void;
  if(load!==previousLoad){previousLoad=load;load();}
 }
 render();assert.equal(dirty,false,'clearing an already-null error must not publish a fresh snapshot');assert.equal(notifications,0);
 for(let count=0;count<4;count++)render();assert.equal(loads,1);
 latest.setError('visible failure');assert.equal(dirty,true);render();assert.equal(latest.error,'visible failure');assert.equal(loads,1);
 const before=notifications;latest.setError((value:string|null)=>value);assert.equal(notifications,before,'equal functional update must also be a no-op');
 latest.setError(null);render();assert.equal(latest.error,null);assert.equal(loads,1);
 for(const slot of slots)slot?.unsubscribe?.();
});
