import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import { DirectoryMemberRow, loadLabels, type MemberCardData } from './Membership';
import './GuildMembers.css';

type Filters = { search: string; sort: 'nickname' | 'newest' | 'oldest' };
type MemberPage = { items: MemberCardData[]; total: number; next_offset: number | null };
const defaults: Filters = { search: '', sort: 'nickname' };

/** Mounted only while one guild is expanded; the server owns membership/privacy. */
export function GuildMembers({ client, guildKey, guildName, masterId }: {
  client: PortalClient; guildKey: string; guildName: string; masterId?: string;
}) {
  const [search, setSearch] = useState(''), [filters, setFilters] = useState<Filters>(defaults);
  const [members, setMembers] = useState<MemberCardData[]>([]), [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const generation = useRef(0), offsetRef = useRef(0), filtersRef = useRef(filters);
  filtersRef.current = filters;
  const load = useCallback(async (offset = 0) => {
    const sequence = ++generation.current, current = filtersRef.current;
    const query = new URLSearchParams({ guild_key: guildKey, sort: current.sort, limit: '10', offset: String(offset) });
    if (current.search) query.set('search', current.search);
    setError(''); setLoading(true); offsetRef.current = offset;
    if (!offset) { setMembers([]); setNext(null); setTotal(null); }
    try {
      const result = await client.get<MemberPage>(`/members?${query}`);
      if (sequence !== generation.current) return;
      setMembers(existing => offset ? [...new Map([...existing, ...result.items].map(member => [member.user_id, member])).values()] : result.items);
      setTotal(result.total); setNext(result.next_offset);
    } catch (cause) {
      if (sequence === generation.current) setError(cause instanceof Error ? cause.message : '成員暫時無法載入，請重試。');
    } finally { if (sequence === generation.current) setLoading(false); }
  }, [client, guildKey]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load, filters]);
  useEffect(() => {
    let active = true;
    void loadLabels(client).then(value => { if (active) setLabels(value); }).catch(() => {});
    return () => { active = false; };
  }, [client]);
  useEffect(() => {
    const timer = setTimeout(() => setFilters(current => current.search === search.trim() ? current : { ...current, search: search.trim() }), 250);
    return () => clearTimeout(timer);
  }, [search]);
  function editSearch(value: string) {
    generation.current++; setSearch(value); setError('');
    if (value.trim() === filters.search) void load();
    else { setMembers([]); setTotal(null); setNext(null); setLoading(true); }
  }
  function submit(event: FormEvent) {
    event.preventDefault(); generation.current++;
    if (search.trim() === filters.search) void load();
    else setFilters(current => ({ ...current, search: search.trim() }));
  }
  return <section className="guild-members members-panel" id={`members-${guildKey}`} aria-label={`${guildName}成員`}>
    <header className="guild-members-heading"><h4>公會成員</h4><p aria-live="polite">{total === null ? loading ? '正在載入成員…' : '' : `顯示 ${members.length} / ${total} 位成員`}</p></header>
    <form className="guild-members-filters" onSubmit={submit}>
      <label className="field">搜尋公會成員<input type="search" value={search} onChange={event => editSearch(event.target.value)} maxLength={100} placeholder="暱稱、定位或專長"/></label>
      <label className="field">成員排序<select value={filters.sort} onChange={event => { generation.current++; setFilters(current => ({ ...current, sort: event.target.value as Filters['sort'] })); }}><option value="nickname">暱稱</option><option value="newest">最新加入工坊</option><option value="oldest">最早加入工坊</option></select></label>
      <button className="btn btn-ghost" type="submit">搜尋成員</button>
    </form>
    {error && <div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load(offsetRef.current)}>重新載入成員</button></div>}
    <div className="directory-rows" aria-busy={loading}>{members.map(member => <DirectoryMemberRow key={member.user_id} member={member} labels={labels} client={client}>{member.user_id === masterId && <span className="badge guild-member-leader">公會長</span>}</DirectoryMemberRow>)}</div>
    {loading && members.length > 0 && <p role="status">正在載入更多成員…</p>}
    {!loading && !error && !members.length && <p className="guild-members-empty">{filters.search ? '沒有符合的公會成員。' : '目前沒有可顯示的公會成員。'}</p>}
    {next !== null && !error && <button className="btn btn-ghost" type="button" disabled={loading} onClick={() => void load(next)}>查看更多成員</button>}
  </section>;
}
