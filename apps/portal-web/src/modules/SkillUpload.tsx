import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { requireItems, type PortalClient } from '../api';
import { formatIsoLocal } from '../format';
import { useModuleMutation } from './shared';
import './SkillUpload.css';

type Relationship = 'author' | 'maintainer' | 'contributor' | 'curator';
type SubmissionPayload = { repository_url: string; title: string; description: string; use_notes: string; demo_url: string | null; relationship: Relationship; share_introductions: string[] };
type Submission = { submission_id: string; status: 'awaiting_upload' | 'ready_for_review' | 'published' | 'revoked'; aggregate_version: string | number; payload: SubmissionPayload | null; project_id: string | null; public_path: string | null; illustration_url: string | null; grant_expires_at: string | null; grant_consumed_at: string | null; grant_revoked_at: string | null; created_at: string; updated_at: string };
type UploadGrant = { token: string; expires_at: string; submit_url: string };
type GrantResult = { submission: Submission; upload_grant?: UploadGrant | null };
type UploadKey = { key_id: string; label: string; scope: 'skill:submit'; expires_at: string; revoked_at: string | null };
type Secret = { submissionId: string; token: string; expiresAt: string; submitUrl: string };

const statusLabels: Record<Submission['status'], string> = { awaiting_upload: '等待 Agent 上傳', ready_for_review: '待你預覽送出', published: '已送出', revoked: '已撤銷' };
const relationshipLabels: Record<Relationship, string> = { author: '原作者', maintainer: '維護者', contributor: '貢獻者', curator: '推薦／整理者' };
const GUIDE = '/development/skill-upload';

function httpsLink(value: string | null | undefined) {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function localPath(value: string | null) {
  return value && /^\/(?!\/)[^\s\\]*$/.test(value) ? value : null;
}
// The token may only travel to this site's agent endpoint; anything else is dropped before display.
function sameOriginSubmitUrl(value: string) {
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && !url.username && !url.password && /^\/agent-api\/v1\/skill-submissions\/[^/]+$/.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
function isExpired(iso: string) { const time = Date.parse(iso); return !Number.isFinite(time) || time <= Date.now(); }

export function agentInstruction(origin: string, secret: Secret) {
  return `# 自由工坊 · 技能上傳（私人指令，請勿轉傳）
先閱讀公開指南：${origin}${GUIDE}/SKILL.md（完整欄位規格與插圖格式以指南為準）。

任務：讀取「目前工作目錄」這個 repository 的 README、LICENSE 與程式碼，依實際內容以繁體中文撰寫：
1. title：技能名稱。
2. description：真實介紹，只寫專案確實具備的功能與授權。
3. use_notes：適合誰、需要什麼、第一個使用步驟與限制。
4. share_introductions：剛好 100 則彼此不同的分享短文，每則 8–200 字，不重複、不誇大。
5. 插圖（選填）：只依公開指南的格式提供；無法確認格式就省略 cover_image。

規則：
- relationship 預設 curator（推薦／整理者）；只有我明確聲明是原作者、維護者或貢獻者，才改為 author／maintainer／contributor。這是本人自行聲明，不是身分驗證。
- 不捏造使用人數、成效、官方身分或授權；不確定就寫「尚未確認」。
- 不讀取專案中的 .env、cookie、私鑰或客戶資料，不附上其他憑證；只用下方 Authorization 標頭，不使用任何瀏覽器 cookie。
- 本指令只交給我選擇的 Agent，不轉傳、不寫入 Repo、shell history 或日誌。憑證只能用於下方上傳端點。
- 這只會上傳私人草稿；是否公開由我本人在自由工坊預覽後決定。

POST ${secret.submitUrl}
Authorization: Bearer ${secret.token}
Content-Type: application/json
（一次性憑證，只能上傳這份草稿，${formatIsoLocal(secret.expiresAt)} 到期）

{
  "repository_url": "https://github.com/<owner>/<repository>",
  "title": "技能名稱",
  "description": "真實介紹",
  "use_notes": "如何開始使用與限制",
  "demo_url": null,
  "relationship": "curator",
  "share_introductions": ["第 1 則分享短文", "第 2 則分享短文", "……共 100 則，彼此不同"]
}
`;
}

function CopySecret({ label, value, hint }: { label: string; value: string; hint: string }) {
  const [copied, setCopied] = useState(''), field = useRef<HTMLTextAreaElement>(null), id = useId();
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied('已複製，只貼給你選擇的 Agent。'); }
    catch { field.current?.select(); setCopied('無法自動複製，已選取內容，請手動複製。'); }
  }
  return <div className="skill-upload-secret">
    <label className="field" htmlFor={id}>{label}</label>
    <textarea id={id} ref={field} readOnly rows={8} value={value} spellCheck={false} autoComplete="off" data-private="true" aria-describedby={`${id}-hint`}/>
    <p className="field-hint" id={`${id}-hint`}>{hint}</p>
    <div className="actions"><button type="button" className="btn btn-primary" onClick={() => void copy()}>複製</button>{copied && <span role="status" className="field-hint">{copied}</span>}</div>
  </div>;
}

