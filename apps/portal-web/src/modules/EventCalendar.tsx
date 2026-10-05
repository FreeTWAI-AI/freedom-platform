import {useState} from 'react';
import type {CommunityEvent} from './EventsPanel';
import './EventCalendar.css';

const dayKey=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const weekdays=['日','一','二','三','四','五','六'];

const monthIndex=(date:Date)=>date.getFullYear()*12+date.getMonth();

export function EventCalendar({events,onOpen}:{events:CommunityEvent[];onOpen:(id:string)=>void}){
  const [offset,setOffset]=useState(0);
  const today=new Date(),first=new Date(today.getFullYear(),today.getMonth()+offset,1);
  const count=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
  const currentMonth=monthIndex(new Date(today.getFullYear(),today.getMonth(),1));
  const oldestMonth=events.reduce((oldest,event)=>{const start=new Date(event.starts_at);return Number.isNaN(start.getTime())?oldest:Math.min(oldest,monthIndex(start));},currentMonth);
  const minOffset=Math.min(-12,oldestMonth-currentMonth);
  const grouped=new Map<string,CommunityEvent[]>();
  for(const event of events){const key=dayKey(new Date(event.starts_at));grouped.set(key,[...(grouped.get(key)??[]),event]);}
  return <section className="event-calendar" data-guide-anchor="events:calendar" aria-label="活動行事曆">
    <div className="event-calendar-heading"><h2>活動行事曆</h2><div className="event-calendar-nav"><button className="btn btn-ghost" type="button" disabled={offset<=minOffset} onClick={()=>setOffset(value=>value-1)} aria-label="上個月">‹</button><strong aria-live="polite">{first.toLocaleDateString('zh-TW',{year:'numeric',month:'long'})}</strong><button className="btn btn-ghost" type="button" onClick={()=>setOffset(value=>value+1)} aria-label="下個月">›</button></div></div>
    <div className="event-calendar-grid" role="grid" aria-label={first.toLocaleDateString('zh-TW',{year:'numeric',month:'long'})}>
      {weekdays.map(day=><span className="event-calendar-weekday" role="columnheader" key={day}>{day}</span>)}
      {Array.from({length:first.getDay()},(_,index)=><span role="gridcell" className="event-calendar-blank" key={`blank-${index}`}/>)}
      {Array.from({length:count},(_,index)=>{const date=new Date(first.getFullYear(),first.getMonth(),index+1),key=dayKey(date),dayEvents=grouped.get(key)??[];
        return <div role="gridcell" className="event-calendar-day" data-today={key===dayKey(today)} key={key}><time dateTime={key}>{index+1}</time><div>{dayEvents.map(event=>{const ended=Date.parse(event.ends_at)<=Date.now(),label=ended?`${event.title}，已結束`:event.title;
          return <button type="button" key={event.event_id} data-ended={ended?'true':'false'} aria-label={label} onClick={()=>onOpen(event.event_id)} title={`${label} · ${new Date(event.starts_at).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})}`}>{ended?`${event.title}（已結束）`:event.title}</button>;})}</div></div>;
      })}
    </div>
  </section>;
}
