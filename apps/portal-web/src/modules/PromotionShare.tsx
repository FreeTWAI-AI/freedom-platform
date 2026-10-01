import {useEffect, useId, useRef, useState} from 'react';
import {ApiError, type PortalClient} from '../api';
import './SkillDiscovery.css';

type LinkView = {path: string; points: {week: number; all: number}};

export function PromotionShare({client, kind, target, title, text, label = '分享'}: {
  client: PortalClient; kind: 'platform' | 'social_post' | 'skill_book' | 'event'; target: string; title: string; text?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<LinkView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState(false);
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const manualField = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open && dialog.current?.open) dialog.current?.close(); }, [open]);
  useEffect(() => { if (manual && open) { manualField.current?.focus(); manualField.current?.select(); } }, [manual, open]);
  const url = link ? `${window.location.origin}${link.path}` : '';
  const copyText = text ? `${text}\n${url}` : url;
  function close() { generation.current++; setOpen(false); setStatus(''); setManual(false); dialog.current?.close(); trigger.current?.focus(); }
  async function load(run: number) {
    setBusy(true); setError(''); setStatus(''); setManual(false);
    try {
      const result = await client.post<LinkView>('/promotion/links', {kind, target});
      if (run === generation.current) setLink(result);
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : '分享連結暫時無法建立。');
    } finally { if (run === generation.current) setBusy(false); }
  }
  function openDialog() { const run = ++generation.current; setOpen(true); setLink(null); void load(run); }
  async function copy() {
    const run = generation.current;
    if (!navigator.clipboard?.writeText) { setManual(true); setStatus('無法自動複製，請選取並複製下方內容'); return; }
    try { await navigator.clipboard.writeText(copyText); if (run === generation.current) setStatus('已複製連結'); }
    catch { if (run === generation.current) { setManual(true); setStatus('無法自動複製，請選取並複製下方內容'); } }
  }
  async function send() {
    const run = generation.current; setStatus(''); setManual(false); setBusy(true);
    try {
      if (typeof navigator.share === 'function') {
        try { await navigator.share(text ? {title, text, url} : {title, url}); if (run === generation.current) setStatus('分享已送出'); }
        catch (cause) { if (run !== generation.current || (cause as {name?: string} | null)?.name === 'AbortError') return; setManual(true); setStatus('系統分享沒有完成，請選取並複製下方內容'); }
        return;
      }
      await copy();
    } finally { if (run === generation.current) setBusy(false); }
  }
  return <div className="skill-share promotion-share">
    <button ref={trigger} type="button" className="btn btn-ghost" aria-haspopup="dialog" onClick={openDialog}>{label}</button>
    <dialog ref={dialog} className="skill-share-dialog promotion-share-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }} onClose={() => setOpen(false)}>
      {open && <div>
        <header className="skill-share-head"><h2 id={`${id}-title`}>分享「{title}」</h2><button type="button" className="btn btn-ghost" onClick={close} aria-label="關閉分享">關閉</button></header>
        {text && <p className="skill-share-text">{text}</p>}
        {error && <div className="skill-share-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void load(++generation.current)}>{busy ? '正在重試…' : '重試'}</button></div>}
        <p className="skill-share-url">{link ? url : busy ? '正在準備分享連結…' : ''}</p>
        {link && <p className="promotion-share-points">這個連結：本週 {link.points.week} 分・累計 {link.points.all} 分</p>}
        <div className="skill-share-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !link} onClick={() => void send()}>分享</button>
          <button type="button" className="btn btn-ghost" disabled={busy || !link} onClick={() => void copy()}>複製連結</button>
        </div>
        <p className="promotion-share-rule">訪客每天點開算 1 分，自己點不算。</p>
        {status && <p className="skill-share-status" role="status">{status}</p>}
        {manual && <div className="field"><label htmlFor={`${id}-manual`}>手動複製分享內容</label><textarea ref={manualField} id={`${id}-manual`} value={copyText} readOnly rows={3} onFocus={event => event.currentTarget.select()}/></div>}
      </div>}
    </dialog>
  </div>;
}

export function ApiMessage(error: unknown, fallback: string) {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}