function SubmissionPreview({ submission, busy, onPublish }: { submission: Submission; busy: boolean; onPublish: () => void }) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => { region.current?.focus(); }, [submission.submission_id]);
  const payload = submission.payload;
  if (!payload) return <p className="field-hint">Agent 尚未上傳內容。</p>;
  const repository = httpsLink(payload.repository_url), demo = httpsLink(payload.demo_url), blurbs = payload.share_introductions ?? [];
  const illustration = localPath(submission.illustration_url);
  return <section ref={region} tabIndex={-1} className="skill-upload-preview stack" aria-label={`預覽：${payload.title}`}>
    <h4>{payload.title}</h4>
    {illustration && <img className="skill-upload-illustration" src={illustration} alt={`${payload.title}的投稿插圖`}/>}
    <p className="skill-upload-copy">{payload.description}</p>
    <div className="help-box"><strong>如何開始</strong><p className="skill-upload-copy">{payload.use_notes}</p></div>
    <dl className="meta">
      <div><dt>來源關係</dt><dd>{relationshipLabels[payload.relationship] ?? payload.relationship}（自行聲明）</dd></div>
      <div><dt>專案</dt><dd>{repository ? <a href={repository} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{payload.repository_url} ↗</a> : `${payload.repository_url}（網址無效，不提供連結）`}</dd></div>
      {payload.demo_url && <div><dt>展示</dt><dd>{demo ? <a href={demo} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{payload.demo_url} ↗</a> : '網址無效，不提供連結'}</dd></div>}
    </dl>
    <details className="skill-upload-blurbs"><summary>分享短文 {blurbs.length} 則</summary><ol>{blurbs.map((text, index) => <li key={index}>{text}</li>)}</ol></details>
    {submission.status === 'ready_for_review' && <>
      <p className="field-hint">送出後，介紹、示意圖與分享短文會公開在網路上。此投稿列為社群候選作品；正式收錄另由工坊審核。</p>
      <div className="actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={onPublish}>送出技能</button></div>
    </>}
  </section>;
}

