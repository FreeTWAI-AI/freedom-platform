import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { communitySearchKinds, communitySearchKindLabels, communitySearchTopics, communitySearchTopicLabels, communitySearchPageSchema, type CommunitySearchPage } from '../../../../packages/shared/community-search';
import type { PortalClient } from '../api';

type ContentKind = typeof communitySearchKinds[number];
type FollowKind = 'author' | 'topic';
type Item = CommunitySearchPage['items'][number];
type Bookmark = { relation_id: string; kind: ContentKind; id: string; content: Item | null };
type BookmarkPage = { items: Bookmark[]; next_cursor: string | null };
type Follow = { relation_id: string; kind: FollowKind; id: string; label: string | null; available: boolean };
type Attempt = { key: string; selected: boolean };
type RelationsState = {
  bookmarks: Bookmark[] | null; follows: Follow[] | null; loading: boolean; error: string;
  pending: Record<string, boolean>; errors: Record<string, string>; attempts: Record<string, Attempt>;
  reload: () => void; change: (group: 'bookmarks' | 'follows', kind: ContentKind | FollowKind, id: string, selected: boolean, onChanged?: () => void) => Promise<void>;
};
const RelationsContext = createContext<RelationsState | null>(null);
const relationKey = (group: string, kind: string, id: string) => JSON.stringify([group, kind, id]);
const message = (cause: unknown) => cause instanceof Error ? cause.message : '無法載入，請重試。';

