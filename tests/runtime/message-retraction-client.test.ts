import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {messageContents} from '../../modules/member-communications/content.js';
import {matchesDirectMessageAck,matchesChannelMessageAck} from '../../apps/portal-web/src/modules/message-image-client.js';

// Review #405: exercise the real redacted projection and strict client ACKs.
// These are intentionally failing acceptance regressions until the server/client
// agree on an explicit, privacy-safe acknowledgement of a redacted reference.
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
    const redacted={...row,...(await messageContents(q,[row],kind,sender))[0]};
    assert.equal(JSON.stringify(redacted).includes('private original'),false);
    assert.equal(matches(redacted),true,'a committed reply must not remain unknown forever solely because its referenced message was retracted');
  });
}
