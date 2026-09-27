import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { checkVersion, command, journal, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { text, isoTime } from '../../packages/shared/validation.js';
import type { Actor } from '../identity-membership/service.js';

const details = z.object({
  title:text(120), description:text(3000), starts_at:isoTime, ends_at:isoTime,
  mode:z.enum(['online','in_person','hybrid']), location:text(300),
  capacity:z.number().int().min(1).max(500).nullable(),
}).strict().refine(value=>Date.parse(value.ends_at)>Date.parse(value.starts_at),'結束時間須晚於開始時間。');

async function scopedEvent(q:Pick<PoolClient,'query'>,actor:Actor,id:string,lock=false) {
  const row=(await q.query(`SELECT * FROM community_events WHERE event_id=$1 AND community_id=$2${lock?' FOR UPDATE':''}`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這場活動。');return row;
}

async function eventView(q:Pick<PoolClient,'query'>,actor:Actor,row:any) {
  const count=(await q.query("SELECT count(*)::int AS total FROM community_event_rsvps WHERE event_id=$1 AND state='going'",[row.event_id])).rows[0].total as number;
  const mine=(await q.query('SELECT state FROM community_event_rsvps WHERE event_id=$1 AND user_id=$2',[row.event_id,actor.user_id])).rows[0]?.state??null;
  return {...row,organizer_name:(await q.query('SELECT display_name FROM users WHERE user_id=$1',[row.organizer_ref])).rows[0]?.display_name??'社群成員',attending_count:count,my_rsvp:mine};
}

export async function listEvents(pool:Pool,actor:Actor) {
  if(actor.onboarding_required&&!actor.onboarding_completed_at) {
    return (await pool.query(`SELECT event_id,title,starts_at,ends_at,mode,state
      FROM community_events WHERE community_id=$1 AND state='published' AND starts_at>now()
      ORDER BY starts_at,event_id LIMIT 30`,[actor.community_id])).rows;
  }
  const rows=(await pool.query(`SELECT e.*,u.display_name AS organizer_name,
    (SELECT count(*)::int FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.state='going') AS attending_count,
    (SELECT state FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.user_id=$2) AS my_rsvp
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref
    WHERE e.community_id=$1 AND e.starts_at>now()-interval '30 days'
    ORDER BY e.starts_at,e.event_id LIMIT 100`,[actor.community_id,actor.user_id])).rows;
  return rows;
}

export async function createEvent(pool:Pool,input:Command) {
  const body=details.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    requireCondition(Date.parse(body.starts_at)>Date.now(),422,'event_in_past','活動開始時間須在未來。');
    const id=randomUUID();
    const row=(await q.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,capacity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[id,input.actor.community_id,input.actor.user_id,body.title,body.description,body.starts_at,body.ends_at,body.mode,body.location,body.capacity])).rows[0];
    await journal(q,input.actor,'community_event',id,1,'publish',{title:body.title},'freedom.community.event.published.v1');
    return eventView(q,input.actor,row);
  });
}

export async function updateEvent(pool:Pool,input:Command,id:string) {
  const body=details.parse(input.body);
  return command(pool,input,async q=>{
    const row=await scopedEvent(q,input.actor,id);
    requireCondition(row.organizer_ref===input.actor.user_id,403,'organizer_required','只能編輯自己發佈的活動。');
  },async q=>{
    const row=await scopedEvent(q,input.actor,id,true);
    checkVersion(row.aggregate_version,input.expected);
    requireCondition(row.state==='published'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','這場活動已開始或取消。');
    requireCondition(Date.parse(body.starts_at)>Date.now(),422,'event_in_past','活動開始時間須在未來。');
    const going=(await q.query("SELECT count(*)::int AS total FROM community_event_rsvps WHERE event_id=$1 AND state='going'",[id])).rows[0].total as number;
    requireCondition(body.capacity===null||body.capacity>=going,409,'capacity_below_rsvps','名額不能少於已報名人數。');
    const updated=(await q.query(`UPDATE community_events SET title=$2,description=$3,starts_at=$4,ends_at=$5,mode=$6,location=$7,capacity=$8,
      aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 RETURNING *`,[id,body.title,body.description,body.starts_at,body.ends_at,body.mode,body.location,body.capacity])).rows[0];
    await journal(q,input.actor,'community_event',id,updated.aggregate_version,'update',{title:body.title});
    return eventView(q,input.actor,updated);
  });
}

export async function cancelEvent(pool:Pool,input:Command,id:string) {
  z.object({}).strict().parse(input.body);
  return command(pool,input,async q=>{
    const row=await scopedEvent(q,input.actor,id);
    requireCondition(row.organizer_ref===input.actor.user_id,403,'organizer_required','只能取消自己發佈的活動。');
  },async q=>{
    const row=await scopedEvent(q,input.actor,id,true);
    checkVersion(row.aggregate_version,input.expected);
    requireCondition(row.state==='published',409,'event_closed','這場活動已取消。');
    const updated=(await q.query("UPDATE community_events SET state='cancelled',aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 RETURNING *",[id])).rows[0];
    await journal(q,input.actor,'community_event',id,updated.aggregate_version,'cancel',{},'freedom.community.event.cancelled.v1');
    return eventView(q,input.actor,updated);
  });
}

export async function setRsvp(pool:Pool,input:Command,id:string) {
  const body=z.object({going:z.boolean()}).strict().parse(input.body);
  return command(pool,input,q=>scopedEvent(q,input.actor,id),async q=>{
    // Lock the event so simultaneous last-seat requests see the same RSVP count.
    const row=await scopedEvent(q,input.actor,id,true);
    if(body.going){
      requireCondition(row.state==='published'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','活動已開始或取消，無法報名。');
      const mine=(await q.query('SELECT state FROM community_event_rsvps WHERE event_id=$1 AND user_id=$2',[id,input.actor.user_id])).rows[0]?.state;
      if(mine!=='going'){
        const count=(await q.query("SELECT count(*)::int AS total FROM community_event_rsvps WHERE event_id=$1 AND state='going'",[id])).rows[0].total as number;
        requireCondition(row.capacity===null||count<row.capacity,409,'event_full','活動名額已滿。');
      }
    }
    const rsvp=(await q.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state) VALUES($1,$2,$3,$4)
      ON CONFLICT(event_id,user_id) DO UPDATE SET state=EXCLUDED.state,aggregate_version=community_event_rsvps.aggregate_version+1,updated_at=now()
      RETURNING rsvp_id,aggregate_version`,[randomUUID(),id,input.actor.user_id,body.going?'going':'cancelled'])).rows[0];
    await journal(q,input.actor,'community_event_rsvp',rsvp.rsvp_id,rsvp.aggregate_version,body.going?'rsvp':'withdraw_rsvp',{event_id:id});
    return eventView(q,input.actor,row);
  });
}
