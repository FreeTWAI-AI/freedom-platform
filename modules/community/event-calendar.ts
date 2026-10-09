import type {Pool} from 'pg';
import {transaction} from '../../packages/db/index.js';
import {lockMemberSession,assertCurrentSessionClock} from '../../packages/db/member-session.js';
import type {Actor} from '../identity-membership/service.js';
import {readEvent} from './events.js';
import {resolveGuestParticipation} from './event-waitlist.js';

export interface CalendarEvent {
  event_id:string; title:string; description:string; starts_at:Date|string; ends_at:Date|string;
  state?:string; aggregate_version:string|number; updated_at?:Date|string; created_at?:Date|string;
  location?:string|null; online_url?:string|null;
}
export function escapeCalendarText(value:string):string {
  return value.replace(/\\/g,'\\\\').replace(/\r\n?|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
}
/** Folding counts UTF-8 octets, not code units; continuation whitespace consumes one octet. */
export function foldCalendarLine(value:string):string {
  let result='',line='',bytes=0;
  for(const character of value){const point=character.codePointAt(0)!;const size=point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;
    if(bytes+size>75){result+=line+'\r\n';line=' ';bytes=1;}
    line+=character;bytes+=size;
  }
  return result+line;
}
function stamp(value:Date|string):string {return new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');}
export function generateEventCalendar(event:CalendarEvent):{calendar:string;filename:string} {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//FreeTWAI//Event Calendar//ZH-TW','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'BEGIN:VEVENT',`UID:${event.event_id}@freetwai.com`,`DTSTAMP:${stamp(event.updated_at??event.created_at??event.starts_at)}`,
    `SEQUENCE:${event.aggregate_version}`,`DTSTART:${stamp(event.starts_at)}`,`DTEND:${stamp(event.ends_at)}`,
    `STATUS:${event.state==='cancelled'||event.state==='rejected'?'CANCELLED':event.state==='pending'?'TENTATIVE':'CONFIRMED'}`,`SUMMARY:${escapeCalendarText(event.title)}`,
    `DESCRIPTION:${escapeCalendarText(event.description)}`];
  if(event.location)lines.push(`LOCATION:${escapeCalendarText(event.location)}`);
  // Participation links remain text, never public capability-bearing URLs.
  if(event.online_url)lines.push(`X-FREETWAI-ONLINE:${escapeCalendarText(event.online_url)}`);
  lines.push('END:VEVENT','END:VCALENDAR');
  return {calendar:lines.map(foldCalendarLine).join('\r\n')+'\r\n',filename:`event-${event.event_id}.ics`};
}
export async function readMemberEventCalendar(pool:Pool,actor:Actor,id:string){
  // The current domain projection removes referral joining data for non-going members.
  return transaction(pool,async q=>{
    await lockMemberSession(q,actor);
    const result=generateEventCalendar(await readEvent(q,actor,id,true));
    await assertCurrentSessionClock(q,actor);
    return result;
  });
}
export async function readGuestEventCalendar(pool:Pool,id:string,token:string){
  const participation=await resolveGuestParticipation(pool,id,token);
  return generateEventCalendar(participation.event);
}
