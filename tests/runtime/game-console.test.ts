import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConsoleEvent,
  isGameConsoleWireMessage,
  logConsoleEvent,
  mergeConsoleEvents,
  sanitizeConsoleText,
  subscribeGameConsole,
} from '../../apps/portal-web/src/game-console-core.js';

test('Game Console redacts credential shapes and bounds every display field',()=>{
  const text=sanitizeConsoleText('Bearer abcdefghijklmnop token=super-secret github_pat_ABC_123 password=hunter2');
  assert.equal(text,'Bearer [redacted-token] token=[redacted] [redacted-token] password=[redacted]');
  const event=createConsoleEvent({channel:'ai',kind:'prompt',source:'x'.repeat(120),message:'m'.repeat(900),detail:'d'.repeat(9000),createdAt:'2026-09-26T12:00:00Z',id:'fixture'});
  assert.equal(event.message.length,800);assert.equal(event.detail?.length,8000);assert.equal(event.source.length,80);
});

test('Game Console history is ordered, deduplicated and bounded',()=>{
  const make=(id:string,second:number)=>createConsoleEvent({id,createdAt:`2026-09-26T12:00:${String(second).padStart(2,'0')}Z`,message:id});
  const merged=mergeConsoleEvents([make('b',2),make('a',1)],[make('b',2),make('c',3)],2);
  assert.deepEqual(merged.map(event=>event.id),['b','c']);
});

test('Game Console event bus can be used outside React and stops after unsubscribe',()=>{
  const seen:string[]=[];
  const unsubscribe=subscribeGameConsole(event=>seen.push(event.message));
  logConsoleEvent({message:'first'});unsubscribe();logConsoleEvent({message:'second'});
  assert.deepEqual(seen,['first']);
});

test('BroadcastChannel envelopes reject unknown or oversized cross-window payloads',()=>{
  const event=createConsoleEvent({id:'valid',createdAt:'2026-09-26T12:00:00Z',channel:'world',kind:'broadcast',message:'published'});
  assert.equal(isGameConsoleWireMessage({type:'event',sender:'one',event}),true);
  assert.equal(isGameConsoleWireMessage({type:'session-end',sender:'one'}),true);
  assert.equal(isGameConsoleWireMessage({type:'event',sender:'one',event:{...event,channel:'private'}}),false);
  assert.equal(isGameConsoleWireMessage({type:'snapshot',sender:'one',target:'two',events:Array.from({length:201},()=>event)}),false);
  assert.equal(isGameConsoleWireMessage({type:'execute',sender:'one',command:'location.reload()'}),false);
});
