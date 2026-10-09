import {ReportButton} from './MemberReporting';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {ApiError, type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import type {SocialPost} from './SocialZone';

type Comment = {comment_id: string; body: string; created_at: string; author: {user_id: string; display_name: string}; mine: boolean};
type Comments = {items: Comment[]; next_cursor: string | null};
function mergeComments(current: Comment[], incoming: Comment[]) {
  const all = new Map([...current, ...incoming].map(item => [item.comment_id, item]));
  return [...all.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.comment_id.localeCompare(b.comment_id));
}

export function SocialInteractions({client, post, canHide, onUpdate}: {client: PortalClient; post: SocialPost; canHide: boolean; onUpdate: (value: Partial<SocialPost>) => void}) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [liking, setLiking] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const pendingComment = useRef<{text: string; key: string} | null>(null);
  const pendingLike = useRef<{liked: boolean; key: string} | null>(null);
  const confirmedComments = useRef<Comment[]>([]);
  const sequence = useRef(0);
  useEffect(() => () => { ++sequence.current; }, []);
  async function load(next?: string) {
    const token = ++sequence.current;
    setLoading(true); setError('');
    try {
      const page = await client.get<Comments>(`/social-posts/${post.post_id}/comments${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      if (token !== sequence.current) return;
      const fresh = confirmedComments.current.filter(comment => !page.items.some(item => item.comment_id === comment.comment_id));
      setComments(current => mergeComments(next ? current : fresh, page.items)); setCursor(page.next_cursor);
      confirmedComments.current = fresh;
    } catch (cause) { if (token === sequence.current) setError(cause instanceof Error ? cause.message : '留言暫時無法載入。'); }
    finally { if (token === sequence.current) setLoading(false); }
  }
  async function like() {
    if (liking) return;
    const command = pendingLike.current ?? {liked: !post.liked, key: crypto.randomUUID()};
    pendingLike.current = command; setLiking(true); setError('');
    try {
      const value = await client.post<{liked: boolean; like_count: number}>(`/social-posts/${post.post_id}/like`, {liked: command.liked}, {idempotencyKey: command.key});
      onUpdate(value); pendingLike.current = null;
    } catch (cause) {
      if (cause instanceof ApiError && !cause.network) pendingLike.current = null;
      setError(cause instanceof Error ? cause.message : '尚未確認按讚結果，請重試。');
    } finally { setLiking(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    const command = pendingComment.current ?? {text: text.trim(), key: crypto.randomUUID()};
    if (!command.text) return;
    pendingComment.current = command; setSending(true); setError('');
    try {
      const created = await client.post<Comment>(`/social-posts/${post.post_id}/comments`, {text: command.text}, {idempotencyKey: command.key});
      // A comment acknowledgement does not cancel a pending read or its cursor.
      // Retain newly confirmed comments until a server page includes them.
      confirmedComments.current = mergeComments(confirmedComments.current, [created]);
      setComments(current => mergeComments(current, [created]));
      if (!comments.some(item => item.comment_id === created.comment_id)) onUpdate({comment_count: (post.comment_count ?? 0) + 1});
      pendingComment.current = null; setText('');
    } catch (cause) {
      if (cause instanceof ApiError && !cause.network) pendingComment.current = null;
      setError(cause instanceof Error ? cause.message : '尚未確認留言結果，請重試。');
    } finally { setSending(false); }
  }
  async function remove(comment: Comment) {
    if (sending) return;
    setSending(true); setError('');
    try {
      await client.delete(`/social-posts/${post.post_id}/comments/${comment.comment_id}`, {});
      confirmedComments.current = confirmedComments.current.filter(item => item.comment_id !== comment.comment_id);
      setComments(current => current.filter(item => item.comment_id !== comment.comment_id));
      onUpdate({comment_count: Math.max(0, (post.comment_count ?? 0) - 1)}); setConfirmDelete(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '留言未能刪除。'); }
    finally { setSending(false); }
  }
  return <div className="social-interactions stack">
    <div className="social-actions">
      <button type="button" className="btn btn-ghost" aria-pressed={post.liked ?? false} disabled={liking} onClick={() => void like()}>{liking ? '處理中…' : pendingLike.current ? '重試按讚' : post.liked ? '已讚' : '讚'} · {post.like_count ?? 0}</button>
      <button type="button" className="btn btn-ghost" aria-expanded={open} aria-controls={`social-comments-${post.post_id}`} onClick={() => { setOpen(!open); if (!open) void load(); else { ++sequence.current; setLoading(false); } }}>留言 · {post.comment_count ?? 0}</button>
      <ReportButton kind="post" id={post.post_id} label="貼文"/>
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {open && <section id={`social-comments-${post.post_id}`} className="social-comments stack" aria-label="貼文留言">
      {loading && <p role="status">正在載入留言…</p>}
      {!loading && comments.length === 0 && <p className="muted">還沒有留言，聊聊你的想法。</p>}
      {comments.map(comment => <article className="social-comment" key={comment.comment_id}>
        <div className="social-comment-meta"><strong>{comment.author.display_name}</strong><time dateTime={comment.created_at}>{formatIsoLocal(comment.created_at)}</time></div>
        <p className="multiline-text">{comment.body}</p>
        <ReportButton kind="comment" id={comment.comment_id} label="留言"/>
        {(comment.mine || canHide) && <div className="social-actions">{confirmDelete === comment.comment_id ? <>
          <button type="button" className="btn btn-ghost" disabled={sending} onClick={() => void remove(comment)}>確定刪除留言</button><button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>取消</button>
        </> : <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(comment.comment_id)}>刪除留言</button>}</div>}
      </article>)}
      {cursor && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load(cursor)}>載入更多留言</button>}
      {error && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load()}>重新載入留言</button>}
      <form className="stack" onSubmit={event => void send(event)} aria-busy={sending}>
        <label className="field">寫留言<textarea aria-label="寫留言" required rows={2} maxLength={1000} value={text} disabled={sending || !!pendingComment.current} onChange={event => setText(event.target.value)} placeholder="留下你的想法…"/></label>
        <button className="btn btn-ghost" disabled={sending || !text.trim()}>{sending ? '傳送中…' : pendingComment.current ? '重試留言' : '送出留言'}</button>
      </form>
    </section>}
  </div>;
}
