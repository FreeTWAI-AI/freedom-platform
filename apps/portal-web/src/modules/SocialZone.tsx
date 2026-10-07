import {useCallback, useEffect, useId, useRef, useState,useSyncExternalStore, type FormEvent} from 'react';
import {accessAwareFetch} from '../access-fetch';
import {ApiError, type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import {PLATFORM_LABELS, type SocialPlatform} from '../../../../packages/shared/share-url';
import {MemberAvatar} from './MemberAvatar';
import {PromotionShare} from './PromotionShare';
import {SocialInteractions} from './SocialInteractions';
import './SocialZone.css';
import {socialPostJobForSession} from '../social-post-task';
import {SocialPostOptimizer} from './SocialPostOptimizer';
import './SocialPostOptimizer.css';

export type SocialPost = {
  post_id: string; url: string | null; kind: 'link' | 'note'; platform: SocialPlatform; platform_label: string; title: string; note: string | null; created_at: string;
  author: {user_id: string; display_name: string; avatar_url: string | null};
  thumbnail_url: string | null; total_points: number; my_points: number; mine: boolean;
  like_count: number; comment_count: number; liked: boolean;
};
type Post = SocialPost;
type Page = {items: Post[]; next_cursor: string | null; can_hide: boolean};
const FILTERS = [
  {id: '', label: '全部'},
  {id: 'note', label: '工坊貼文'},
  {id: 'youtube', label: 'YouTube'},
  {id: 'instagram', label: 'Instagram'},
  {id: 'facebook', label: 'Facebook'},
  {id: 'other', label: '其他'},
] as const;

function tone(platform: SocialPlatform) {
  return platform === 'youtube' || platform === 'instagram' || platform === 'facebook' ? platform : 'other';
}
function hostOf(url: string | null) { try { return new URL(url ?? '').hostname; } catch { return url; } }

function SocialBody({text}:{text:string}) {
  const [expanded,setExpanded]=useState(false);
  const id=useId(),long=text.length>180||text.split('\n').length>4;
  return <div className="social-post-text"><p id={id} className={`social-note multiline-text${long&&!expanded?' is-preview':''}`}>{text}</p>
    {long&&<button type="button" className="social-read-more" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)}>{expanded?'收合':'顯示全文'}</button>}
  </div>;
}

function Thumb({post}: {post: Post}) {
  const [broken, setBroken] = useState(false);
  if (post.kind === 'note' && !post.thumbnail_url) return null;
  if (!post.thumbnail_url || broken) return <div className="social-placeholder" data-platform={tone(post.platform)}><span className="social-platform-badge" data-platform={tone(post.platform)}>{post.platform_label}</span><span>{hostOf(post.url)}</span></div>;
  return <img className="social-thumb" src={post.thumbnail_url} alt="" width={640} height={360} onError={() => setBroken(true)}/>;
}

