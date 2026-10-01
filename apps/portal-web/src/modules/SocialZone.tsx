import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {accessAwareFetch} from '../access-fetch';
import {ApiError, type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import {PLATFORM_LABELS, type SocialPlatform} from '../../../../packages/shared/share-url';
import {MemberAvatar} from './MemberAvatar';
import {PromotionShare} from './PromotionShare';
import './SocialZone.css';

type Post = {
  post_id: string; url: string; platform: SocialPlatform; platform_label: string; title: string; note: string | null; created_at: string;
  author: {user_id: string; display_name: string; avatar_url: string | null};
  thumbnail_url: string | null; total_points: number; my_points: number; mine: boolean;
};
type Page = {items: Post[]; next_cursor: string | null; can_hide: boolean};
const FILTERS = [
  {id: '', label: '全部'},
  {id: 'youtube', label: 'YouTube'},
  {id: 'instagram', label: 'Instagram'},
  {id: 'facebook', label: 'Facebook'},
  {id: 'other', label: '其他'},
] as const;

function tone(platform: SocialPlatform) {
  return platform === 'youtube' || platform === 'instagram' || platform === 'facebook' ? platform : 'other';
}
function hostOf(url: string) { try { return new URL(url).hostname; } catch { return url; } }

function Thumb({post}: {post: Post}) {
  const [broken, setBroken] = useState(false);
  if (!post.thumbnail_url || broken) return <div className="social-placeholder" data-platform={tone(post.platform)}><span className="social-platform-badge" data-platform={tone(post.platform)}>{post.platform_label}</span><span>{hostOf(post.url)}</span></div>;
  return <img className="social-thumb" src={post.thumbnail_url} alt="" width={640} height={360} onError={() => setBroken(true)}/>;
}

export function SocialZone({client, canReview = false}: {client: PortalClient; canReview?: boolean}) {
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
  const load = useCallback(async (nextPlatform: string, nextCursor?: string) => {
    if (nextCursor) setMore(true); else setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams();
      if (nextPlatform) query.set('platform', nextPlatform);
      if (nextCursor) query.set('cursor', nextCursor);
      const page = await client.get<Page>(`/social-posts${query.size ? `?${query}` : ''}`);
      setItems(current => nextCursor ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
      setCanHide(page.can_hide);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '貼文暫時無法載入。'); }
    finally { setLoading(false); setMore(false); }
  }, [client]);
  useEffect(() => { void load(platform); }, [load, platform]);
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
    <details className="social-composer card">
      <summary>分享一則貼文</summary>
      <form onSubmit={event => void submit(event)} aria-busy={saving}>
        <label className="field">連結<input required type="url" inputMode="url" maxLength={2048} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://"/></label>
        <label className="field">標題（選填）<input maxLength={120} value={title} onChange={event => setTitle(event.target.value)}/></label>
        <label className="field">說明（選填）<textarea maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)}/></label>
        <label className="field">縮圖（選填，否則自動抓取）<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0] ?? null)}/></label>
        <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? '正在讀取預覽…' : '分享貼文'}</button>
      </form>
    </details>
    {notice && <p className="banner banner-info" role="status">{notice}</p>}
    {error && <div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={() => void load(platform)}>重試</button></div>}
    <div className="social-filters" role="group" aria-label="平台">
      {FILTERS.map(item => <button key={item.id || 'all'} type="button" className="btn btn-ghost social-filter" aria-pressed={platform === item.id} onClick={() => setPlatform(item.id)}>{item.label}</button>)}
    </div>
    {loading && <p role="status">正在載入貼文…</p>}
    {!loading && items.length === 0 && <p className="empty">這個分類還沒有貼文。</p>}
    <div className="social-grid">
      {items.map(post => <article className="card social-card" key={post.post_id} id={`social-post-${post.post_id}`}>
        <Thumb post={post}/>
        <div className="social-card-body">
          <span className="social-platform-badge" data-platform={tone(post.platform)}>{post.platform_label || PLATFORM_LABELS[post.platform]}</span>
          <h3>{post.title}</h3>
          {post.note && <p className="social-note multiline-text">{post.note}</p>}
          <p className="social-byline"><MemberAvatar nickname={post.author.display_name} avatarUrl={post.author.avatar_url} className="social-avatar"/> <span>{post.author.display_name}</span> <time dateTime={post.created_at}>{formatIsoLocal(post.created_at)}</time></p>
          <p className="social-points">推廣點擊 {post.total_points}</p>
          <div className="social-actions">
            <a className="btn btn-ghost" href={post.url} target="_blank" rel="noopener noreferrer">開啟原文 ↗</a>
            <PromotionShare client={client} kind="social_post" target={post.post_id} title={post.title} label="分享"/>
            {post.mine && <label className="btn btn-ghost social-file">換縮圖<input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} onChange={event => { const next = event.target.files?.[0]; if (next) void upload(post, next); event.target.value = ''; }}/></label>}
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
