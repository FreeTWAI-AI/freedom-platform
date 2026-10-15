import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatIsoLocal,formatPostTime} from '../../apps/portal-web/src/format.js';

const now=new Date(2026,9,15,15,30,0).getTime();
const at=(h:number,m:number,s=0)=>new Date(2026,9,15,h,m,s).toISOString();

test('a post from earlier today shows hours, minutes or just now',()=>{
  assert.equal(formatPostTime(at(15,29,30),now),'剛剛');
  assert.equal(formatPostTime(at(15,10),now),'20 分鐘前');
  assert.equal(formatPostTime(at(12,45),now),'2 小時前');
  assert.equal(formatPostTime(at(0,5),now),'15 小時前');
});

test('a post from another day keeps the full date and time',()=>{
  const yesterday=new Date(2026,9,14,23,50).toISOString();
  assert.equal(formatPostTime(yesterday,now),formatIsoLocal(yesterday));
});

test('a future timestamp, a blank value and an invalid value never read as relative',()=>{
  const future=at(16,0);
  assert.equal(formatPostTime(future,now),formatIsoLocal(future));
  assert.equal(formatPostTime(null,now),'—');
  assert.equal(formatPostTime('bad',now),'bad');
});
