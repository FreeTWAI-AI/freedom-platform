import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {ApiError, type PortalClient} from '../api';
import type {SocialPost} from './SocialZone';

/** Author-only text edit. A link keeps its URL and thumbnail; If-Match is the post revision. */
export function SocialPostEditor({client, post, onClose, onSaved}: {client: PortalClient; post: SocialPost | null; onClose: () => void; onSaved: (post: SocialPost) => void}) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [text, setText] = useState(''), [title, setTitle] = useState(''), [note, setNote] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (post) {
      setText(post.note ?? ''); setTitle(post.title); setNote(post.note ?? ''); setError('');
      if (!element.open) element.showModal();
    } else if (element.open) element.close();
  }, [post]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!post || saving) return;
    setSaving(true); setError('');
    try {
      const body = post.kind === 'note' ? {text: text.trim()} : {title: title.trim(), note: note.trim() || null};
      const saved = await client.post<SocialPost>(`/social-posts/${post.post_id}/edit`, body, {ifMatch: post.revision});
      onSaved(saved); onClose();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 412 ? '這則貼文已在別處更新，請重新整理動態後再編輯。' : cause instanceof Error ? cause.message : '貼文未能更新。');
    } finally { setSaving(false); }
  }
  const unchanged = post ? post.kind === 'note' ? text.trim() === (post.note ?? '') : title.trim() === post.title && (note.trim() || null) === post.note : true;
  return <dialog ref={dialog} className="social-publish-dialog social-edit-dialog" aria-labelledby={`${id}-title`} onCancel={event => {event.preventDefault(); if (!saving) onClose();}} onClose={() => { if (post) onClose(); }}>
    {post && <form className="stack" onSubmit={event => void save(event)} aria-busy={saving}>
      <header className="social-publish-head"><h2 id={`${id}-title`}>編輯貼文</h2><button type="button" className="btn btn-ghost" aria-label="關閉編輯" disabled={saving} onClick={onClose}>關閉</button></header>
      {post.kind === 'note' ? <>
        <label className="field"><span className="sr-only">貼文內容</span><textarea aria-label="貼文內容" autoFocus required rows={6} maxLength={2000} value={text} disabled={saving} onChange={event => setText(event.target.value)}/></label>
        <p className="muted">{text.length}/2000 · 圖片、讚與留言都會保留。</p>
      </> : <>
        <p className="muted">連結：{post.url}（網址與縮圖不變）</p>
        <label className="field">標題<input autoFocus required maxLength={120} value={title} disabled={saving} onChange={event => setTitle(event.target.value)}/></label>
        <label className="field">說明（選填）<textarea maxLength={500} rows={3} value={note} disabled={saving} onChange={event => setNote(event.target.value)}/></label>
      </>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <div className="social-edit-actions"><button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>取消</button><button className="btn btn-primary" disabled={saving || unchanged || (post.kind === 'note' ? !text.trim() : !title.trim())}>{saving ? '儲存中…' : '儲存變更'}</button></div>
    </form>}
  </dialog>;
}
