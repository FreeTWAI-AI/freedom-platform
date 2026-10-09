import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError} from '../../apps/portal-web/src/api.js';
import {isFirstImageDecoderRejection,isMessageImage,matchesDirectMessageAck} from '../../apps/portal-web/src/modules/message-image-client.js';
const sender='10000000-0000-4000-8000-000000000001',recipient='10000000-0000-4000-8000-000000000002',id='10000000-0000-4000-8000-000000000003';
const image={content_type:'image/webp',byte_size:128};
const message={message_id:id,sender_ref:sender,recipient_ref:recipient,body:'[圖片]',created_at:'2026-10-08T12:00:00.000Z',read_at:null,image};
const expected={sender,recipient,payload:{image_id:id}};
test('direct ACK rejects missing or wrong canonical sender, recipient, body and identity',()=>{
  assert.equal(matchesDirectMessageAck(message,expected),true);
  for(const bad of [{},null,[],{...message,message_id:'invalid'},{...message,sender_ref:recipient},{...message,recipient_ref:sender},{...message,body:'other'},{...message,created_at:'bad'},{...message,read_at:42}])assert.equal(matchesDirectMessageAck(bad,expected),false);
});
test('image ACK requires exact presence and bounded integer webp size without a fictional image_id',()=>{
  for(const byte_size of [0,-1,1.5,NaN,Infinity,1024*1024+1,'128',undefined]){
    assert.equal(isMessageImage({...image,byte_size}),false);
    assert.equal(matchesDirectMessageAck({...message,image:{...image,byte_size}},expected),false);
  }
  for(const byte_size of [1,1024*1024])assert.equal(isMessageImage({...image,byte_size}),true);
  assert.equal(matchesDirectMessageAck({...message,image:undefined},expected),false);
  assert.equal(matchesDirectMessageAck({...message,image:{...image,content_type:'image/png'}},expected),false);
  assert.equal(matchesDirectMessageAck({...message,body:'text'},{sender,recipient,payload:{body:'text'}}),false);
});
test('caption and text ACK follow server CRLF trim normalization and exact stored body',()=>{
  assert.equal(matchesDirectMessageAck({...message,body:'line\nnext'},{...expected,payload:{image_id:id,body:'  line\r\nnext\r '}}),true);
  assert.equal(matchesDirectMessageAck({...message,body:'text',image:undefined},{sender,recipient,payload:{body:' text '}}),true);
});
test('reply and sticker ACKs bind the requested canonical references, not caller quote text',()=>{
  const sticker={id:'workshop-v1-hello',label:'你好'};
  const value={...message,image:undefined,body:'[貼圖] 你好',sticker,reply_to:{message_id:id,sender_ref:recipient,sender_name:'Current name',body:'server quote'}};
  const terms={sender,recipient,payload:{sticker_id:sticker.id,reply_to_message_id:id}};
  assert.equal(matchesDirectMessageAck(value,terms),true);
  for(const bad of [{...value,sticker:{...sticker,label:'wrong'}},{...value,reply_to:undefined},{...value,reply_to:{...value.reply_to,message_id:sender}},{...value,reply_to:{...value.reply_to,sender_ref:'invalid'}}])assert.equal(matchesDirectMessageAck(bad,terms),false);
  assert.equal(matchesDirectMessageAck({...message,reply_to:value.reply_to},expected),false);
  assert.equal(matchesDirectMessageAck({...message,sticker},expected),false);
});


test('only the first definite upload decoder rejection releases an image attempt',()=>{
  const rejection={message:'Invalid image',status:422,code:'invalid_message_image'};
  const error=new ApiError(rejection);
  assert.equal(isFirstImageDecoderRejection(error,'upload',false),true);
  assert.equal(isFirstImageDecoderRejection(error,'upload',true),false);
  for(const stage of ['message',undefined] as const){
    assert.equal(isFirstImageDecoderRejection(error,stage,false),false);
    assert.equal(isFirstImageDecoderRejection(error,stage,true),false);
  }
  for(const cause of [new Error('decoder failed'),rejection,null,
    new ApiError({...rejection,network:true}),new ApiError({...rejection,timedOut:true}),new ApiError({...rejection,accessExpired:true}),
    new ApiError({...rejection,status:400}),new ApiError({...rejection,status:503}),
    new ApiError({...rejection,code:'validation_failed'}),new ApiError({...rejection,code:undefined})]){
    assert.equal(isFirstImageDecoderRejection(cause,'upload',false),false);
  }
});
