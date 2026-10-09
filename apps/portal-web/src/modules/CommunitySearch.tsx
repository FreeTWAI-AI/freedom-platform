import { useEffect, useRef, useState } from 'react';
import { communitySearchKinds, communitySearchTopics, communitySearchKindLabels, communitySearchTopicLabels, communitySearchPageSchema, type CommunitySearchPage } from '../../../../packages/shared/community-search';
import { ApiError, type PortalClient } from '../api';
import { CommunityRelationsProvider, CommunityRelations, CommunityBookmarkButton, CommunityAuthorFollowButton } from './CommunityRelations';

type Kind = typeof communitySearchKinds[number];
type Topic = typeof communitySearchTopics[number];
type Mine = { kind: Kind; id: string; title: string; topics: Topic[]; aggregate_version: number | null };
const readQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');
const message = (error: unknown) => error instanceof Error ? error.message : '無法載入，請重試。';

export function CommunitySearch({ client, authKey, relationsEnabled = false }: { client: PortalClient; authKey: string | null; relationsEnabled?: boolean }) {
  return authKey && relationsEnabled
    ? <CommunityRelationsProvider key={authKey} client={client}><SearchContent client={client} authKey={authKey} relationsEnabled /></CommunityRelationsProvider>
    : <SearchContent client={client} authKey={authKey} relationsEnabled={false} />;
}

