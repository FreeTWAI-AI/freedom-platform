import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateEventCalendar,escapeCalendarText,foldCalendarLine} from '../../modules/community/event-calendar.js';

const event={event_id:'673a22af-2787-433c-995b-cf9521218d0d',title:'週末,閱讀;會\\新章\n下一行',description:'繁體中文🙂'.repeat(70),starts_at:'2027-03-14T01:30:00-05:00',ends_at:'2027-03-14T04:30:00-04:00',updated_at:'2026-10-08T10:20:30.123Z',aggregate_version:'7',state:'published'};
test('calendar unfolds UTF-8 at 75 octets and preserves UTC instants, UID and aggregate sequence',()=>{
  const {calendar}=generateEventCalendar(event);
  assert.ok(calendar.endsWith('\r\n'));assert.equal(calendar.replace(/\r\n/g,'').includes('\n'),false);
  for(const line of calendar.split('\r\n'))assert.ok(Buffer.byteLength(line,'utf8')<=75);
  const unfolded=calendar.replace(/\r\n[ \t]/g,'');
  const properties=unfolded.split('\r\n').map(line=>{const colon=line.indexOf(':');return [line.slice(0,colon),line.slice(colon+1)];});
  const field=(key:string)=>properties.find(([name])=>name===key)?.[1];
  assert.equal(field('UID'),event.event_id+'@freetwai.com');assert.equal(field('SEQUENCE'),'7');assert.equal(field('DTSTAMP'),'20261008T102030Z');
  assert.equal(field('DTSTART'),'20270314T063000Z');assert.equal(field('DTEND'),'20270314T083000Z');
  assert.equal(field('SUMMARY'),escapeCalendarText(event.title));assert.equal(field('DESCRIPTION'),event.description);
  assert.equal(unfolded.includes('\ufffd'),false);
  const cancelled=generateEventCalendar({...event,state:'cancelled',aggregate_version:8}).calendar.replace(/\r\n[ \t]/g,'');
  assert.ok(cancelled.includes('STATUS:CANCELLED\r\n'));assert.ok(cancelled.includes(`UID:${event.event_id}@freetwai.com\r\n`));assert.ok(cancelled.includes('SEQUENCE:8\r\n'));
});
test('calendar text cannot inject content lines and folding includes continuation whitespace',()=>{
  assert.equal(escapeCalendarText('a\\b,c;d\r\nEND:VEVENT'),'a\\\\b\\,c\\;d\\nEND:VEVENT');
  const line='DESCRIPTION:'+ '🙂'.repeat(40),folded=foldCalendarLine(line);
  assert.equal(folded.replace(/\r\n /g,''),line);
  for(const part of folded.split('\r\n'))assert.ok(Buffer.byteLength(part)<=75);
});
