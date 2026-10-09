import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {transformSync} from 'esbuild';
import {createChatLeaveGuards} from '../../apps/portal-web/src/modules/chat-leave-guards.js';
import {ApiError} from '../../apps/portal-web/src/api.js';
import {findChatSticker} from '../../modules/member-communications/stickers.js';
import {matchesChannelMessageAck,matchesDirectMessageAck} from '../../apps/portal-web/src/modules/message-image-client.js';

// Execute the actual source closures with controlled promises, without a browser,
// database or a copied send implementation. React rendering is a separate E2E tier.
function sourceFunction(file:string,name:string){
  const source=transformSync(readFileSync(new URL(`../../apps/portal-web/src/modules/${file}`,import.meta.url),'utf8'),{loader:'tsx',target:'es2023',format:'esm',jsx:'transform'}).code;
  const start=new RegExp(`^( *)(?:async )?function ${name}\\(`,'m').exec(source);assert.ok(start,`${file}:${name}`);
  const tail=source.slice(start.index),end=new RegExp(`^${start[1]}}`, 'm').exec(tail);assert.ok(end,`${file}:${name} end`);
  return tail.slice(0,end.index+end[0].length);

}
const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const sender='10000000-0000-4000-8000-000000000001',peer='10000000-0000-4000-8000-000000000002';
const first='workshop-v1-hello',second='workshop-v1-thanks';
function harness(mode:'direct'|'channel'){
  const target=mode==='direct'?peer:'guild_ai_vibe';
  const calls:{path:string;payload:any;key:string;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[];
  const drafts:Record<string,string>={[target]:'保留的文字'},reply={message_id:randomUUID()},extras={reply};
  const image={user:sender,key:randomUUID(),url:'blob:fixture',file:{name:'draft.webp'}};
  const state:any={held:{current:{}},sendLocks:{current:new Set()},alive:{current:true},current:{current:target},currentPeer:{current:target},gone:{current:new Set()},epoch:{current:1},me:sender,kind:'guild',text:{unit:'公會'},MAX_BODY:2000,
    snapshot:{current:{status:'ready',threadStatus:'ready',history:{channel:{kind:'guild',channel_key:target,name:'原頻道'}},thread:{participant:{user_id:target},can_send:true}}},
    drafts,richDrafts:{get:()=>extras,clear:()=>{state.cleared++;}},cleared:0,
    selections:{current:new Map([[target,image]])},selectionRef:{current:image},messageImagesEnabled:true,
    receiptRefresh:{current:new Map()},conversations:[],thread:null,stick:{current:false},logs:[],uploads:0,
    setPendingState:()=>{},setDrafts:(update:any)=>{state.drafts=update(state.drafts);},setSendErrors:()=>{},setSelection:()=>{},setThread:()=>{},setHistory:()=>{},setConversations:()=>{},setChannels:()=>{},rereadAfterWrite:()=>{},
    path:(key:string,rest:string)=>`/me/channels/guild/${key}/${rest}`,crypto:{randomUUID},ApiError,findChatSticker,matchesDirectMessageAck,matchesChannelMessageAck,
    chatPayload:runInNewContext(`${sourceFunction('ChatContent.tsx','chatPayload')};chatPayload`),
    consoleChannel:(value:string)=>value,logConsoleEvent:(value:unknown)=>state.logs.push(value),
    fail:(cause:any)=>cause.message,unconfirmed:(cause:unknown)=>!(cause instanceof ApiError)||cause.network||cause.status===0||cause.status>=500,
    revoked:(cause:unknown)=>cause instanceof ApiError&&(cause.status===403||cause.status===404),
    uploadMessageImage:async()=>{state.uploads++;return {image_id:randomUUID()};},URL:{revokeObjectURL:()=>{throw Error('Unsent image revoked');}},
    client:{sessionGeneration:1,post:(path:string,payload:unknown,options:{idempotencyKey:string})=>new Promise((resolve,reject)=>calls.push({path,payload:clone(payload),key:options.idempotencyKey,resolve,reject}))},
  };
  state.setPending=runInNewContext(`${sourceFunction(mode==='direct'?'MemberMessages.tsx':'MemberChannels.tsx','setPending')};setPending`,state);
  state.revoke=runInNewContext(`${sourceFunction('MemberChannels.tsx','revoke')};revoke`,{...state,current:{current:'another-room'},setSendErrors:()=>{},announceInboxChange:()=>{},loadList:()=>{},setChannels:()=>{}});
  const send=runInNewContext(`${sourceFunction(mode==='direct'?'MemberMessages.tsx':'MemberChannels.tsx','send')};send`,state) as (target:string,sticker?:string)=>Promise<void>;
  const ack=(index=0)=>{const payload=calls[index].payload,sticker=findChatSticker(payload.sticker_id);return {message_id:randomUUID(),sender_ref:sender,recipient_ref:peer,created_at:'2026-10-08T12:00:00Z',read_at:null,kind:'guild',channel_key:target,sender_name:'會員',sequence:'1',body:sticker?`[貼圖] ${sticker.label}`:payload.body,...(sticker?{sticker:{id:sticker.id,label:sticker.label}}:{})};};
  return {state,calls,send,target,ack,image};
}

for(const mode of ['direct','channel'] as const){
  test(`${mode}: immediate sticker excludes all other drafts and synchronously blocks another send`,async()=>{
    const h=harness(mode),sent=h.send(h.target,first);
    assert.equal(h.calls.length,1);assert.equal(h.state.held.current[h.target].status,'sending');
    assert.deepEqual(h.calls[0].payload,{sticker_id:first});
    await h.send(h.target,second);await h.send(h.target);assert.equal(h.calls.length,1);
    h.calls[0].resolve(h.ack());await sent;
    assert.equal(h.state.held.current[h.target],undefined);assert.equal(h.state.drafts[h.target],'保留的文字');assert.equal(h.state.cleared,0);
    assert.equal(h.state.selections.current.get(h.target),h.image);assert.equal(h.state.uploads,0);
  });
  test(`${mode}: malformed ACK and later definite refusal keep the original tuple until canonical ACK`,async()=>{
    const h=harness(mode),sent=h.send(h.target,first);h.calls[0].resolve({});await sent;
    assert.equal(h.state.held.current[h.target].status,'unknown');
    await h.send(h.target,second);assert.equal(h.calls.length,1);
    h.state.drafts[h.target]='後來的草稿';
    const retry=h.send(h.target);assert.equal(h.calls[1].key,h.calls[0].key);assert.deepEqual(h.calls[1].payload,h.calls[0].payload);
    h.calls[1].reject(new ApiError({message:'Definitely refused retry',status:400}));await retry;
    assert.equal(h.state.held.current[h.target].status,'unknown');
    const confirmed=h.send(h.target);assert.equal(h.calls[2].key,h.calls[0].key);assert.deepEqual(h.calls[2].payload,h.calls[0].payload);
    h.calls[2].resolve(h.ack(2));await confirmed;
    assert.equal(h.state.held.current[h.target],undefined);assert.equal(h.state.drafts[h.target],'後來的草稿');assert.equal(h.state.cleared,0);assert.equal(h.state.uploads,0);
  });
  test(`${mode}: first definite refusal releases the held sticker for a new choice`,async()=>{
    const h=harness(mode),sent=h.send(h.target,first);h.calls[0].reject(new ApiError({message:'rate limited',status:429}));await sent;
    assert.equal(h.state.held.current[h.target],undefined);
    const next=h.send(h.target,second);assert.notEqual(h.calls[1].key,h.calls[0].key);assert.deepEqual(h.calls[1].payload,{sticker_id:second});h.calls[1].resolve(h.ack(1));await next;
  });
  test(`${mode}: switching selection keeps the original recipient and ignores a late ACK from another session`,async()=>{
    const h=harness(mode),sent=h.send(h.target,first),original=h.calls[0].path;
    h.state.current.current='other';h.state.currentPeer.current='other';
    await h.send(h.target,second);assert.equal(h.calls.length,1);assert.ok(original.includes(h.target));
    h.state.client.sessionGeneration++;h.calls[0].resolve(h.ack());await sent;
    assert.equal(h.state.logs.length,0);assert.equal(h.state.held.current[h.target].status,'sending');assert.equal(h.state.cleared,0);
  });
  test(`${mode}: stale or unavailable current authority cannot send`,async()=>{
    const h=harness(mode);h.state.snapshot.current.thread.can_send=false;h.state.gone.current.add(h.target);
    await h.send(h.target,first);assert.equal(h.calls.length,0);
  });
}

test('channel revocation during an uncertain send preserves its original key and body',async()=>{
  const h=harness('channel'),sent=h.send(h.target,first);h.state.revoke(h.target,1,false);
  assert.equal(h.state.held.current[h.target].key,h.calls[0].key);
  h.calls[0].reject(new ApiError({message:'lost response',network:true}));await sent;
  assert.equal(h.state.held.current[h.target].status,'unknown');assert.equal(h.state.cleared,0);
  await h.send(h.target,second);assert.equal(h.calls.length,1);
});

test('channel ACK binds sender, room, kind, sequence, sticker and absence of unsent quote/image',()=>{
  const h=harness('channel'),expected={sender,kind:'guild' as const,channelKey:h.target,payload:{sticker_id:first}};
  const value={message_id:randomUUID(),sender_ref:sender,sender_name:'會員',kind:'guild',channel_key:h.target,sequence:'9223372036854775807',created_at:'2026-10-08T12:00:00Z',body:'[貼圖] 你好',sticker:{id:first,label:'你好'}};
  assert.equal(matchesChannelMessageAck(value,expected),true);
  for(const patch of [{sender_ref:peer},{channel_key:'other'},{kind:'world'},{sequence:'0'},{sequence:'-1'},{sequence:'1.5'},{sequence:'9223372036854775808'},{sequence:1},{created_at:'invalid'},{message_id:'invalid'},{body:'other'},{sticker:{id:second,label:'謝謝'}},{sticker:{id:first,label:'wrong'}},{reply_to:{message_id:randomUUID()}},{image:{content_type:'image/webp',byte_size:1}}])assert.equal(matchesChannelMessageAck({...value,...patch},expected),false,JSON.stringify(patch));
});

test('picker invokes the send callback directly and preserves quote state',()=>{
  let index=0;const states:any[]=[true,'','workshop-v1'],sent:string[]=[],changes:unknown[]=[];
  const jsx=(type:any,props:any,...children:any[])=>({type,props:props??{},children});
  const render=runInNewContext(`${sourceFunction('ChatContent.tsx','ChatExtras')};ChatExtras`,{React:{createElement:jsx},useState:(initial:unknown)=>{const i=index++;return [states[i]??initial,(value:unknown)=>{states[i]=value;}];},useId:()=>':picker:',useRef:()=>({current:null}),useEffect:()=>{},CHAT_STICKERS:[{id:first,label:'你好',keywords:'你好',pack:'workshop-v1'}],ChatSticker:()=>{},ChatQuote:()=>{},findChatSticker});
  const tree=render({draft:{reply:{message_id:randomUUID()}},onChange:(value:unknown)=>changes.push(value),onSendSticker:(id:string)=>sent.push(id),disabled:false,target:peer});
  const nodes:any[]=[];function walk(value:any){if(!value)return;if(Array.isArray(value)){value.forEach(walk);return;}if(typeof value==='object'){nodes.push(value);walk(value.children);}}walk(tree);
  const button=nodes.find(value=>value.props?.['aria-label']==='傳送貼圖：你好');assert.ok(button);button.props.onClick();
  assert.deepEqual(sent,[first]);assert.deepEqual(changes,[]);assert.equal(states[0],false);
});

test('channel leave guards observe the held command before the first await and ignore ordinary drafts',async()=>{
  const h=harness('channel');let alerts=0;
  const context={...h.state,window:{alert:()=>alerts++}};
  const canLeave=runInNewContext(`${sourceFunction('MemberChannels.tsx','canLeave')};canLeave`,context);
  const beforeUnload=runInNewContext(`${sourceFunction('MemberChannels.tsx','onBeforeUnload')};onBeforeUnload`,context);
  let prevented=0;const event={returnValue:undefined,preventDefault:()=>prevented++};
  assert.equal(canLeave(),true);beforeUnload(event);assert.equal(prevented,0);assert.equal(alerts,0);
  const sending=h.send(h.target,first);
  assert.equal(canLeave(),false);beforeUnload(event);assert.equal(prevented,1);assert.equal(event.returnValue,'');
  h.calls[0].reject(new ApiError({message:'lost response',network:true}));await sending;
  h.state.current.current='another-room';assert.equal(canLeave(),false);
  h.state.current.current=h.target;const retry=h.send(h.target);h.calls[1].resolve(h.ack(1));await retry;
  assert.equal(canLeave(),true);beforeUnload(event);assert.equal(prevented,1);assert.equal(h.state.drafts[h.target],'保留的文字');
});

test('AND composition retains every sibling guard when a child unregisters',()=>{
  const guards=createChatLeaveGuards();let directPending=true,guildPending=true;
  guards.direct(()=>!directPending);guards.guild(()=>!guildPending);guards.squad(()=>true);guards.world(()=>true);
  assert.equal(guards.canLeave(),false);guards.world(null);assert.equal(guards.canLeave(),false);
  directPending=false;assert.equal(guards.canLeave(),false);guards.direct(null);assert.equal(guards.canLeave(),false);
  guildPending=false;assert.equal(guards.canLeave(),true);
  guards.guild(()=>false);guards.squad(null);assert.equal(guards.canLeave(),false);
  guards.guild(null);assert.equal(guards.canLeave(),true);
});

for(const file of ['MemberMessages.tsx','../GameConsoleComposer.tsx'])test(`${file}: real parent wires all four distinct child slots into its layout-registered aggregate`,()=>{
  const parent={current:null as (()=>boolean)|null};const effects:(()=>void)[]=[],guards=createChatLeaveGuards();
  const useChatLeaveGuards=runInNewContext(`${sourceFunction('chat-leave-guards.ts','useChatLeaveGuards')};useChatLeaveGuards`,{
    useState:()=>[guards],createChatLeaveGuards,useLayoutEffect:(effect:()=>()=>void)=>effects.push(effect()),
  });
  const jsx=(type:any,props:any,...children:any[])=>({type,props:props??{},children});
  const MemberChannels=Symbol('MemberChannels'),DirectMessages=Symbol('DirectMessages');
  const consoleParent=file.startsWith('../'),name=consoleParent?'GameConsoleComposer':'MemberMessages';let stateIndex=0;
  const render=runInNewContext(`${sourceFunction(file,name)};${name}`,{
    React:{createElement:jsx},useChatLeaveGuards,useState:(initial:any)=>[consoleParent&&stateIndex++===0?['guild','squad','direct','world_chat']:typeof initial==='function'?initial():initial,()=>{}],
    useRef:(value:any)=>({current:value}),useEffect:()=>{},useCallback:(callback:any)=>callback,usePhoneChatBounds:()=>{},useReadAllInbox:()=>({}),VIEWS:[],WorkshopIcon:()=>{},Notifications:()=>{},PageLoadBoundary:()=>{},MemberChannels,DirectMessages,isChat:()=>true,
  });
  const tree=render({client:{},session:{user:{user_id:sender}},enabled:true,channel:'guild',active:true,onUnread:()=>{},onNavigate:()=>{},registerLeave:(guard:any)=>{parent.current=guard;},registerSessionEnd:(guard:any)=>{parent.current=guard;}});
  const nodes:any[]=[];function walk(value:any){if(!value)return;if(Array.isArray(value)){value.forEach(walk);return;}if(typeof value==='object'){nodes.push(value);walk(value.children);}}walk(tree);
  const children=nodes.filter(node=>node.type===MemberChannels||node.type===DirectMessages);assert.equal(children.length,4);
  const registrations=children.map(node=>node.props.registerLeave);assert.equal(new Set(registrations).size,4);
  assert.equal(parent.current,guards.canLeave);
  const pending=children.find(node=>node.props.kind==='guild');pending.props.registerLeave(()=>false);
  for(const child of children.filter(node=>node!==pending)){child.props.registerLeave(()=>true);child.props.registerLeave(null);assert.equal(parent.current!(),false);}
  pending.props.registerLeave(null);assert.equal(parent.current!(),true);
  effects.forEach(cleanup=>cleanup());assert.equal(parent.current,null);
});
