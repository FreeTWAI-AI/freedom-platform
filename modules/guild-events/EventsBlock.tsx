import React from 'react';
import {z} from 'zod';
import {useGuildRead, type GuildBlockProps} from '../../packages/guild-presentation/block';
import {GuildBlockState} from '../../apps/portal-web/src/guild-blocks/GuildBlockState';

const eventRow = z.object({
  event_id: z.string().uuid(),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  mode: z.string(),
  state: z.string(),
  guild_key: z.string().nullable().optional(),
});
const eventsPage = z.object({items: z.array(eventRow)});
type EventRow = z.infer<typeof eventRow>;
const parse = (value: unknown) => eventsPage.parse(value).items;
const MODE_LABEL: Record<string, string> = {online: '線上', in_person: '實體', hybrid: '線上與實體'};

// Same zh-TW options as the portal event list. format.ts sits outside this module's dependencies.
function formatStart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-TW', {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}).format(date);
}

function upcoming(items: readonly EventRow[], guildKey: string): EventRow[] {
  return items.filter(item => {
    const start = Date.parse(item.starts_at);
    const end = Date.parse(item.ends_at);
    return item.state === 'published' && item.guild_key === guildKey && Number.isFinite(start) && Number.isFinite(end) && end > Date.now();
  }).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.event_id.localeCompare(b.event_id)).slice(0, 3);
}

export const title = '近期活動';

export default function EventsBlock({client, viewer, navigate, guildKey}: GuildBlockProps) {
  const {state, retry} = useGuildRead(client, viewer, '/events', parse);
  const key = guildKey?.trim() ?? '';
  const rows = state.kind === 'ready' && key ? upcoming(state.data, key) : [];
  return <div className="stack">
    <p>列出這個公會已發布、尚未結束的活動。</p>
    <GuildBlockState state={state} retry={retry} noun="近期活動"/>
    {state.kind === 'ready' && (key ? <>
      {rows.length ? <ul className="stack">{rows.map(item => <li key={item.event_id}>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => navigate(`#events/${item.event_id}`)}>{item.title || '未命名活動'}</button>
        <p className="field-hint"><time dateTime={item.starts_at}>{formatStart(item.starts_at)}</time> · {MODE_LABEL[item.mode] ?? '未標示'}</p>
      </li>)}</ul> : <p>這個公會目前沒有近期活動。</p>}
      <div className="actions"><button type="button" className="btn btn-ghost btn-small" onClick={() => navigate('#events')}>查看全部活動</button></div>
    </> : <p>這個區塊需要在公會頁使用，才能列出公會活動。</p>)}
  </div>;
}