// Key this provider by the authentication key so private state never crosses sessions.
export function CommunityRelationsProvider({ client, children }: { client: PortalClient; children: ReactNode }) {
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [follows, setFollows] = useState<Follow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const locks = useRef<Record<string, boolean>>({});
  const keys = useRef<Record<string, Attempt>>({});
  const mounted = useRef(false);
  const writes = useRef<AbortController | null>(null);
  const reload = () => { setLoading(true); setBookmarks(null); setFollows(null); setRevision(value => value + 1); };
  useEffect(() => {
    mounted.current = true; writes.current = new AbortController();
    const refresh = () => reload();
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; writes.current?.abort(); window.removeEventListener('focus', refresh); };
  }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setBookmarks(null); setFollows(null);
    async function load() {
      // One shared list traversal supplies selection state for every result, not one GET per button.
      const saved: Bookmark[] = [];
      let cursor: string | null = null;
      do {
        const page: BookmarkPage = await client.get<BookmarkPage>(`/community-relations/bookmarks${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal, suppressConsole: true });
        if (controller.signal.aborted) return;
        saved.push(...page.items); cursor = page.next_cursor;
      } while (cursor);
      const following = await client.get<{ items: Follow[] }>('/community-relations/follows', { signal: controller.signal, suppressConsole: true });
      if (!controller.signal.aborted) { setBookmarks(saved); setFollows(following.items); }
    }
    void load().catch(cause => { if (!controller.signal.aborted) setError(message(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, revision]);
  async function change(group: 'bookmarks' | 'follows', kind: ContentKind | FollowKind, id: string, selected: boolean, onChanged?: () => void) {
    const key = relationKey(group, kind, id);
    if (locks.current[key]) return;
    locks.current[key] = true;
    const attempt = keys.current[key]?.selected === selected ? keys.current[key] : { key: crypto.randomUUID(), selected };
    keys.current[key] = attempt;
    setAttempts(value => ({ ...value, [key]: attempt }));
    setPending(value => ({ ...value, [key]: true })); setErrors(value => ({ ...value, [key]: '' }));
    try {
      await client.post(`/community-relations/${group}`, { kind, id, selected }, { idempotencyKey: attempt.key, signal: writes.current?.signal, suppressConsole: true });
      if (!mounted.current) return;
      delete keys.current[key]; setAttempts(value => { const next = { ...value }; delete next[key]; return next; });
      reload(); onChanged?.();
    } catch (cause) { if (mounted.current) setErrors(value => ({ ...value, [key]: message(cause) })); }
    finally { locks.current[key] = false; if (mounted.current) setPending(value => ({ ...value, [key]: false })); }
  }
  return <RelationsContext.Provider value={{ bookmarks, follows, loading, error, pending, errors, attempts, reload, change }}>{children}</RelationsContext.Provider>;
}

function RelationToggle({ group, kind, id, selected, label, onChanged, checkbox = false }: { client: PortalClient; group: 'bookmarks' | 'follows'; kind: ContentKind | FollowKind; id: string; selected: boolean; label: string; onChanged?: () => void; checkbox?: boolean }) {
  const state = useContext(RelationsContext);
  if (!state) return null;
  const key = relationKey(group, kind, id), busy = !!state.pending[key], error = state.errors[key];
  const disabled = state.loading || !!state.error || busy;
  const desired = error && state.attempts[key] ? state.attempts[key].selected : !selected;
  const retryLabel = group === 'bookmarks' ? desired ? '儲存私人書籤' : '移除書籤' : desired ? '追蹤' : '取消追蹤';
  const act = () => void state.change(group, kind, id, desired, onChanged);
  return <div className="stack" style={{ minWidth: 0 }}>
    {checkbox ? <label><input type="checkbox" checked={selected} disabled={disabled} onChange={act} /> {label}{busy ? '（儲存中）' : ''}</label> : <button className="btn btn-secondary btn-small community-search-action" type="button" disabled={disabled} aria-pressed={selected} onClick={act}>{busy ? '正在儲存…' : error ? `重試${retryLabel}` : label}</button>}
    {error && <><p role="alert">{error}</p>{checkbox && <button type="button" className="btn btn-secondary btn-small" disabled={disabled} onClick={act}>重試儲存追蹤</button>}</>}
  </div>;
}

export function CommunityBookmarkButton({ client, kind, id, onChanged }: { client: PortalClient; kind: ContentKind; id: string; onChanged?: () => void }) {
  const state = useContext(RelationsContext);
  if (!state) return null;
  const selected = !!state.bookmarks?.some(item => item.kind === kind && item.id === id);
  return <RelationToggle client={client} group="bookmarks" kind={kind} id={id} selected={selected} label={selected ? '移除書籤' : '儲存私人書籤'} onChanged={onChanged} />;
}

export function CommunityAuthorFollowButton({ client, authorId }: { client: PortalClient; authorId: string }) {
  const state = useContext(RelationsContext);
  if (!state) return null;
  const selected = !!state.follows?.some(item => item.kind === 'author' && item.id === authorId);
  return <RelationToggle client={client} group="follows" kind="author" id={authorId} selected={selected} label={selected ? '取消追蹤作者' : '追蹤作者'} />;
}

export function CommunityRelations({ client }: { client: PortalClient }) {
  const state = useContext(RelationsContext);
  const [tab, setTab] = useState<'bookmarks' | 'follows' | 'updates'>('bookmarks');
  const [bookmarkPage, setBookmarkPage] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [updates, setUpdates] = useState<{ key: string; page: CommunitySearchPage } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const requestKey = JSON.stringify([tab, cursor, state?.follows, retry]);
  const currentKey = useRef(requestKey); currentKey.current = requestKey;
  useEffect(() => {
    const controller = new AbortController();
    setUpdates(null); setFailure(null);
    if (state?.loading) setCursor(null);
    if (tab === 'updates' && state?.follows && !state.loading && !state.error) {
      void client.get<unknown>(`/community-relations/updates${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal, suppressConsole: true })
        .then(value => { const page = communitySearchPageSchema.parse(value); if (!controller.signal.aborted && currentKey.current === requestKey) setUpdates({ key: requestKey, page }); })
        .catch(cause => { if (!controller.signal.aborted && currentKey.current === requestKey) setFailure({ key: requestKey, message: message(cause) }); });
    }
    return () => controller.abort();
  }, [client, requestKey, state?.loading, state?.error]);
  if (!state) return null;
  const page = updates?.key === requestKey ? updates.page : null;
  const updateError = failure?.key === requestKey ? failure.message : '';
  const savedPage = Math.min(bookmarkPage, Math.max(0, Math.ceil((state.bookmarks?.length ?? 0) / 20) - 1));
  function select(next: typeof tab) { setTab(next); setCursor(null); setBookmarkPage(0); }
  return <section className="card stack" aria-label="我的私人書籤與追蹤" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <h2>我的書籤與追蹤</h2>
    <p className="field-hint">只有你能查看。追蹤是自行選擇，不會發送通知，也不會增加內容存取權；取消追蹤不會移除書籤。</p>
    <div className="actions" aria-label="選擇私人清單">{(['bookmarks', 'follows', 'updates'] as const).map(value => <button type="button" className="btn btn-secondary btn-small" key={value} aria-pressed={tab === value} onClick={() => select(value)}>{{ bookmarks: '私人書籤', follows: '追蹤清單', updates: '追蹤更新' }[value]}</button>)}<button type="button" className="btn btn-secondary btn-small" disabled={state.loading} onClick={() => { setCursor(null); setBookmarkPage(0); state.reload(); }}>重新載入清單</button></div>
    {state.loading && <p role="status">正在載入私人清單…</p>}
    {state.error && <><p role="alert">{state.error}</p><button className="btn btn-secondary btn-small" onClick={state.reload}>重試載入私人清單</button></>}
    {!state.loading && !state.error && <>
      {tab === 'bookmarks' && <>{state.bookmarks?.length === 0 && <p role="status">尚未儲存書籤。可從搜尋結果儲存。</p>}{state.bookmarks?.slice(savedPage * 20, (savedPage + 1) * 20).map(item => <article className="stack" key={item.relation_id}>{item.content ? <ContentLink item={item.content} /> : <p>內容目前無法存取</p>}<CommunityBookmarkButton client={client} kind={item.kind} id={item.id} /></article>)}<div className="actions">{savedPage > 0 && <button className="btn btn-secondary btn-small" onClick={() => setBookmarkPage(savedPage - 1)}>上一頁書籤</button>}{(state.bookmarks?.length ?? 0) > (savedPage + 1) * 20 && <button className="btn btn-secondary btn-small" onClick={() => setBookmarkPage(savedPage + 1)}>下一頁書籤</button>}</div></>}
      {tab === 'follows' && <><fieldset><legend>選擇要追蹤的主題</legend><div className="actions">{communitySearchTopics.map(topic => <RelationToggle client={client} key={topic} group="follows" kind="topic" id={topic} checkbox selected={!!state.follows?.some(item => item.kind === 'topic' && item.id === topic)} label={communitySearchTopicLabels[topic]} />)}</div></fieldset>{state.follows?.length === 0 && <p role="status">尚未追蹤作者或主題。可從搜尋結果追蹤作者。</p>}{state.follows?.map(item => <article className="stack" key={item.relation_id}><p>{item.available && item.label ? item.label : '追蹤對象目前無法存取'}</p><RelationToggle client={client} group="follows" kind={item.kind} id={item.id} selected label="取消追蹤" /></article>)}</>}
      {tab === 'updates' && <>{!page && !updateError && <p role="status">正在載入追蹤更新…</p>}{updateError && <><p role="alert">{updateError}</p><button className="btn btn-secondary btn-small" onClick={() => setRetry(value => value + 1)}>重試追蹤更新</button></>}{page?.items.length === 0 && <p role="status">目前沒有可閱讀的追蹤更新。可先選擇作者或主題。</p>}{page?.items.map(item => <article className="stack" key={`${item.kind}:${item.id}`}><ContentLink item={item} /><CommunityBookmarkButton client={client} kind={item.kind} id={item.id} /></article>)}<div className="actions">{cursor && <button className="btn btn-secondary btn-small" onClick={() => setCursor(null)}>回更新第一頁</button>}{page?.next_cursor && <button className="btn btn-secondary btn-small" onClick={() => setCursor(page.next_cursor)}>下一頁更新</button>}</div></>}
    </>}
  </section>;
}

function ContentLink({ item }: { item: Item }) {
  return <><p className="field-hint">{communitySearchKindLabels[item.kind]}</p><h3><a href={item.path} rel="noopener noreferrer">{item.title}</a></h3><p>{item.summary}</p></>;
}