export function SkillUpload({ client, onPublished }: { client: PortalClient; onPublished?: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false), dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), titleId = useId();
  const dialogSession = useRef(0), dialogActive = useRef(false);
  const [items, setItems] = useState<Submission[]>([]), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null), [issue, setIssue] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<Submission | null>(null), [previewError, setPreviewError] = useState<string | null>(null);
  const [keys, setKeys] = useState<UploadKey[]>([]), [keysError, setKeysError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState({ label: '', expires_in_days: '30' }), [issuedKey, setIssuedKey] = useState<{ id: string; label: string; token: string } | null>(null);
  const drafts = useModuleMutation(client), credentials = useModuleMutation(client);

  const refresh = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const loaded = requireItems<Submission>(await client.get('/me/skill-submissions'), '技能草稿');
      setItems(loaded);
      setSecret(current => {
        const draft = loaded.find(item => item.submission_id === current?.submissionId);
        return draft && (draft.status !== 'awaiting_upload' || draft.grant_consumed_at || draft.grant_revoked_at || (draft.grant_expires_at && isExpired(draft.grant_expires_at))) ? null : current;
      });
    }
    catch (cause) { setLoadError(cause instanceof Error ? cause.message : '無法載入技能草稿。'); }
    finally { setLoading(false); }
  }, [client]);
  const refreshKeys = useCallback(async () => {
    setKeysError(null);
    try { setKeys(requireItems<UploadKey>(await client.get('/me/skill-upload-keys'), '上傳金鑰')); }
    catch (cause) { setKeysError(cause instanceof Error ? cause.message : '無法載入上傳金鑰。'); }
  }, [client]);

  useEffect(() => {
    if (!open) return;
    if (!dialog.current?.open) dialog.current?.showModal();
    void refresh(); void refreshKeys();
  }, [open, refresh, refreshKeys]);
  // Drop an expired one-time grant instead of leaving a dead credential on screen.
  useEffect(() => {
    if (!secret) return;
    const timer = window.setInterval(() => { if (isExpired(secret.expiresAt)) { setSecret(null); setIssue('一次性上傳憑證已過期，請為草稿重新產生指令。'); } }, 15_000);
    return () => window.clearInterval(timer);
  }, [secret]);

  // Secrets live only in this component's state and are discarded whenever the dialog closes.
  function closed() {
    dialogSession.current += 1; dialogActive.current = false;
    setSecret(null); setIssuedKey(null); setIssue(null); setNotice(null); setPreview(null); setPreviewError(null);
    setOpen(false); trigger.current?.focus();
  }
  function show() { dialogSession.current += 1; dialogActive.current = true; setOpen(true); }
  function sessionActive(session: number) { return dialogActive.current && dialog.current?.open === true && dialogSession.current === session; }
  function close() { if (dialog.current?.open) dialog.current.close(); else closed(); }
  function acceptGrant(result: GrantResult | undefined) {
    if (!result) return;
    setItems(current => [result.submission, ...current.filter(item => item.submission_id !== result.submission.submission_id)]);
    const grant = result.upload_grant, submitUrl = grant ? sameOriginSubmitUrl(grant.submit_url) : null;
    if (!grant) { setSecret(null); setIssue('草稿已建立，但憑證只在第一次回應顯示。請在下方草稿按「重新產生指令」。'); return; }
    if (!submitUrl) { setSecret(null); setIssue('上傳網址不是本站位址，已停止顯示憑證。請重新產生指令。'); return; }
    if (isExpired(grant.expires_at)) { setSecret(null); setIssue('一次性上傳憑證已過期，請為草稿重新產生指令。'); return; }
    setIssue(null); setSecret({ submissionId: result.submission.submission_id, token: grant.token, expiresAt: grant.expires_at, submitUrl });
  }
  async function createDraft() {
    setNotice(null); setIssue(null);
    const session = dialogSession.current;
    const result = await drafts.mutate<GrantResult>('/me/skill-submissions', {});
    if (sessionActive(session)) acceptGrant(result);
  }
  async function regrant(item: Submission) {
    setNotice(null); setIssue(null);
    const session = dialogSession.current;
    const result = await drafts.mutate<GrantResult>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}/grant`, {}, Number(item.aggregate_version));
    if (sessionActive(session)) acceptGrant(result);
  }
  async function revoke(item: Submission) {
    const saved = await drafts.mutate<Submission>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}/revoke`, {}, Number(item.aggregate_version));
    if (!saved) return;
    if (secret?.submissionId === item.submission_id) setSecret(null);
    if (preview?.submission_id === item.submission_id) setPreview(null);
    setNotice('草稿已撤銷，憑證無法再上傳。'); await refresh();
  }
  async function showPreview(item: Submission) {
    setPreviewError(null); setPreview(null);
    const session = dialogSession.current;
    try { const loaded = await client.get<Submission>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}`); if (sessionActive(session)) setPreview(loaded); }
    catch (cause) { if (sessionActive(session)) setPreviewError(cause instanceof Error ? cause.message : '無法載入草稿內容。'); }
  }
  async function publish(item: Submission) {
    const saved = await drafts.mutate<Submission>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}/publish`, { consent_to_share: true }, Number(item.aggregate_version));
    if (!saved) return;
    setPreview(saved); setNotice('技能已送出，公開介紹頁已建立。'); await refresh(); await onPublished?.();
  }
  async function issueKey(event: FormEvent) {
    event.preventDefault(); setIssuedKey(null);
    const session = dialogSession.current;
    const result = await credentials.mutate<{ key: UploadKey; token?: string | null }>('/me/skill-upload-keys', { label: keyDraft.label.trim(), expires_in_days: Number(keyDraft.expires_in_days) });
    if (!result || !sessionActive(session)) return;
    if (result.token) { setIssuedKey({ id: result.key.key_id, label: result.key.label, token: result.token }); setKeyDraft({ label: '', expires_in_days: '30' }); }
    else credentials.setError('金鑰已建立，但只在第一次回應顯示。請撤銷這把金鑰後重新建立。');
    await refreshKeys();
  }
  async function revokeKey(key: UploadKey) {
    const result = await credentials.mutate<UploadKey>(`/me/skill-upload-keys/${encodeURIComponent(key.key_id)}/revoke`, {});
    if (result) { setIssuedKey(current => current?.id === key.key_id ? null : current); await Promise.all([refreshKeys(), refresh()]); }
  }

  const instruction = secret ? agentInstruction(window.location.origin, secret) : '';
  return <>
    <button ref={trigger} type="button" className="btn btn-primary skill-upload-trigger" aria-haspopup="dialog" onClick={show}>上傳技能</button>
    <dialog ref={dialog} className="skill-upload-dialog" aria-labelledby={titleId} onCancel={event => { if (event.target === event.currentTarget) { event.preventDefault(); close(); } }} onClose={event => { if (event.target === event.currentTarget) closed(); }}>
      {open && <div className="stack">
        <header className="skill-upload-header"><div><p className="eyebrow">自由工坊 · 技能上傳</p><h2 id={titleId}>上傳技能</h2></div><button type="button" className="btn btn-ghost" onClick={close} aria-label="關閉上傳技能">關閉</button></header>

        <section className="stack" aria-labelledby={`${titleId}-agent`}>
          <h3 id={`${titleId}-agent`}>交給 Agent 讀取專案</h3>
          <p className="field-hint">私人指令含 60 分鐘內有效的一次性憑證，只能上傳一份草稿；只貼給你自己選擇的 Agent，平台不會自動傳給第三方。</p>
          <div className="actions"><button type="button" className="btn btn-primary" disabled={drafts.busy} onClick={() => void createDraft()}>{drafts.busy ? '處理中…' : '產生私人上傳指令'}</button><a href={`${GUIDE}/SKILL.md`} target="_blank" rel="noopener noreferrer">公開指南 ↗</a></div>
          {issue && <p role="alert" className="banner banner-error">{issue}</p>}
          {drafts.error && <p role="alert" className="banner banner-error">{drafts.error}</p>}
          {notice && <p role="status" className="status-note">{notice}</p>}
          {secret && <CopySecret label="私人上傳指令" value={instruction} hint={`憑證 ${formatIsoLocal(secret.expiresAt)} 到期，只顯示在此視窗；關閉後即移除。`}/>}
        </section>

        <section className="stack" aria-labelledby={`${titleId}-drafts`}>
          <div className="skill-upload-row"><h3 id={`${titleId}-drafts`}>我的技能草稿</h3><button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void refresh()}>重新整理草稿</button></div>
          {loadError && <p role="alert" className="banner banner-error">{loadError}</p>}
          {loading && <p role="status">正在載入草稿…</p>}
          {!loading && !loadError && items.length === 0 && <p className="field-hint">還沒有草稿。</p>}
          <ul className="skill-upload-list">{items.map(item => {
            const path = localPath(item.public_path), name = item.payload?.title ?? formatIsoLocal(item.created_at);
            return <li key={item.submission_id} className="skill-upload-item" data-status={item.status}>
              <div className="skill-upload-item-copy"><strong>{item.payload?.title ?? '尚未上傳內容'}</strong><span className="field-hint">{item.status === 'awaiting_upload' && item.grant_revoked_at ? '上傳憑證已撤銷' : item.status === 'awaiting_upload' && item.grant_expires_at && isExpired(item.grant_expires_at) ? '上傳憑證已過期' : statusLabels[item.status]} · {item.payload?.repository_url ?? formatIsoLocal(item.created_at)}</span></div>
              <div className="actions">
                {item.status === 'awaiting_upload' && <button type="button" className="btn btn-ghost" disabled={drafts.busy} aria-label={`重新產生指令：${name}`} onClick={() => void regrant(item)}>重新產生指令</button>}
                {item.payload && <button type="button" className="btn btn-ghost" aria-label={`預覽：${name}`} onClick={() => void showPreview(item)}>預覽</button>}
                {(item.status === 'awaiting_upload' || item.status === 'ready_for_review') && <button type="button" className="btn btn-ghost" disabled={drafts.busy} aria-label={`撤銷草稿：${name}`} onClick={() => void revoke(item)}>撤銷</button>}
                {item.status === 'published' && path && <a href={path} target="_blank" rel="noopener noreferrer">查看 ↗</a>}
              </div>
            </li>;
          })}</ul>
          {previewError && <p role="alert" className="banner banner-error">{previewError}</p>}
          {preview && <SubmissionPreview submission={preview} busy={drafts.busy} onPublish={() => void publish(preview)}/>}
        </section>

        <details className="skill-upload-cli">
          <summary>安裝上傳工具與長期金鑰</summary>
          <div className="stack">
            <div className="actions"><a className="btn btn-ghost" href="/downloads/freedom-skill-client.tgz" download>下載上傳工具</a><a href={GUIDE} target="_blank" rel="noopener noreferrer">安裝說明 ↗</a></div>
            <pre className="skill-upload-command"><code>{`npm install -g ${window.location.origin}/downloads/freedom-skill-client.tgz`}</code></pre>
            <p className="field-hint">金鑰只能建立並上傳你自己的技能草稿；不能送出公開、不能修改帳號，也不是通用 Agent 授權。最長 90 天。</p>
            <form className="skill-upload-key-form" onSubmit={issueKey}>
              <label className="field">金鑰名稱<input required maxLength={80} value={keyDraft.label} placeholder="例如：我的筆電" onChange={event => setKeyDraft({ ...keyDraft, label: event.target.value })}/></label>
              <label className="field">有效天數<input required type="number" min={1} max={90} value={keyDraft.expires_in_days} onChange={event => setKeyDraft({ ...keyDraft, expires_in_days: event.target.value })}/></label>
              <button className="btn btn-primary" disabled={credentials.busy}>建立金鑰</button>
            </form>
            {credentials.error && <p role="alert" className="banner banner-error">{credentials.error}</p>}
            {issuedKey && <CopySecret label={`金鑰：${issuedKey.label}`} value={issuedKey.token} hint="只顯示這一次；關閉視窗後無法再查看，遺失請撤銷後重建。"/>}
            {keysError && <p role="alert" className="banner banner-error">{keysError} <button type="button" className="btn btn-ghost" onClick={() => void refreshKeys()}>重新載入</button></p>}
            <ul className="skill-upload-list" aria-label="已建立的金鑰">{keys.map(key => <li key={key.key_id} className="skill-upload-item">
              <div className="skill-upload-item-copy"><strong>{key.label}</strong><span className="field-hint">{key.revoked_at ? `已撤銷 · ${formatIsoLocal(key.revoked_at)}` : isExpired(key.expires_at) ? `已過期 · ${formatIsoLocal(key.expires_at)}` : `${formatIsoLocal(key.expires_at)} 到期`}</span></div>
              {!key.revoked_at && !isExpired(key.expires_at) && <button type="button" className="btn btn-ghost" disabled={credentials.busy} aria-label={`撤銷金鑰：${key.label}`} onClick={() => void revokeKey(key)}>撤銷金鑰</button>}
            </li>)}</ul>
          </div>
        </details>
      </div>}
    </dialog>
  </>;
}