function SearchContent({ client, authKey, relationsEnabled }: { client: PortalClient; authKey: string | null; relationsEnabled: boolean }) {
  const [query, setQuery] = useState(readQuery);
  const [retry, setRetry] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; page: CommunitySearchPage } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const requestKey = `${authKey ?? 'anonymous'}:${query.toString()}:${refresh}`;
  const currentKey = useRef(requestKey);
  currentKey.current = requestKey;
  useEffect(() => {
    const changed = () => setQuery(readQuery());
    const refreshResults = () => setRefresh(value => value + 1);
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    window.addEventListener('focus', refreshResults);
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('popstate', changed); window.removeEventListener('focus', refreshResults); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailure(null); setResult(null);
    const timer = window.setTimeout(() => {
      void client.get<unknown>(`/community-search?${query}`, { signal: controller.signal, suppressConsole: true })
        .then(value => { const page = communitySearchPageSchema.parse(value); if (!controller.signal.aborted && currentKey.current === requestKey) setResult({ key: requestKey, page }); })
        .catch(cause => { if (!controller.signal.aborted && currentKey.current === requestKey) setFailure({ key: requestKey, message: message(cause) }); })
        .finally(() => { if (!controller.signal.aborted && currentKey.current === requestKey) setLoading(false); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [client, requestKey, retry]);
  function update(name: string, value: string) {
    const next = new URLSearchParams(query);
    if (value) next.set(name, value); else next.delete(name);
    if (name !== 'cursor') next.delete('cursor');
    const hash = `#community-search${next.size ? `?${next}` : ''}`;
    // Text edits replace the current query; paging keeps browser-back history.
    if (name === 'cursor') window.history.pushState(null, '', hash);
    else window.history.replaceState(null, '', hash);
    setQuery(next);
  }
  function toggle(name: 'kinds' | 'topics', value: string) {
    const selected = (query.get(name) ?? '').split(',').filter(Boolean);
    update(name, selected.includes(value) ? selected.filter(item => item !== value).join(',') : [...selected, value].join(','));
  }
  const page = result?.key === requestKey ? result.page : null;
  const error = failure?.key === requestKey ? failure.message : '';
  return <div className="stack community-content-search">
    {relationsEnabled && <CommunityRelations client={client} />}
    <section className="card stack" aria-label="社群內容搜尋條件">
      <p className="muted">搜尋貼文、作品、技能書與活動；只顯示目前可閱讀的內容。這不是導覽的「搜尋功能」。</p>
      <label className="field">關鍵字<input type="search" maxLength={80} value={query.get('q') ?? ''} onChange={event => update('q', event.target.value)} placeholder="例如：入門教學、設計" /></label>
      <fieldset><legend>內容類型（可複選）</legend><div className="actions">{communitySearchKinds.map(kind => <label key={kind}><input type="checkbox" checked={(query.get('kinds') ?? '').split(',').includes(kind)} onChange={() => toggle('kinds', kind)} /> {communitySearchKindLabels[kind]}</label>)}</div></fieldset>
      <fieldset><legend>主題（可複選）</legend><div className="actions">{communitySearchTopics.map(topic => <label key={topic}><input type="checkbox" checked={(query.get('topics') ?? '').split(',').includes(topic)} onChange={() => toggle('topics', topic)} /> {communitySearchTopicLabels[topic]}</label>)}</div></fieldset>
      {query.has('cursor') && <button className="btn btn-secondary btn-small" onClick={() => update('cursor', '')}>回第一頁</button>}
    </section>
    <section className="stack" aria-label="社群內容搜尋結果" aria-busy={loading || !page && !error}>
      {(loading || !page && !error) && <p role="status">正在搜尋社群內容…</p>}
      {error && <div className="card stack"><p role="alert">{error}</p><button className="btn btn-secondary btn-small" onClick={() => setRetry(value => value + 1)}>重試搜尋</button></div>}
      {page && !page.items.length && <p role="status">沒有符合條件的內容。可更換關鍵字或取消篩選；未標主題的內容仍可用文字搜尋。</p>}
      {page?.items.map(item => <article className="card stack" key={`${item.kind}:${item.id}`}>
        <p className="field-hint">{communitySearchKindLabels[item.kind]}{item.label ? ` · ${item.label}` : ''}</p>
        <h2><a href={item.path} rel="noopener noreferrer">{item.title}</a></h2>
        <p>{item.summary}</p>
        {item.topics.length > 0 && <p className="field-hint">{item.topics.map(topic => communitySearchTopicLabels[topic]).join(' · ')}</p>}
        {relationsEnabled && <div className="actions"><CommunityBookmarkButton client={client} kind={item.kind} id={item.id} />{item.author_id && <CommunityAuthorFollowButton client={client} authorId={item.author_id} />}</div>}
      </article>)}
      {page?.next_cursor && <button className="btn btn-secondary btn-small" onClick={() => update('cursor', page.next_cursor!)}>下一頁</button>}
    </section>
    {authKey && <MyContentTopics key={authKey} client={client} onSaved={() => setRefresh(value => value + 1)} />}
  </div>;
}

function MyContentTopics({ client, onSaved }: { client: PortalClient; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Mine[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setItems(null); setError('');
    void client.get<{ items: Mine[] }>('/community-search/mine', { signal: controller.signal, suppressConsole: true })
      .then(value => { if (!controller.signal.aborted) setItems(value.items); })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [client, open, retry]);
  return <section className="card stack"><button className="btn btn-secondary btn-small" aria-expanded={open} onClick={() => setOpen(value => !value)}>編輯我的內容主題</button>
    {open && <><p className="field-hint">選填，最多三個；不補主題也能發布及依文字查到。此處列出各類最近可編輯的內容。</p>
      {notice && <p role="status">{notice}</p>}
      {!items && !error && <p role="status">正在載入我的內容…</p>}
      {error && <><p role="alert">{error}</p><button className="btn btn-secondary btn-small" onClick={() => setRetry(value => value + 1)}>重新載入我的內容</button></>}
      {items?.length === 0 && <p>目前沒有可編輯主題的內容。</p>}
      {items?.map(item => <TopicEditor key={`${item.kind}:${item.id}:${item.aggregate_version}`} item={item} client={client} onSaved={() => { setNotice('主題已儲存。'); setRetry(value => value + 1); onSaved(); }} onConflict={() => { setNotice('主題版本已變更，已重新載入。請重新選擇後儲存。'); setRetry(value => value + 1); }} />)}
    </>}
  </section>;
}

function TopicEditor({ item, client, onSaved, onConflict }: { item: Mine; client: PortalClient; onSaved: () => void; onConflict: () => void }) {
  const [topics, setTopics] = useState(item.topics);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const lock = useRef(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save() {
    if (lock.current) return;
    lock.current = true; setPending(true); setError('');
    const body = { kind: item.kind, id: item.id, topics: [...topics].sort() };
    const signature = JSON.stringify(body);
    if (attempt.current?.body !== signature) attempt.current = { body: signature, key: crypto.randomUUID() };
    try {
      await client.post('/community-search/topics', body, { idempotencyKey: attempt.current.key, ...(item.aggregate_version === null ? {} : { ifMatch: item.aggregate_version }) });
      if (mounted.current) { attempt.current = null; onSaved(); }
    } catch (cause) {
      if (mounted.current) {
        if (cause instanceof ApiError && (cause.conflict || cause.status === 428)) { onConflict(); }
        else setError(message(cause));
      }
    } finally { lock.current = false; if (mounted.current) setPending(false); }
  }
  return <div className="stack"><h3>{item.title} <span className="field-hint">{communitySearchKindLabels[item.kind]}</span></h3>
    <fieldset disabled={pending}><legend>選填主題（最多三個）</legend><div className="actions">{communitySearchTopics.map(topic => <label key={topic}><input type="checkbox" checked={topics.includes(topic)} disabled={!topics.includes(topic) && topics.length >= 3} onChange={() => setTopics(current => current.includes(topic) ? current.filter(value => value !== topic) : [...current, topic])} /> {communitySearchTopicLabels[topic]}</label>)}</div></fieldset>
    {error && <p role="alert">{error}</p>}
    <button className="btn btn-secondary btn-small" disabled={pending} onClick={() => void save()}>{pending ? '正在儲存…' : error ? '重試儲存主題' : '儲存主題'}</button>
  </div>;
}
