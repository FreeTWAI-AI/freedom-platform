import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import { useMemberClient } from './GuildWorkspace';
import {
  GITHUB_REVIEW_HINT, PullFacts, ReviewQueueRow, adoptionHint, pullClaimable, versionOf,
  type PullDetail, type PullRow,
} from './review-center-shared';
import './AdminReviewCenter.css';

type QueueTab = 'awaiting_review' | 'in_review' | 'mine' | 'ready' | 'open';
type ClaimOption = { acting_as: 'guild_leader'; guild_key: string; guild_name: string };
type GuildDetail = PullDetail & { claim_options: ClaimOption[]; can_release: boolean };
type Page = {
  guilds: { guild_key: string; name: string }[];
  viewer: { github_login: string | null; reason: string | null };
  items: PullRow[];
  next_offset: number | null;
};

const TABS: Array<[QueueTab, string]> = [
  ['awaiting_review', '待審'], ['in_review', '審核中'], ['mine', '我認領的'], ['ready', '已核准'], ['open', '全部未完成'],
];

const failure = (error: unknown) => error instanceof Error ? error.message : '暫時無法完成，請重試。';

export function GuildReviews({ client }: { client: PortalClient }) {
  const api = useMemberClient(client);
  const [tab, setTab] = useState<QueueTab>('awaiting_review');
  const [page, setPage] = useState<Page | null>(null);
  const [items, setItems] = useState<PullRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GuildDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const load = useCallback(async (queue: QueueTab, offset: number) => {
    const ticket = ++listSeq.current;
    setLoading(true);
    setError('');
    try {
      const value = await api.get<Page>(`/guild-reviews?queue=${queue}&limit=25&offset=${offset}`);
      if (ticket !== listSeq.current) return;
      setPage(value);
      setItems(current => offset === 0 ? value.items : [...current, ...value.items]);
    } catch (cause) {
      if (ticket !== listSeq.current) return;
      setError(failure(cause));
    } finally {
      if (ticket === listSeq.current) setLoading(false);
    }
  }, [api]);

  const reloadDetail = useCallback(async (id: string) => {
    const ticket = ++detailSeq.current;
    try {
      const value = await api.get<GuildDetail>(`/guild-reviews/${id}`);
      if (ticket !== detailSeq.current) return;
      setDetail(value);
      setOpenId(id);
    } catch (cause) {
      if (ticket !== detailSeq.current) return;
      setError(failure(cause));
    }
  }, [api]);

  useEffect(() => {
    detailSeq.current += 1;
    setItems([]);
    setOpenId(null);
    setDetail(null);
    void load(tab, 0);
  }, [load, tab]);

  async function choose(id: string) {
    if (openId === id) { detailSeq.current += 1; setOpenId(null); setDetail(null); return; }
    setDetail(null);
    setOpenId(id);
    await reloadDetail(id);
  }
  async function afterWrite(id: string) {
    const queue = tab;
    const before = listSeq.current;
    await load(queue, 0);
    if (tabRef.current !== queue || listSeq.current !== before + 1) return;
    await reloadDetail(id);
  }

  return <section className="stack review-center">
    <div className="card-head"><h3>PR 審核</h3><button className="btn btn-ghost" type="button" disabled={loading} onClick={() => void load(tab, 0)}>更新</button></div>
    {!!page?.guilds.length && <p className="muted">{page.guilds.map(guild => guild.name).join('、')}</p>}
    {page?.viewer.reason && <p className="field-hint">{page.viewer.reason}</p>}
    <div className="actions" role="tablist" aria-label="公會 PR 審核">
      {TABS.map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} key={key} className="btn btn-ghost" onClick={() => { if (tab !== key) setTab(key); }}>{label}</button>)}
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {loading && <p role="status">正在載入審核佇列…</p>}
    <ul className="review-list" aria-label="拉取請求">
      {items.map(row => <ReviewQueueRow key={row.pull_id} row={row} open={openId === row.pull_id} onToggle={() => void choose(row.pull_id)}>
        {openId === row.pull_id && detail?.pull_id === row.pull_id && <GuildDetailPanel detail={detail} linked={!!page?.viewer.github_login} busy={loading} onError={setError} onClaim={body => api.post(`/guild-reviews/${row.pull_id}/claim`, body, versionOf(detail.aggregate_version))} onRelease={() => api.post(`/guild-reviews/claims/${detail.claim!.claim_id}/release`, {}, versionOf(detail.claim!.aggregate_version))} onDone={() => void afterWrite(row.pull_id)} />}
        {openId === row.pull_id && detail?.pull_id !== row.pull_id && <p role="status">正在載入細節…</p>}
      </ReviewQueueRow>)}
    </ul>
    {!loading && !items.length && !error && <p className="muted">這個佇列目前沒有拉取請求。</p>}
    {page?.next_offset !== null && page?.next_offset !== undefined && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load(tab, page.next_offset!)}>載入更多</button>}
  </section>;
}

function GuildDetailPanel({ detail, linked, busy, onError, onClaim, onRelease, onDone }: {
  detail: GuildDetail; linked: boolean; busy: boolean;
  onError: (message: string) => void;
  onClaim: (body: { guild_key?: string }) => Promise<unknown>;
  onRelease: () => Promise<unknown>;
  onDone: () => void;
}) {
  const options = detail.claim_options ?? [];
  const [guildKey, setGuildKey] = useState(options[0]?.guild_key ?? '');
  const [pending, setPending] = useState(false);
  const chosen = options.find(option => option.guild_key === guildKey) ?? options[0];
  const unavailable = !pullClaimable(detail);
  const claimed = !!detail.claim;
  async function claim(event: FormEvent) {
    event.preventDefault();
    if (options.length > 1 && !guildKey) { onError('你是多個公會的公會長，請選擇審完後要歸到哪個公會。'); return; }
    setPending(true);
    try {
      await onClaim(chosen ? { guild_key: chosen.guild_key } : {});
      onDone();
    } catch (cause) {
      onError(failure(cause));
    } finally {
      setPending(false);
    }
  }
  async function release() {
    setPending(true);
    try {
      await onRelease();
      onDone();
    } catch (cause) {
      onError(failure(cause));
    } finally {
      setPending(false);
    }
  }
  const locked = busy || pending;
  return <>
    <PullFacts detail={detail} />
    <div className="review-detail stack">
      <p className="field-hint">{GITHUB_REVIEW_HINT}</p>
      {detail.ownership.open_to_guilds && !detail.ownership.guild_key && chosen && <p className="field-hint">{adoptionHint(chosen.guild_name)}</p>}
      {unavailable && <p className="field-hint">這個拉取請求目前未開啟、仍是草稿或已暫停，不能認領。</p>}
      {claimed && !detail.can_release && <p className="field-hint">這個拉取請求已有人認領。</p>}
      {linked && !claimed && options.length > 0 && <form className="stack" onSubmit={event => void claim(event)}>
        {options.length > 1 && <label className="field">審完後歸到<select aria-label="審完後歸到" value={guildKey} onChange={event => setGuildKey(event.target.value)}>{options.map(option => <option key={option.guild_key} value={option.guild_key}>{option.guild_name}</option>)}</select></label>}
        <div className="actions"><button className="btn btn-ghost" disabled={locked || unavailable}>我來審</button></div>
      </form>}
      <div className="actions review-actions">
        {detail.can_release && detail.claim && <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => void release()}>放棄認領</button>}
        <a className="btn btn-ghost" href={`${detail.html_url}/files`} target="_blank" rel="noopener noreferrer">到 GitHub 審查 ↗</a>
      </div>
    </div>
  </>;
}
