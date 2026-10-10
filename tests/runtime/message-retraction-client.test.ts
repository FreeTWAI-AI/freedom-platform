import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {messageContents} from '../../modules/member-communications/content.js';
import {matchesDirectMessageAck,matchesChannelMessageAck} from '../../apps/portal-web/src/modules/message-image-client.js';

// Review #405: exercise the real redacted projection and strict client ACKs.
// The server/client retain only the original target identity after redaction.
const sender='10000000-0000-4000-8000-000000000001',recipient='10000000-0000-4000-8000-000000000002';
const id='10000000-0000-4000-8000-000000000003',quoteId='10000000-0000-4000-8000-000000000004';
const now='2026-10-10T04:00:00.000Z';
for(const kind of ['direct','channel'] as const){
  test(`${kind}: a successfully committed reply remains acknowledgeable after its quote is retracted`,async()=>{
    let quoteVisible=true;
    const q={query:async(sql:string)=>({rows:sql.includes('left(m.body,160)')&&quoteVisible?[{message_id:quoteId,sender_ref:recipient,sender_name:'Synthetic',body:'private original',sticker_id:null}]:[]})} as unknown as Pool;
    const row={message_id:id,sender_ref:sender,recipient_ref:recipient,sender_name:'Synthetic',kind:'world' as const,channel_key:'world',sequence:'1',body:'reply',created_at:now,read_at:null,retracted_at:null,reply_to_message_id:quoteId};
    const payload={body:'reply',reply_to_message_id:quoteId};
    const matches=(value:unknown)=>kind==='direct'?matchesDirectMessageAck(value,{sender,recipient,payload}):matchesChannelMessageAck(value,{sender,kind:'world',channelKey:'world',payload});
    assert.equal(matches({...row,...(await messageContents(q,[row],kind,sender))[0]}),true);
    quoteVisible=false;
    const content=(await messageContents(q,[row],kind,sender))[0];
    assert.deepEqual(content,{reply_to_message_id:quoteId});
    const {reply_to_message_id:_databaseOnly,...projected}=row;
    const redacted={...projected,...content};
    assert.equal(JSON.stringify(redacted).includes('private original'),false);
    assert.equal(matches(redacted),true,'a committed reply must not remain unknown forever solely because its referenced message was retracted');
    for(const wrong of [undefined,'invalid',sender])assert.equal(matches({...redacted,reply_to_message_id:wrong}),false,'missing or unrelated targets cannot acknowledge this operation');
  });
}


test('retraction refresh replaces loaded older messages and quotes without retaining unavailable rows',async()=>{
  const {refreshLoadedMessages}=await import('../../apps/portal-web/src/modules/message-refresh.js');
  type Message={message_id:string;body:string;reply_to?:{body:string};retracted_at?:string;reply_to_message_id?:string};
  const old:Message[]=[{message_id:'old',body:'sensitive'},{message_id:'quote',body:'reply',reply_to:{body:'sensitive'}},{message_id:'gone',body:'no longer visible'}];
  const seen:number[]=[];
  const result=await refreshLoadedMessages<Message>({items:[{message_id:'new',body:'latest'}],next_offset:20},old,async offset=>{
    seen.push(offset);return {items:[{message_id:'old',body:'',retracted_at:now},{message_id:'quote',body:'reply',reply_to_message_id:quoteId}],next_offset:null};
  },()=>true);
  assert.deepEqual(seen,[20]);assert.deepEqual(result?.map(x=>x.message_id),['new','old','quote']);
  assert.ok(!JSON.stringify(result).includes('sensitive'));assert.ok(!JSON.stringify(result).includes('no longer visible'));
});
test('retraction refresh discards a superseded conversation result and rejects a looping history cursor',async()=>{
  const {refreshLoadedMessages}=await import('../../apps/portal-web/src/modules/message-refresh.js');
  let current=true;
  assert.equal(await refreshLoadedMessages({items:[],next_offset:20},[{message_id:'old'}],async()=>{current=false;return {items:[{message_id:'old'}],next_offset:null};},()=>current),null);
  await assert.rejects(()=>refreshLoadedMessages({items:[],next_offset:20},[{message_id:'old'}],async()=>({items:[],next_offset:20}),()=>true),/重讀對話/);
});
