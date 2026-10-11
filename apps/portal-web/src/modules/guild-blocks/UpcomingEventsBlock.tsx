import {useEffect, useState} from 'react';
import {z} from 'zod';
import {formatIsoLocal} from '../../format';
import type {GuildBlockContext as Context} from '../../../../../packages/shared/guild-block-ui';
type GuildBlockContext = Context<unknown>;

// Project only fields displayed here; the original event reader remains the ACL authority.
const EventSummarySchema = z.object({
  event_id: z.uuid(), title: z.string(), starts_at: z.iso.datetime({offset: true}),
  state: z.enum(['pending', 'published', 'rejected', 'cancelled']),
});
const EventPageSchema = z.object({items: z.array(EventSummarySchema)});
export type UpcomingEvent = z.infer<typeof EventSummarySchema>;
export type EventsState = {status: 'loading'} | {status: 'error'} | {status: 'ready'; items: UpcomingEvent[]};
export function upcomingEvents(raw: unknown, now = Date.now()): UpcomingEvent[] {
  return EventPageSchema.parse(raw).items.filter(item => item.state === 'published' && Date.parse(item.starts_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.event_id.localeCompare(b.event_id)).slice(0, 3);
}
/** A UI read lifetime, not an authorization substitute. */
export async function loadUpcomingEvents(client: GuildBlockContext['client'], signal: AbortSignal, update: (state: EventsState) => void) {
  const session = client.sessionGeneration;
  const current = () => !signal.aborted && client.sessionGeneration === session;
  if (!current()) return;
  update({status: 'loading'});
  try {
    const raw = await client.get('/events', {signal});
    if (current()) update({status: 'ready', items: upcomingEvents(raw)});
  } catch {if (current()) update({status: 'error'});}
}
export function UpcomingEventsContent({state, retry, navigate}: {state: EventsState; retry: () => void; navigate: GuildBlockContext['navigate']}) {
  return <>
    {state.status === 'loading' ? <p role="status">正在讀取近期活動…</p>
      : state.status === 'error' ? <><p role="alert">暫時無法讀取近期活動。</p><button type="button" className="btn btn-ghost" onClick={retry}>重試</button></>
      : state.items.length ? <ul>{state.items.map(item => <li key={item.event_id}>
        <a href={`#events/${item.event_id}`} onClick={event => {event.preventDefault(); navigate(`#events/${item.event_id}`);}}>{item.title}</a>
        {' · '}<time dateTime={item.starts_at}>{formatIsoLocal(item.starts_at)}</time>
      </li>)}</ul> : <p>目前沒有可顯示的近期活動。</p>}
    <div className="actions"><a className="btn btn-ghost" href="#events" onClick={event => {event.preventDefault(); navigate('#events');}}>查看活動</a></div>
  </>;
}
export function UpcomingEventsBlock({client, guildKey, userId, visitor, mode, navigate}: GuildBlockContext) {
  const [state, setState] = useState<EventsState>({status: 'loading'});
  const [refresh, setRefresh] = useState(0);
  const member = !visitor && mode === 'member' && Boolean(userId);
  useEffect(() => {
    if (!member) return;
    const controller = new AbortController();
    void loadUpcomingEvents(client, controller.signal, setState);
    return () => controller.abort();
  }, [client, client.sessionGeneration, guildKey, userId, member, refresh]);
  return <section className="guild-launchpad-block" aria-label="近期活動">
    <h2>近期活動</h2>
    {member ? <UpcomingEventsContent state={state} retry={() => setRefresh(value => value + 1)} navigate={navigate}/>
      : <p>登入並加入公會後，可查看目前有權閱讀的近期活動。</p>}
  </section>;
}