export function SocialZone({client, canReview = false, viewer}: {client: PortalClient; canReview?: boolean; viewer?: {name: string; avatarUrl?: string | null}}) {
  const composerId = useId();
  const composer = useRef<HTMLDialogElement>(null), composerTrigger = useRef<HTMLButtonElement>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [platform, setPlatform] = useState('');
  const [items, setItems] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [canHide, setCanHide] = useState(canReview);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [optimizerEnabled,setOptimizerEnabled]=useState(false);
  const [optimizationJob]=useState(()=>socialPostJobForSession(client));
  const optimization=useSyncExternalStore(optimizationJob.subscribe,optimizationJob.snapshot,optimizationJob.snapshot);
  const [originalDraft,setOriginalDraft]=useState<{before:string;after:string}|null>(null);
  const pending = useRef<{text: string; key: string} | null>(null);
  const loadSequence = useRef(0);
  const selection = useRef({platform: '', version: 0});
  const composerVersion = useRef(0);
  const newPosts = useRef<Post[]>([]);
  const load = useCallback(async (nextPlatform: string, nextCursor?: string) => {
    const sequence = ++loadSequence.current;
    if (nextCursor) setMore(true); else setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams();
      if (nextPlatform === 'note') query.set('kind', 'note');
      else if (nextPlatform) query.set('platform', nextPlatform);
      if (nextCursor) query.set('cursor', nextCursor);
      const page = await client.get<Page>(`/social-posts${query.size ? `?${query}` : ''}`);
      if (sequence !== loadSequence.current) return;
      const fresh = nextPlatform === '' || nextPlatform === 'note' ? newPosts.current.filter(post => !page.items.some(item => item.post_id === post.post_id)) : [];
      setItems(current => nextCursor ? [...current, ...page.items.filter(post => !current.some(item => item.post_id === post.post_id))] : [...fresh, ...page.items]);
      newPosts.current = newPosts.current.filter(post => !page.items.some(item => item.post_id === post.post_id));
      setCursor(page.next_cursor);
      setCanHide(page.can_hide);
    } catch (cause) { if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : '貼文暫時無法載入。'); }
    finally { if (sequence === loadSequence.current) { setLoading(false); setMore(false); } }
  }, [client]);
  useEffect(() => { void load(platform); }, [load, platform]);
  useEffect(() => () => { ++loadSequence.current; }, []);
  useEffect(() => { if (composerOpen && !composer.current?.open) {composer.current?.showModal(); composer.current?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus();} }, [composerOpen]);
  function selectPlatform(next: string) {
    if (selection.current.platform === next) return;
    selection.current = {platform: next, version: selection.current.version + 1};
    ++loadSequence.current;
    setPlatform(next);
  }
  function openComposer() { ++composerVersion.current; setComposerOpen(true); }
  function closeComposer() { ++composerVersion.current; composer.current?.close(); setComposerOpen(false); composerTrigger.current?.focus({preventScroll: true}); }
  async function publish(event: FormEvent) {
    event.preventDefault();
    if (publishing) return;
    const command = pending.current ?? {text: text.trim(), key: crypto.randomUUID()};
    if (!command.text) return;
    pending.current = command;
    const selectedVersion = selection.current.version, interactionVersion = composerVersion.current;
    setPublishing(true); setPublishError(''); setNotice('');
    try {
      const created = await client.post<Post>('/social-posts/notes', {text: command.text}, {idempotencyKey: command.key});
      newPosts.current = [created, ...newPosts.current.filter(post => post.post_id !== created.post_id)];
      const currentSelection = selection.current;
      if (currentSelection.platform === '' || currentSelection.platform === 'note') {
        setItems(current => [created, ...current.filter(post => post.post_id !== created.post_id)]);
      } else if (currentSelection.version === selectedVersion) {
        // Jump to a saved note only if the viewer has not chosen another feed
        // while the acknowledgement was in flight.
        setItems([created]); setCursor(null); selectPlatform('note');
      }
      pending.current = null; setText(''); setOriginalDraft(null);setNotice('貼文已發布。');
      if (composerVersion.current === interactionVersion) closeComposer();
    } catch (cause) {
      if (cause instanceof ApiError && !cause.network) pending.current = null;
      setPublishError(cause instanceof Error ? cause.message : '尚未確認發布結果，請重試。');
    } finally { setPublishing(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!client.csrfToken) { setError('登入狀態已變更，請重新整理。'); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await accessAwareFetch('/api/v1/social-posts', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': crypto.randomUUID()},
        body: JSON.stringify({url, ...(title.trim() ? {title: title.trim()} : {}), ...(note.trim() ? {note: note.trim()} : {})}),
      });
      const payload = await response.json() as {post_id?: string; detail?: string; code?: string};
      if (response.status === 409 && payload.post_id) {
        setNotice('這則貼文已經有人分享過了。');
        document.getElementById(`social-post-${payload.post_id}`)?.scrollIntoView({block: 'center'});
        return;
      }
      if (!response.ok) throw new ApiError({message: payload.detail || '貼文未能分享。', status: response.status, code: payload.code});
      const created = payload as unknown as Post;
      if (file) {
        const uploaded = await accessAwareFetch(`/api/v1/social-posts/${created.post_id}/thumbnail`, {
          method: 'PUT', credentials: 'same-origin', body: file,
          headers: {Accept: 'application/json', 'Content-Type': file.type, 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': crypto.randomUUID()},
        });
        if (!uploaded.ok) {
          const problem = await uploaded.json().catch(() => ({})) as {detail?: string};
          throw new ApiError({message: problem.detail || '縮圖未能換上，貼文已建立。', status: uploaded.status});
        }
      }
      setUrl(''); setTitle(''); setNote(''); setFile(null); setNotice('已分享這則貼文。');
      await load(platform);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '貼文未能分享。'); }
    finally { setSaving(false); }
  }
  async function upload(post: Post, next: File) {
    if (!client.csrfToken) return;
    setSaving(true); setError('');
    try {
      const response = await accessAwareFetch(`/api/v1/social-posts/${post.post_id}/thumbnail`, {
        method: 'PUT', credentials: 'same-origin', body: next,
        headers: {Accept: 'application/json', 'Content-Type': next.type, 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': crypto.randomUUID()},
      });
      const payload = await response.json() as Post & {detail?: string};
      if (!response.ok) throw new ApiError({message: payload.detail || '縮圖未能換上。', status: response.status});
      setItems(current => current.map(item => item.post_id === post.post_id ? {...item, ...payload, thumbnail_url: `${payload.thumbnail_url ?? item.thumbnail_url}?v=${Date.now()}`} : item));
      setNotice('縮圖已更新。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '縮圖未能換上。'); }
    finally { setSaving(false); }
  }
  async function remove(post: Post) {
    if (!client.csrfToken) return;
    setSaving(true); setError('');
    try {
      const response = await accessAwareFetch(`/api/v1/social-posts/${post.post_id}`, {
        method: 'DELETE', credentials: 'same-origin', body: '{}',
        headers: {'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': crypto.randomUUID()},
      });
      if (!response.ok) { const problem = await response.json().catch(() => ({})) as {detail?: string}; throw new ApiError({message: problem.detail || '貼文未能刪除。', status: response.status}); }
      setItems(current => current.filter(item => item.post_id !== post.post_id));
      newPosts.current = newPosts.current.filter(item => item.post_id !== post.post_id);
      setConfirming(null); setNotice('貼文已刪除。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '貼文未能刪除。'); }
    finally { setSaving(false); }
  }
  async function hide(post: Post) {
    setSaving(true); setError('');
    try { await client.post(`/social-posts/${post.post_id}/hide`, {}); setItems(current => current.filter(item => item.post_id !== post.post_id)); setNotice('貼文已隱藏。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '貼文未能隱藏。'); }
    finally { setSaving(false); }
  }
  return <section className="social-zone stack" aria-label="社群媒體分享專區">
    <div className="card social-composer-start" data-guide-anchor="social:composer">
      <div className="social-composer-prompt"><MemberAvatar nickname={viewer?.name ?? '我'} avatarUrl={viewer?.avatarUrl}/>
        <button ref={composerTrigger} type="button" className="social-write-trigger" aria-label="建立貼文" aria-haspopup="dialog" onClick={openComposer}>{pending.current ? '繼續確認剛才的貼文…' : text ? '繼續編輯你的貼文…' : '分享近況、作品或想法…'}</button>
      </div>
    <details className="social-composer">
      <summary>分享外部連結</summary>
      <form onSubmit={event => void submit(event)} aria-busy={saving}>
        <label className="field">連結<input required type="url" inputMode="url" maxLength={2048} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://"/></label>
        <label className="field">標題（選填）<input maxLength={120} value={title} onChange={event => setTitle(event.target.value)}/></label>
        <label className="field">說明（選填）<textarea maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)}/></label>
        <label className="field">縮圖（選填，否則自動抓取）<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0] ?? null)}/></label>
        <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? '正在讀取預覽…' : '分享貼文'}</button>
      </form>
    </details>
    </div>
    <dialog ref={composer} className="social-publish-dialog" aria-labelledby={composerId} onCancel={event => {event.preventDefault(); closeComposer();}} onClose={() => setComposerOpen(false)}>
      {composerOpen && <div className="stack">
        <header className="social-publish-head"><h2 id={composerId}>建立貼文</h2><button type="button" className="btn btn-ghost" aria-label="關閉發文" onClick={closeComposer}>關閉</button></header>
        <p className="social-publish-identity"><MemberAvatar nickname={viewer?.name ?? '我'} avatarUrl={viewer?.avatarUrl}/><span>{viewer?.name ?? '我'}<small>社群會員可見</small></span></p>
        <form className="social-native-composer stack" onSubmit={event => void publish(event)} aria-busy={publishing}>
          <label className="field"><span className="sr-only">貼文內容</span><textarea aria-label="貼文內容" autoFocus required rows={6} maxLength={2000} placeholder="分享近況、作品，或找夥伴一起做點事…" value={text} disabled={publishing || !!pending.current} onChange={event => setText(event.target.value)}/></label>
          <div className="social-composer-tools"><button type="button" className="btn btn-ghost" aria-pressed={optimizerEnabled} aria-expanded={optimizerEnabled} aria-controls={`${composerId}-optimizer`} disabled={publishing||!!pending.current||optimization.phase==='busy'} onClick={()=>setOptimizerEnabled(value=>!value)}>✦ Social Post 優化</button>{originalDraft&&<button type="button" className="btn btn-ghost" disabled={publishing||!!pending.current||text!==originalDraft.after} onClick={()=>{setText(originalDraft.before);setOriginalDraft(null);}}>復原原稿</button>}</div>
          {optimizerEnabled&&<div id={`${composerId}-optimizer`}><SocialPostOptimizer client={client} job={optimizationJob} draft={text} disabled={publishing||!!pending.current} onRecoverDraft={draft=>{setOriginalDraft({before:text,after:draft});setText(draft);}} onApply={result=>{setOriginalDraft({before:text,after:result});setText(result);optimizationJob.adopt();}}/></div>}
          <div className="social-composer-footer"><span className="muted">{text.length}/2000</span><button className="btn btn-primary" disabled={publishing || !text.trim()}>{publishing ? '發布中…' : pending.current ? '重試發布' : '發布貼文'}</button></div>
          {publishError && <p className="banner banner-error" role="alert">{publishError}</p>}
        </form>
      </div>}
    </dialog>
    {notice && <p className="banner banner-info" role="status">{notice}</p>}
    {error && <div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={() => void load(platform)}>重試</button></div>}
    <div className="social-filters" data-guide-anchor="social:platform" role="group" aria-label="平台">
      <label className="social-filter-select"><span className="sr-only">查看貼文</span><select value={platform} onChange={event=>selectPlatform(event.target.value)}>{FILTERS.map(item=><option key={item.id||'all'} value={item.id}>{item.label}</option>)}</select></label>
      <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load(platform)}>更新動態</button>
    </div>
    {loading && <p role="status">正在載入貼文…</p>}
    {!loading && items.length === 0 && <p className="empty">{platform ? '這個分類還沒有貼文。' : '還沒有動態。分享第一則近況，和夥伴開始聊聊。'}</p>}
    <div className="social-grid">
      {items.map(post => <article className="card social-card" key={post.post_id} id={`social-post-${post.post_id}`}>
        <div className="social-card-body">
          <p className="social-byline"><MemberAvatar nickname={post.author.display_name} avatarUrl={post.author.avatar_url} className="social-avatar"/> <span>{post.author.display_name}</span> <time dateTime={post.created_at}>{formatIsoLocal(post.created_at)}</time></p>
          <span className="social-platform-badge" data-platform={tone(post.platform)}>{post.platform_label || PLATFORM_LABELS[post.platform]}</span>
          {post.kind !== 'note' && <h3>{post.title}</h3>}
          {post.note && <SocialBody text={post.note}/>}
          <Thumb post={post}/>
          {post.kind !== 'note' && <p className="social-points">推廣點擊 {post.total_points}</p>}
          <SocialInteractions client={client} post={post} canHide={canHide} onUpdate={update => setItems(current => current.map(item => item.post_id === post.post_id ? {...item, ...update} : item))}/>
          <div className="social-actions">
            {post.url && <a className="btn btn-ghost" href={post.url} target="_blank" rel="noopener noreferrer">開啟原文 ↗</a>}
            {post.kind !== 'note' && <PromotionShare client={client} kind="social_post" target={post.post_id} title={post.title} label="分享"/>}
            {post.mine && <label className="btn btn-ghost social-file">{post.kind === 'note' ? post.thumbnail_url ? '換圖片' : '加入圖片' : '換縮圖'}<input aria-label={post.kind === 'note' ? '貼文圖片（JPEG、PNG、WebP，512 KiB 以下）' : '更換縮圖'} type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} onChange={event => { const next = event.target.files?.[0]; if (next) void upload(post, next); event.target.value = ''; }}/></label>}
            {post.mine && confirming !== post.post_id && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setConfirming(post.post_id)}>刪除</button>}
            {post.mine && confirming === post.post_id && <>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void remove(post)}>確定刪除</button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>取消</button>
            </>}
            {canHide && !post.mine && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void hide(post)}>隱藏</button>}
          </div>
        </div>
      </article>)}
    </div>
    {cursor && <button type="button" className="btn btn-ghost" disabled={more} onClick={() => void load(platform, cursor)}>{more ? '正在載入…' : '載入更多'}</button>}
  </section>;
}
