import { useEffect, useRef, useState, type FormEvent } from 'react';
import { requireItems, type PortalClient } from '../api';
import { useModuleMutation } from './shared';
import { relationshipLabels } from './SkillUpload';
import './WorkSharing.css';

type Relationship = keyof typeof relationshipLabels;
type Draft = { repository_url: string; title: string; description: string; use_notes: string; demo_url: string; relationship: Relationship };
type Submission = { submission_id: string; status: string; can_edit?: boolean; aggregate_version: number | string; public_path: string | null; seed?: unknown; payload: (Omit<Draft, 'demo_url'> & { demo_url: string | null }) | null };
const blank: Draft = { repository_url: '', title: '', description: '', use_notes: '', demo_url: '', relationship: 'curator' };
const defaultNotes = '請先閱讀原作 README，依其中的安裝步驟開始使用；使用條件與授權以原作文件為準。';
const safePath = (path: string | null) => path && /^\/development\/submissions\/[0-9a-f-]{36}$/.test(path) ? path : null;

export function SimpleSkillSubmission({ client, onPublished, onOpenDraft }: { client: PortalClient; onPublished: () => Promise<void>; onOpenDraft?: (id: string, mode: 'preview' | 'complete') => void }) {
  const [draft, setDraft] = useState<Draft>({ ...blank });
  const [review, setReview] = useState(false), [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState<Submission | null>(null), [published, setPublished] = useState<Submission | null>(null);
  const [ready, setReady] = useState<Submission[]>([]), [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState('');
  const { mutate, busy, error, setError } = useModuleMutation(client);
  const upgrade = useModuleMutation(client);
  const lock = useRef(false), [working, setWorking] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null), success = useRef<HTMLElement>(null);
  async function loadDrafts() {
    setLoadError('');
    try { setReady(requireItems<Submission>(await client.get('/me/skill-submissions'), '投稿草稿').filter(item => item.status === 'ready_for_review' && item.payload && !item.seed)); }
    catch { setLoadError('私人草稿暫時無法載入。'); }
  }
  useEffect(() => { void loadDrafts(); }, [client]);
  useEffect(() => { if (review) previewHeading.current?.focus(); }, [review]);
  useEffect(() => { if (published) success.current?.focus(); }, [published]);
  const pending = busy || working;
  function preview(event: FormEvent) {
    event.preventDefault(); setPublished(null); setError(null); setConsent(false); setReview(true);
  }
  function resume(item: Submission) {
    if (!item.payload) return;
    const payload = item.payload;
    setDraft({ repository_url: payload.repository_url, title: payload.title, description: payload.description, use_notes: payload.use_notes, demo_url: payload.demo_url ?? '', relationship: payload.relationship });
    setSaved(item); setPublished(null); setError(null); setConsent(false); setReview(true);
  }
  async function publish(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !consent) return;
    lock.current = true; setWorking(true);
    try {
      const body = {
        repository_url: draft.repository_url.trim(), relationship: draft.relationship, title: draft.title.trim(), description: draft.description.trim(),
        use_notes: draft.use_notes.trim() || defaultNotes, demo_url: draft.demo_url.trim() || null,
      };
      const changed = saved?.can_edit && saved.payload && Object.entries(body).some(([key, value]) => saved.payload?.[key as keyof Draft] !== value);
      const submission = saved ? changed ? await mutate<Submission>(`/me/skill-submissions/${saved.submission_id}/manual`, body, Number(saved.aggregate_version)) : saved
        : await mutate<Submission>('/me/skill-submissions/manual', body);
      if (!submission) return;
      setSaved(submission);
      const result = await mutate<Submission>(`/me/skill-submissions/${submission.submission_id}/publish`, { consent_to_share: true }, Number(submission.aggregate_version));
      if (!result) return;
      setPublished(result); setReview(false); setSaved(null); setConsent(false); setCopied(''); setDraft({ ...blank });
      void loadDrafts(); await onPublished();
    } finally { lock.current = false; setWorking(false); }
  }
  async function startUpgrade() {
    if (!published) return;
    const draft = await upgrade.mutate<Submission>(`/me/skill-submissions/${published.submission_id}/upgrade`, {});
    if (draft) onOpenDraft?.(draft.submission_id, 'complete');
  }
  async function copyLink() {
    const path = safePath(published?.public_path ?? null);
    if (!path) return;
    try { await navigator.clipboard.writeText(`${window.location.origin}${path}`); setCopied('已複製作品連結。'); }
    catch { setCopied('請開啟作品頁，複製瀏覽器網址即可分享。'); }
  }
  return <section className="card stack work-sharing-form" aria-label="投稿開源工具">
    <ol className="work-sharing-progress" aria-label="投稿進度"><li aria-current={!review && !published ? 'step' : undefined}>1 填寫介紹</li><li aria-current={review ? 'step' : undefined}>2 預覽並公開</li><li aria-current={published ? 'step' : undefined}>3 分享連結</li></ol>
    {published ? <section ref={success} tabIndex={-1} className="work-sharing-success stack" aria-label="投稿完成">
      <h2>你的工具已分享！</h2><p>已加入社群技能書，夥伴可以閱讀與分享。正式收錄由工坊另行審核。</p>
      <p>想讓更多人看懂這個工具？補上 100 則分享介紹和示意圖，就能升級成完整技能書。送出前，現在的版本保持不變。</p>
      <div className="actions">{safePath(published.public_path) && <a className="btn btn-primary" href={published.public_path!} target="_blank" rel="noopener noreferrer">查看作品頁 ↗</a>}<button type="button" className="btn btn-ghost" disabled={upgrade.busy} onClick={() => void startUpgrade()}>補上 100 則分享介紹和示意圖</button><button type="button" className="btn btn-ghost" onClick={() => void copyLink()}>複製作品連結</button><a className="btn btn-ghost" href="#cocreation">找人一起開發</a></div>
      {upgrade.error && <p className="banner banner-error" role="alert">{upgrade.error}</p>}
      {copied && <p role="status">{copied}</p>}<button type="button" className="btn btn-ghost" onClick={() => setPublished(null)}>再投稿一個工具</button>
    </section> : review ? <form className="stack" onSubmit={event => void publish(event)} aria-busy={pending}>
      <h2 ref={previewHeading} tabIndex={-1}>確認這樣分享，好嗎？</h2>
      <h3>{draft.title}</h3><p className="work-sharing-preview">{draft.description}</p>
      <dl className="meta"><div><dt>專案網址</dt><dd className="work-sharing-preview">{draft.repository_url}</dd></div><div><dt>與作品的關係</dt><dd>{relationshipLabels[draft.relationship]}（自行聲明）</dd></div></dl>
      <details><summary>使用說明與展示網址</summary><div className="stack"><p className="work-sharing-preview">{draft.use_notes || defaultNotes}</p>{draft.demo_url && <p className="work-sharing-preview">{draft.demo_url}</p>}</div></details>
      <p className="hint">確認後會公開在網路上，並出現在社群技能書。系統會讀取 GitHub 的公開版本與授權；這是社群投稿，尚未通過正式收錄審核。</p>
      <label className="choice"><input type="checkbox" required checked={consent} disabled={pending} onChange={event => setConsent(event.target.checked)}/>我同意公開這份作品介紹與來源關係</label>
      <div className="actions"><button className="btn btn-primary" disabled={pending || !consent}>{pending ? '正在確認公開來源與授權…' : saved ? '重試公開投稿' : '確認並公開'}</button>{(!saved || saved.can_edit) && <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => { setReview(false); setError(null); }}>修改內容</button>}</div>
      {saved && <p className="hint">已保存私人草稿；公開未完成時，可留在這裡重試，或稍後從下方草稿繼續。</p>}
    </form> : <form className="stack" onSubmit={preview}>
      <div className="section-head"><h2>投稿你的開源工具</h2><p>貼網址、寫一句用途，先預覽再公開。</p></div>
      <label className="field">GitHub 專案網址<input required type="url" maxLength={300} placeholder="https://github.com/你的帳號/專案名稱" value={draft.repository_url} onChange={event => setDraft({ ...draft, repository_url: event.target.value })}/></label>
      <label className="field">作品名稱<input required maxLength={120} placeholder="例如：自動整理會議筆記" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
      <label className="field">一句話介紹<textarea required maxLength={2000} rows={3} placeholder="它能幫誰，解決什麼問題？" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>
      <label className="field">我與作品的關係<select value={draft.relationship} onChange={event => setDraft({ ...draft, relationship: event.target.value as Relationship })}>{Object.entries(relationshipLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><span className="field-hint">推薦別人的工具也可以，原作者與授權都會保留。這是你的聲明，不是作者身分驗證。</span></label>
      <details><summary>補充使用說明與展示網址（選填）</summary><div className="stack"><label className="field">如何開始使用<textarea maxLength={3000} rows={3} placeholder={defaultNotes} value={draft.use_notes} onChange={event => setDraft({ ...draft, use_notes: event.target.value })}/></label><label className="field">展示網址（選填）<input type="url" maxLength={2000} placeholder="https://…" value={draft.demo_url} onChange={event => setDraft({ ...draft, demo_url: event.target.value })}/></label></div></details>
      <p className="hint">不會直接公開；下一步可檢查或修改內容。</p><div className="actions"><button className="btn btn-primary">預覽投稿</button></div>
    </form>}
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {loadError && <p role="alert">{loadError} <button type="button" className="btn btn-ghost" onClick={() => void loadDrafts()}>重新載入草稿</button></p>}
    {ready.length > 0 && !review && <details className="work-sharing-advanced"><summary>繼續未公開的草稿（{ready.length}）</summary><div className="stack">{ready.map(item => <div className="actions" key={item.submission_id}><span>{item.payload?.title}</span><button className="btn btn-ghost" type="button" onClick={() => resume(item)}>繼續投稿：{item.payload?.title}</button></div>)}</div></details>}
  </section>;
}
