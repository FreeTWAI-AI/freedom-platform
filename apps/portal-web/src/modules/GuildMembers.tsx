import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import { useModuleMutation } from './shared';
import { DirectoryMemberRow, loadLabels, type MemberCardData } from './Membership';
import './GuildMembers.css';

const TIER_LOCKED = '會長與公會專家必須是正式成員；請先解除專家任命。';
const EXPERT_CAP = '每個公會最多 3 位公會專家，請先移除一位再任命。';

type Filters = { search: string; sort: 'nickname' | 'newest' | 'oldest' };
type MemberPage = { items: MemberCardData[]; total: number; next_offset: number | null };
const defaults: Filters = { search: '', sort: 'nickname' };

/** Mounted only while one guild is expanded; the server owns membership/privacy. */
export function GuildMembers({ client, guildKey, guildName, masterId, expertIds = [], viewerId, expertCount = 0, onChanged }: {
  client: PortalClient; guildKey: string; guildName: string; masterId?: string; expertIds?: string[];
  viewerId?: string; expertCount?: number; onChanged?: () => void;
}) {
  const [search, setSearch] = useState(''), [filters, setFilters] = useState<Filters>(defaults);
  const [members, setMembers] = useState<MemberCardData[]>([]), [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null), [loading, setLoading] = useState(true), [error, setLoadError] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const generation = useRef(0), offsetRef = useRef(0), filtersRef = useRef(filters);
  const [confirm, setConfirm] = useState<{ userId: string; kind: 'demote' | 'revoke' } | null>(null);
  const { mutate, busy, error: actionError, setError: setActionError } = useModuleMutation(client);
  filtersRef.current = filters;
  const isMaster = Boolean(viewerId && viewerId === masterId);
  const load = useCallback(async (offset = 0) => {
    const sequence = ++generation.current, current = filtersRef.current;
    const query = new URLSearchParams({ guild_key: guildKey, sort: current.sort, limit: '10', offset: String(offset) });
    if (current.search) query.set('search', current.search);
    setLoadError(''); setLoading(true); offsetRef.current = offset;
    if (!offset) { setMembers([]); setNext(null); setTotal(null); }
    try {
      const result = await client.get<MemberPage>(`/members?${query}`);
      if (sequence !== generation.current) return;
      setMembers(existing => offset ? [...new Map([...existing, ...result.items].map(member => [member.user_id, member])).values()] : result.items);
      setTotal(result.total); setNext(result.next_offset);
    } catch (cause) {
      if (sequence === generation.current) setLoadError(cause instanceof Error ? cause.message : '成員暫時無法載入，請重試。');
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
    generation.current++; setSearch(value); setLoadError('');
    if (value.trim() === filters.search) void load();
    else { setMembers([]); setTotal(null); setNext(null); setLoading(true); }
  }
  async function apply(member: MemberCardData, path: string, body: unknown, version: number | null) {
    const saved = await mutate(path, body, version ?? undefined);
    if (!saved) return;
    setConfirm(null); setActionError(null); await load(0); onChanged?.();
  }
  function submit(event: FormEvent) {
    event.preventDefault(); generation.current++;
    if (search.trim() === filters.search) void load();
    else setFilters(current => ({ ...current, search: search.trim() }));
  }
  return <section className="guild-members members-panel" id={`members-${guildKey}`} aria-label={`${guildName}成員`}>
    <header className="guild-members-heading"><h4>公會成員</h4><p aria-live="polite">{total === null ? loading ? '正在載入成員…' : '' : `顯示 ${members.length} / ${total} 位成員`}</p>{isMaster && <p className="guild-expert-count">專家 {expertCount}/3</p>}</header>
    {isMaster && expertCount >= 3 && <p className="field-hint guild-expert-cap">{EXPERT_CAP}</p>}
    <form className="guild-members-filters" onSubmit={submit}>
      <label className="field">搜尋公會成員<input type="search" value={search} onChange={event => editSearch(event.target.value)} maxLength={100} placeholder="暱稱、定位或專長"/></label>
      <label className="field">成員排序<select value={filters.sort} onChange={event => { generation.current++; setFilters(current => ({ ...current, sort: event.target.value as Filters['sort'] })); }}><option value="nickname">暱稱</option><option value="newest">最新加入工坊</option><option value="oldest">最早加入工坊</option></select></label>
      <button className="btn btn-ghost" type="submit">搜尋成員</button>
    </form>
    {error && <div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load(offsetRef.current)}>重新載入成員</button></div>}
    {actionError && <div className="banner banner-error" role="alert"><p>{actionError}</p></div>}
    <div className="directory-rows" aria-busy={loading}>{members.map(member => {
      const roster = member.guild_roster, expert = expertIds.includes(member.user_id) || roster?.expert_active === true;
      const mine = member.user_id === viewerId, confirming = confirm?.userId === member.user_id ? confirm.kind : null;
      const capReached = expertCount >= 3 && !expert;
      return <DirectoryMemberRow key={member.user_id} member={member} labels={labels} client={client}>
        <span className="guild-member-roster">
          {member.user_id === masterId && <span className="badge guild-member-leader">公會長</span>}
          {expert && <span className="badge guild-member-expert">公會專家</span>}
          {roster?.member_tier === 'full' && <span className="badge guild-member-tier-full">正式成員</span>}
          {roster?.member_tier === 'intern' && <span className="badge guild-member-tier-intern">實習成員</span>}
          {isMaster && !mine && roster && <span className="guild-member-actions">
            {roster.member_tier === 'intern' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void apply(member, `/guilds/${encodeURIComponent(guildKey)}/members/${member.user_id}/tier`, { member_tier: 'full' }, roster.aggregate_version)}>設為正式成員</button>}
            {roster.member_tier === 'full' && confirming !== 'demote' && <button type="button" className="btn btn-ghost" disabled={busy || expert} onClick={() => setConfirm({ userId: member.user_id, kind: 'demote' })}>改回實習成員</button>}
            {expert && <span className="guild-member-reason">{TIER_LOCKED}</span>}
            {expert && confirming !== 'revoke' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm({ userId: member.user_id, kind: 'revoke' })}>解除專家</button>}
            {!expert && <button type="button" className="btn btn-ghost" disabled={busy || capReached} onClick={() => void apply(member, `/guilds/${encodeURIComponent(guildKey)}/experts`, { user_id: member.user_id, active: true }, roster.expert_aggregate_version)}>任命專家</button>}
            {capReached && <span className="guild-member-reason">{EXPERT_CAP}</span>}
            {confirming === 'demote' && <span className="guild-member-confirm"><span>改回實習成員後，就不能發布或編輯公會內容。</span><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void apply(member, `/guilds/${encodeURIComponent(guildKey)}/members/${member.user_id}/tier`, { member_tier: 'intern' }, roster.aggregate_version)}>確認</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>取消</button></span>}
            {confirming === 'revoke' && <span className="guild-member-confirm"><span>解除後，這位成員不再顯示公會專家。</span><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void apply(member, `/guilds/${encodeURIComponent(guildKey)}/experts`, { user_id: member.user_id, active: false }, roster.expert_aggregate_version)}>確認</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>取消</button></span>}
          </span>}
        </span>
      </DirectoryMemberRow>;
    })}</div>
    {loading && members.length > 0 && <p role="status">正在載入更多成員…</p>}
    {!loading && !error && !members.length && <p className="guild-members-empty">{filters.search ? '沒有符合的公會成員。' : '目前沒有可顯示的公會成員。'}</p>}
    {next !== null && !error && <button className="btn btn-ghost" type="button" disabled={loading} onClick={() => void load(next)}>查看更多成員</button>}
  </section>;
}
