import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { requireItems, type PortalClient } from '../api';
import { formatIsoLocal } from '../format';
import { logConsoleEvent } from '../game-console-core';
import { consoleChannel } from '../game-console-routing';
import { useModuleMutation } from './shared';
import { CHAT_JSON_MAX_BYTES, chatSkillInstruction, parseChatSkillJson, repositoryKey, seedCopyBlock, type ChatSkillSeed } from './skill-upload-chat';
import './SkillUpload.css';

type Relationship = 'author' | 'maintainer' | 'contributor' | 'curator';
type SubmissionPayload = { repository_url: string; title: string; description: string; use_notes: string; demo_url: string | null; relationship: Relationship; share_introductions: string[] };
type Seed = ChatSkillSeed & { repository_url: string };
type CatalogBookRef = { book_id: string; title: string; public_path: string };
type Submission = { submission_id: string; status: 'awaiting_upload' | 'ready_for_review' | 'published' | 'revoked'; aggregate_version: string | number; payload: SubmissionPayload | null; project_id: string | null; public_path: string | null; illustration_url: string | null; grant_expires_at: string | null; grant_consumed_at: string | null; grant_revoked_at: string | null; created_at: string; updated_at: string; seed?: Seed | null; upgrades_submission_id?: string | null; catalog_book?: CatalogBookRef | null };
export type SkillOpenRequest = { submissionId: string; mode: 'preview' | 'complete'; nonce: number };
type UploadGrant = { token: string; expires_at: string; submit_url: string };
type GrantResult = { submission: Submission; upload_grant?: UploadGrant | null };
type UploadKey = { key_id: string; label: string; scope: 'skill:submit'; expires_at: string; revoked_at: string | null };
type Secret = { submissionId: string; token: string; expiresAt: string; submitUrl: string; seed: Seed | null };
type HeldGrant = { id: string; token: string; submitUrl: string; version: number };

const statusLabels: Record<Submission['status'], string> = { awaiting_upload: '等待 Agent 上傳', ready_for_review: '待你預覽送出', published: '已送出', revoked: '已撤銷' };
export const relationshipLabels: Record<Relationship, string> = { author: '原作者', maintainer: '維護者', contributor: '貢獻者', curator: '推薦／整理者' };
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
function draftsLeadList(list: { status: string; seed?: unknown }[]) {
  return list.some(item => item.status === 'ready_for_review' || (item.status === 'awaiting_upload' && Boolean(item.seed)));
}
function plainGrantUsable(item: Submission) {
  return item.status === 'awaiting_upload' && !item.seed && !item.grant_revoked_at && !(item.grant_expires_at && isExpired(item.grant_expires_at));
}

export function agentInstruction(origin: string, secret: Secret, seed?: ChatSkillSeed | null) {
  const copied = seed ? `${seedCopyBlock(seed)}\n\n` : '';
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

${copied}POST ${secret.submitUrl}
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

function CopySecret({ label, value, hint, rootRef, copyButtonRef }: { label: string; value: string; hint: string; rootRef?: Ref<HTMLDivElement>; copyButtonRef?: Ref<HTMLButtonElement> }) {
  const [copied, setCopied] = useState(''), field = useRef<HTMLTextAreaElement>(null), id = useId();
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied('已複製，只貼給你選擇的 Agent。'); }
    catch { field.current?.select(); setCopied('無法自動複製，已選取內容，請手動複製。'); }
  }
  return <div className="skill-upload-secret" ref={rootRef}>
    <label className="field" htmlFor={id}>{label}</label>
    <textarea id={id} ref={field} readOnly rows={8} value={value} spellCheck={false} autoComplete="off" data-private="true" aria-describedby={`${id}-hint`}/>
    <p className="field-hint" id={`${id}-hint`}>{hint}</p>
    <div className="actions"><button ref={copyButtonRef} type="button" className="btn btn-primary" onClick={() => void copy()}>複製</button>{copied && <span role="status" className="field-hint">{copied}</span>}</div>
  </div>;
}

function bringDialogNoteIntoView(note: HTMLElement) {
  const dialogNode = note.closest('dialog');
  const header = dialogNode?.querySelector<HTMLElement>('.skill-upload-header');
  // The sticky header covers the scrollport's top edge, which nearest would otherwise treat as visible.
  note.style.scrollMarginTop = `${(header?.getBoundingClientRect().height ?? 0) + 8}px`;
  note.scrollIntoView({ block: 'nearest' });
  const footer = dialogNode?.querySelector<HTMLElement>('.skill-upload-submit');
  if (!dialogNode || !footer) return;
  const noteBox = note.getBoundingClientRect();
  const foot = footer.getBoundingClientRect();
  if (foot.top < noteBox.bottom - 1 && foot.bottom > noteBox.top + 1) dialogNode.scrollTop += noteBox.bottom - foot.top + 8;
}

function SubmissionPreview({ submission, busy, onPublish }: { submission: Submission; busy: boolean; onPublish: () => void }) {
  const region = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = region.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    const dialog = node.closest('dialog');
    const footer = node.querySelector<HTMLElement>('.skill-upload-submit');
    if (!dialog || !footer) return;
    const align = () => {
      const box = dialog.getBoundingClientRect();
      const foot = footer.getBoundingClientRect();
      if (foot.bottom > box.bottom - 1) dialog.scrollTop += foot.bottom - box.bottom + 4;
      if (footer.getBoundingClientRect().top < dialog.getBoundingClientRect().top) dialog.scrollTop -= dialog.getBoundingClientRect().top - footer.getBoundingClientRect().top;
    };
    align();
    align();
    const image = node.querySelector('img');
    if (!image || image.complete) return;
    image.addEventListener('load', align);
    image.addEventListener('error', align);
    return () => {
      image.removeEventListener('load', align);
      image.removeEventListener('error', align);
    };
  }, [submission.submission_id]);
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
    {submission.status === 'ready_for_review' && <div className="skill-upload-submit">
      <p className="field-hint">送出後，介紹、示意圖與分享短文會公開在網路上。此投稿列為社群候選作品；正式收錄另由工坊審核。</p>
      {(submission.seed || submission.upgrades_submission_id) && <p className="field-hint">送出後會取代簡易版；原本的作品連結會自動轉到完整版。</p>}
      <div className="actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={onPublish}>送出技能</button></div>
    </div>}
  </section>;
}

export function SkillUpload({ client, onPublished, openRequest = null, onChanged, secondary = false }: { client: PortalClient; onPublished?: () => void | Promise<void>; openRequest?: SkillOpenRequest | null; onChanged?: () => void; secondary?: boolean }) {
  const [open, setOpen] = useState(false), dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), titleId = useId();
  const dialogSession = useRef(0), dialogActive = useRef(false), draftsLeadReady = useRef(false);
  const [items, setItems] = useState<Submission[]>([]), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null), [issue, setIssue] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [draftResult, setDraftResult] = useState<string | null>(null);
  const [preview, setPreview] = useState<Submission | null>(null), [previewError, setPreviewError] = useState<string | null>(null);
  const [keys, setKeys] = useState<UploadKey[]>([]), [keysError, setKeysError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState({ label: '', expires_in_days: '30' }), [issuedKey, setIssuedKey] = useState<{ id: string; label: string; token: string } | null>(null);
  const [chatRepo, setChatRepo] = useState(''), [chatJson, setChatJson] = useState(''), [chatError, setChatError] = useState<string | null>(null), [chatBusy, setChatBusy] = useState(false), [chatCopied, setChatCopied] = useState('');
  const [chatTargetId, setChatTargetId] = useState<string | null>(null), [draftsLead, setDraftsLead] = useState<boolean | null>(null);
  const chatFile = useRef<HTMLInputElement>(null), heldRef = useRef<HeldGrant | null>(null), copyChatButton = useRef<HTMLButtonElement>(null), pendingChatFocus = useRef(false), draftResultRef = useRef<HTMLParagraphElement>(null);
  const instructionRef = useRef<HTMLDivElement>(null), instructionCopyRef = useRef<HTMLButtonElement>(null), pendingInstructionFocus = useRef(false);
  const drafts = useModuleMutation(client), rowActions = useModuleMutation(client), credentials = useModuleMutation(client);
  // The first loaded list picks the section order. Later lists may move it up, never down, until the dialog closes.
  const noteDraftOrder = useCallback((list: Submission[]) => {
    if (!dialogActive.current) return;
    const lead = draftsLeadList(list);
    if (!draftsLeadReady.current) { draftsLeadReady.current = true; setDraftsLead(lead); return; }
    if (lead) setDraftsLead(true);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const loaded = requireItems<Submission>(await client.get('/me/skill-submissions'), '技能草稿');
      setItems(loaded);
      noteDraftOrder(loaded);
      const held = heldRef.current;
      if (held) {
        const draft = loaded.find(item => item.submission_id === held.id);
        if (!draft || draft.status !== 'awaiting_upload' || draft.grant_revoked_at || (draft.grant_expires_at && isExpired(draft.grant_expires_at))) heldRef.current = null;
      }
      setSecret(current => {
        const draft = loaded.find(item => item.submission_id === current?.submissionId);
        return draft && (draft.status !== 'awaiting_upload' || draft.grant_consumed_at || draft.grant_revoked_at || (draft.grant_expires_at && isExpired(draft.grant_expires_at))) ? null : current;
      });
      return loaded;
    }
    catch (cause) { setLoadError(cause instanceof Error ? cause.message : '無法載入技能草稿。'); return null; }
    finally { setLoading(false); }
  }, [client, noteDraftOrder]);
  const refreshKeys = useCallback(async () => {
    setKeysError(null);
    try { setKeys(requireItems<UploadKey>(await client.get('/me/skill-upload-keys'), '上傳金鑰')); }
    catch (cause) { setKeysError(cause instanceof Error ? cause.message : '無法載入上傳金鑰。'); }
  }, [client]);

  useEffect(() => {
    if (!open) return;
    void refresh(); void refreshKeys();
  }, [open, refresh, refreshKeys]);
  // Drop an expired one-time grant instead of leaving a dead credential on screen.
  useEffect(() => {
    if (!secret) return;
    const timer = window.setInterval(() => { if (isExpired(secret.expiresAt)) { setSecret(null); setIssue('一次性上傳憑證已過期，請為草稿重新產生指令。'); } }, 15_000);
    return () => window.clearInterval(timer);
  }, [secret]);

  // Remove secret DOM before native close() hides the dialog and queues its close event.
  function closed() {
    dialogSession.current += 1; dialogActive.current = false; draftsLeadReady.current = false;
    flushSync(() => {
      heldRef.current = null;
      setSecret(null); setIssuedKey(null); setIssue(null); setNotice(null); setDraftResult(null); setPreview(null); setPreviewError(null);
      setChatRepo(''); setChatJson(''); setChatError(null); setChatBusy(false); setChatCopied('');
      setChatTargetId(null); pendingChatFocus.current = false; pendingInstructionFocus.current = false; setDraftsLead(null);
      setOpen(false);
    });
    onChanged?.();
  }
  function show() {
    dialogSession.current += 1; dialogActive.current = true;
    flushSync(() => setOpen(true));
    if (!dialog.current?.open) dialog.current?.showModal();
  }
  function sessionActive(session: number) { return dialogActive.current && dialog.current?.open === true && dialogSession.current === session; }
  function close() {
    closed();
    if (dialog.current?.open) dialog.current.close();
    trigger.current?.focus();
  }
  function acceptGrant(result: GrantResult | undefined) {
    if (!result) return;
    setItems(current => [result.submission, ...current.filter(item => item.submission_id !== result.submission.submission_id)]);
    const grant = result.upload_grant, submitUrl = grant ? sameOriginSubmitUrl(grant.submit_url) : null;
    if (!grant) { setSecret(null); setIssue('草稿已建立，但憑證只在第一次回應顯示。請在下方草稿按「重新產生指令」。'); return; }
    if (!submitUrl) { setSecret(null); setIssue('上傳網址不是本站位址，已停止顯示憑證。請重新產生指令。'); return; }
    if (isExpired(grant.expires_at)) { setSecret(null); setIssue('一次性上傳憑證已過期，請為草稿重新產生指令。'); return; }
    setIssue(null); setSecret({ submissionId: result.submission.submission_id, token: grant.token, expiresAt: grant.expires_at, submitUrl, seed: result.submission.seed ?? null });
  }
  async function createDraft() {
    setNotice(null); setDraftResult(null); setIssue(null); rowActions.setError(null);
    pendingInstructionFocus.current = false;
    const session = dialogSession.current;
    const result = await drafts.mutate<GrantResult>('/me/skill-submissions', {});
    if (result) onChanged?.();
    if (sessionActive(session)) acceptGrant(result);
  }
  async function regrant(item: Submission) {
    setNotice(null); setDraftResult(null); setIssue(null); drafts.setError(null);
    const session = dialogSession.current;
    const result = await rowActions.mutate<GrantResult>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}/grant`, {}, Number(item.aggregate_version));
    if (result) onChanged?.();
    if (!sessionActive(session)) return;
    const grant = result?.upload_grant, submitUrl = grant ? sameOriginSubmitUrl(grant.submit_url) : null;
    // The instruction renders in the agent section, below the drafts a phone is looking at.
    pendingInstructionFocus.current = Boolean(grant && submitUrl && !isExpired(grant.expires_at));
    acceptGrant(result);
  }
  async function revoke(item: Submission) {
    setDraftResult(null); drafts.setError(null);
    const saved = await rowActions.mutate<Submission>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}/revoke`, {}, Number(item.aggregate_version));
    if (!saved) return;
    if (secret?.submissionId === item.submission_id) setSecret(null);
    if (preview?.submission_id === item.submission_id) setPreview(null);
    if (chatTargetId === item.submission_id) setChatTargetId(null);
    setNotice(null); setDraftResult('草稿已撤銷，憑證無法再上傳。'); await refresh(); onChanged?.();
  }
  async function showPreview(item: Submission) {
    setPreviewError(null); setPreview(null);
    const session = dialogSession.current;
    try { const loaded = await client.get<Submission>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}`); if (sessionActive(session)) setPreview(loaded); }
    catch (cause) { if (sessionActive(session)) setPreviewError(cause instanceof Error ? cause.message : '無法載入草稿內容。'); }
  }
  async function publish(item: Submission) {
    setDraftResult(null); drafts.setError(null);
    const saved = await rowActions.mutate<Submission>(`/me/skill-submissions/${encodeURIComponent(item.submission_id)}/publish`, { consent_to_share: true }, Number(item.aggregate_version));
    if (!saved) return;
    logConsoleEvent({id:`skill:${saved.submission_id}`,createdAt:saved.updated_at,channel:consoleChannel('skill_published'),level:'success',kind:'broadcast',source:'技能書發布',message:`技能書「${saved.payload?.title??'未命名技能'}」已建立公開介紹頁。`});
    setPreview(saved); setNotice(null); setDraftResult('技能已送出，公開介紹頁已建立。'); await refresh(); onChanged?.(); await onPublished?.();
  }
  // Chat upload keeps the one-time grant in memory. It must not open the Agent instruction.
  function rememberGrant(result: GrantResult | undefined): HeldGrant | null {
    if (result) setItems(current => [result.submission, ...current.filter(item => item.submission_id !== result.submission.submission_id)]);
    const grant = result?.upload_grant, submitUrl = grant ? sameOriginSubmitUrl(grant.submit_url) : null;
    if (!result || !grant || !submitUrl || isExpired(grant.expires_at)) { heldRef.current = null; return null; }
    const next = { id: result.submission.submission_id, token: grant.token, submitUrl, version: Number(result.submission.aggregate_version) };
    heldRef.current = next;
    return next;
  }
  function heldGrant(): HeldGrant | null {
    const current = heldRef.current;
    if (!current) return null;
    const draft = items.find(item => item.submission_id === current.id);
    if (draft && (draft.status !== 'awaiting_upload' || draft.grant_revoked_at || (draft.grant_expires_at && isExpired(draft.grant_expires_at)))) {
      heldRef.current = null;
      return null;
    }
    return current;
  }
  async function rotateHeld(id: string, version: number) {
    const result = await client.post<GrantResult>(`/me/skill-submissions/${encodeURIComponent(id)}/grant`, {}, { ifMatch: version });
    const grant = rememberGrant(result);
    if (!grant) throw new Error('無法取得新的上傳授權。請按「重新產生指令」後再貼一次 JSON。');
    onChanged?.();
    return grant;
  }
  async function grantForPaste(repositoryUrl: unknown) {
    const key = repositoryKey(typeof repositoryUrl === 'string' ? repositoryUrl : null);
    const target = chatTargetId ? items.find(item => item.submission_id === chatTargetId) : undefined;
    // /grant renews any awaiting_upload draft, including one whose previous grant expired or was revoked.
    const seeded = key ? items.find(item => item.status === 'awaiting_upload' && item.seed && repositoryKey(item.seed.repository_url) === key) : undefined;
    const plain = items.find(plainGrantUsable);
    const chosen = target?.status === 'awaiting_upload' ? target : seeded ?? plain;
    const held = heldGrant();
    if (chosen) return held?.id === chosen.submission_id ? held : rotateHeld(chosen.submission_id, Number(chosen.aggregate_version));
    if (held && !items.some(item => item.submission_id === held.id && item.seed)) return held;
    const created = await client.post<GrantResult>('/me/skill-submissions', {});
    const grant = rememberGrant(created);
    if (!grant) throw new Error('草稿已建立，但沒有可使用的上傳授權。請按「重新產生指令」後再貼一次 JSON。');
    onChanged?.();
    return grant;
  }
  async function agentDetail(response: Response) {
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim();
    } catch { /* The status is enough for a fallback. */ }
    if (response.status === 401) return '上傳授權已失效。請按「重新產生指令」後再貼一次 JSON。';
    return `上傳沒有完成（${response.status}）。`;
  }
  async function submitChat(event: FormEvent) {
    event.preventDefault();
    setChatError(null); setNotice(null); setDraftResult(null); rowActions.setError(null);
    const parsed = parseChatSkillJson(chatJson);
    if (!parsed.ok) { setChatError(parsed.message); return; }
    const session = dialogSession.current;
    setChatBusy(true);
    try {
      let grant = await grantForPaste(parsed.value.repository_url);
      const send = (current: HeldGrant) => fetch(current.submitUrl, {
        method: 'POST', credentials: 'same-origin',
        headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: parsed.text,
      });
      let response = await send(grant);
      if (response.status === 401) { grant = await rotateHeld(grant.id, grant.version); response = await send(grant); }
      if (!sessionActive(session)) return;
      if (!response.ok) { setChatError(await agentDetail(response)); return; }
      setChatJson('');
      setChatError(null); setNotice(null); setDraftResult('草稿已上傳，請預覽內容後再送出。');
      onChanged?.();
      await refresh();
      if (sessionActive(session)) await showPreview({ submission_id: grant.id } as Submission);
    } catch (cause) {
      if (sessionActive(session)) setChatError(cause instanceof Error ? cause.message : '上傳沒有完成。');
    } finally { if (sessionActive(session)) setChatBusy(false); }
  }
  async function loadChatFile(file: File) {
    setChatError(null);
    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') { setChatError('請選擇 .json 檔。'); return; }
    if (file.size > CHAT_JSON_MAX_BYTES) { setChatError('JSON 超過 800 KB 上限。請讓 AI 縮小內容，不要附上過大的示意圖。'); return; }
    const text = await file.text();
    setChatJson(text);
    const parsed = parseChatSkillJson(text);
    if (!parsed.ok) setChatError(parsed.message);
  }
  async function copyChat() {
    const value = chatSkillInstruction(chatRepo, items.find(item => item.submission_id === chatTargetId)?.seed);
    try { await navigator.clipboard.writeText(value); setChatCopied('已複製給聊天 AI 的說明。'); }
    catch { setChatCopied('無法自動複製，請選取說明後手動複製。'); }
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

  const chatTarget = items.find(item => item.submission_id === chatTargetId) ?? null;
  const actions = useRef({ show, refresh, showPreview, sessionActive });
  actions.current = { show, refresh, showPreview, sessionActive };
  useEffect(() => {
    if (!openRequest) return;
    const request = openRequest;
    let cancelled = false;
    actions.current.show();
    const session = dialogSession.current;
    void (async () => {
      const loaded = await actions.current.refresh();
      if (cancelled || !actions.current.sessionActive(session) || !loaded) return;
      const draft = loaded.find(item => item.submission_id === request.submissionId);
      if (!draft) return;
      if (request.mode === 'preview') await actions.current.showPreview(draft);
      else {
        setChatTargetId(draft.submission_id);
        setChatRepo(draft.seed?.repository_url ?? '');
        pendingChatFocus.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [openRequest]);
  useLayoutEffect(() => {
    if (!pendingChatFocus.current) return;
    const node = dialog.current;
    const button = copyChatButton.current;
    if (!node || !button) return;
    pendingChatFocus.current = false;
    const target = node.querySelector<HTMLElement>('.skill-upload-target');
    if (!target) { button.focus(); return; }
    const header = node.querySelector<HTMLElement>('.skill-upload-header');
    const style = getComputedStyle(node);
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    const visibleTop = () => node.getBoundingClientRect().top + borderTop + headerHeight;
    const visibleBottom = () => node.getBoundingClientRect().bottom - borderBottom;
    // Keep the target a step below the sticky header. The focused copy button wins when the dialog is too short to show both.
    node.scrollTop += target.getBoundingClientRect().top - visibleTop() - 12;
    const overflow = button.getBoundingClientRect().bottom - visibleBottom();
    if (overflow > 0) node.scrollTop += overflow;
    button.focus({ preventScroll: true });
  }, [chatTargetId, open]);
  useEffect(() => {
    if (!open || !secret) return;
    const watched = secret.submissionId;
    const session = dialogSession.current;
    let stopped = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void (async () => {
        try {
          const loaded = requireItems<Submission>(await client.get('/me/skill-submissions'), '技能草稿');
          if (stopped || !dialogActive.current || dialogSession.current !== session) return;
          setItems(loaded);
          noteDraftOrder(loaded);
          const draft = loaded.find(item => item.submission_id === watched);
          const expired = Boolean(draft?.grant_expires_at && isExpired(draft.grant_expires_at));
          if (!draft || draft.status === 'revoked' || draft.grant_revoked_at || expired) {
            setSecret(current => current?.submissionId === watched ? null : current);
            return;
          }
          if (draft.status === 'ready_for_review') {
            setSecret(current => current?.submissionId === watched ? null : current);
            setDraftResult(null); setNotice(`Agent 已上傳「${draft.payload?.title ?? ''}」，請預覽後送出。`);
            await actions.current.showPreview(draft);
          }
        } catch { /* The next visible tick tries again. */ }
      })();
    }, 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [open, secret, client, noteDraftOrder]);
  const draftNote = rowActions.error ?? draftResult;
  useLayoutEffect(() => {
    const note = draftResultRef.current;
    if (!draftNote || !note) return;
    const bringIntoView = () => bringDialogNoteIntoView(note);
    bringIntoView();
    const image = note.closest('dialog')?.querySelector<HTMLImageElement>('.skill-upload-preview img');
    if (!image || image.complete) return;
    image.addEventListener('load', bringIntoView);
    image.addEventListener('error', bringIntoView);
    return () => {
      image.removeEventListener('load', bringIntoView);
      image.removeEventListener('error', bringIntoView);
    };
  }, [draftNote, preview?.submission_id, draftsLead]);
  useLayoutEffect(() => {
    if (!pendingInstructionFocus.current) return;
    const note = instructionRef.current, button = instructionCopyRef.current;
    if (!secret || !note || !button) return;
    pendingInstructionFocus.current = false;
    bringDialogNoteIntoView(note);
    button.focus({ preventScroll: true });
  }, [secret]);

  const instruction = secret ? agentInstruction(window.location.origin, secret, secret.seed) : '';
  const showDraftsFirst = draftsLead ?? draftsLeadList(items);
  const writing = drafts.busy || rowActions.busy;
  function draftOutcome(withPreview: boolean) {
    if (Boolean(preview) !== withPreview) return null;
    if (rowActions.error) return <p ref={draftResultRef} role="alert" className="banner banner-error">{rowActions.error}</p>;
    if (draftResult) return <p ref={draftResultRef} role="status" className="status-note">{draftResult}</p>;
    return null;
  }
  function focusChat(item: Submission) {
    setChatTargetId(item.submission_id);
    setChatRepo(item.seed?.repository_url ?? '');
    pendingChatFocus.current = true;
  }
  const draftsSection = <section className="stack" aria-labelledby={`${titleId}-drafts`}>
    <div className="skill-upload-row"><h3 id={`${titleId}-drafts`}>我的私人技能草稿</h3><button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void refresh()}>重新整理草稿</button></div>
    {loadError && <p role="alert" className="banner banner-error">{loadError}</p>}
    {loading && <p role="status">正在載入草稿…</p>}
    {!loading && !loadError && items.length === 0 && <p className="field-hint">還沒有草稿。</p>}
    <ul className="skill-upload-list">{items.map(item => {
      const path = localPath(item.public_path), name = item.payload?.title ?? formatIsoLocal(item.created_at);
      const seededWaiting = item.status === 'awaiting_upload' && Boolean(item.seed);
      const upgradeDraft = Boolean(item.seed) && (item.status === 'awaiting_upload' || item.status === 'ready_for_review');
      const seededName = item.seed?.title ?? name;
      const rowTitle = upgradeDraft ? `升級：${item.seed?.title ?? item.payload?.title ?? '尚未上傳內容'}` : (item.payload?.title ?? '尚未上傳內容');
      const status = seededWaiting
        ? `待補分享介紹 · ${item.seed?.repository_url ?? ''}`
        : `${item.status === 'awaiting_upload' && item.grant_revoked_at ? '上傳憑證已撤銷' : item.status === 'awaiting_upload' && item.grant_expires_at && isExpired(item.grant_expires_at) ? '上傳憑證已過期' : statusLabels[item.status]} · ${item.payload?.repository_url ?? formatIsoLocal(item.created_at)}`;
      return <li key={item.submission_id} className="skill-upload-item" data-status={item.status}>
        <div className="skill-upload-item-copy"><strong>{rowTitle}</strong><span className="field-hint">{status}</span>{item.catalog_book && <span className="field-hint">已收錄為技能書「{item.catalog_book.title}」，送出後書架只顯示正式版本。</span>}</div>
        <div className="actions">
          {seededWaiting && <button type="button" className="btn btn-primary" disabled={writing} aria-label={`用聊天 AI 補介紹：${seededName}`} onClick={() => focusChat(item)}>用聊天 AI 補介紹</button>}
          {seededWaiting && <button type="button" className="btn btn-ghost" disabled={writing} aria-label={`交給 Agent：${seededName}`} onClick={() => void regrant(item)}>交給 Agent</button>}
          {item.status === 'awaiting_upload' && !seededWaiting && <button type="button" className="btn btn-ghost" disabled={writing} aria-label={`重新產生指令：${name}`} onClick={() => void regrant(item)}>重新產生指令</button>}
          {item.status === 'ready_for_review' && <button type="button" className="btn btn-primary" aria-label={`預覽並送出：${item.payload?.title ?? name}`} onClick={() => void showPreview(item)}>預覽並送出</button>}
          {item.payload && item.status !== 'ready_for_review' && <button type="button" className="btn btn-ghost" aria-label={`預覽：${name}`} onClick={() => void showPreview(item)}>預覽</button>}
          {(item.status === 'awaiting_upload' || item.status === 'ready_for_review') && <button type="button" className="btn btn-ghost" disabled={writing} aria-label={`撤銷草稿：${seededWaiting ? seededName : name}`} onClick={() => void revoke(item)}>撤銷</button>}
          {item.status === 'published' && path && <a href={path} target="_blank" rel="noopener noreferrer">查看 ↗</a>}
        </div>
      </li>;
    })}</ul>
    {draftOutcome(false)}
    {previewError && <p role="alert" className="banner banner-error">{previewError}</p>}
    {preview && <SubmissionPreview submission={preview} busy={writing} onPublish={() => void publish(preview)}/>}
    {draftOutcome(true)}
  </section>;
  const dialogNode = <dialog ref={dialog} className="skill-upload-dialog" aria-labelledby={titleId} onCancel={event => { if (event.target === event.currentTarget) { event.preventDefault(); close(); } }} onClose={event => {
      // Explicit closes already cleared state; a queued old event must not close a reopened dialog.
      if (event.target === event.currentTarget && !event.currentTarget.open && dialogActive.current) close();
    }}>
      {open && <div className="stack">
        <header className="skill-upload-header"><div><p className="eyebrow">自由工坊 · 技能上傳</p><h2 id={titleId}>上傳技能</h2></div><button type="button" className="btn btn-ghost" onClick={close} aria-label="關閉上傳技能">關閉</button></header>
        {showDraftsFirst && draftsSection}

        <section className="stack" aria-labelledby={`${titleId}-agent`}>
          <h3 id={`${titleId}-agent`}>交給 Agent 讀取專案</h3>
          <p className="field-hint">私人指令含 60 分鐘內有效的一次性憑證，只能上傳一份草稿；只貼給你自己選擇的 Agent，平台不會自動傳給第三方。</p>
          <div className="actions"><button type="button" className="btn btn-primary" disabled={writing} onClick={() => void createDraft()}>{drafts.busy ? '處理中…' : '產生私人上傳指令'}</button><a href={`${GUIDE}/SKILL.md`} target="_blank" rel="noopener noreferrer">公開指南 ↗</a></div>
          {issue && <p role="alert" className="banner banner-error">{issue}</p>}
          {drafts.error && <p role="alert" className="banner banner-error">{drafts.error}</p>}
          {notice && <p role="status" className="status-note">{notice}</p>}
          {secret && <CopySecret rootRef={instructionRef} copyButtonRef={instructionCopyRef} label="私人上傳指令" value={instruction} hint={`憑證 ${formatIsoLocal(secret.expiresAt)} 到期，只顯示在此視窗；關閉後即移除。`}/>}
        </section>

        <section className="skill-upload-chat stack" aria-labelledby={`${titleId}-chat`}>
          <h3 id={`${titleId}-chat`}>沒有程式 Agent，改用聊天 AI</h3>
          <p className="field-hint">ChatGPT、Claude、Gemini 網頁版不能替你上傳。把說明貼給它，再把回覆的 JSON 貼回來。說明裡沒有授權，也不含上傳網址。</p>
          {chatTarget?.seed && <div className="skill-upload-target"><p>正在補完：{chatTarget.seed.title}</p><button type="button" className="btn btn-ghost" onClick={() => { setChatTargetId(null); setChatRepo(''); }}>改為新草稿</button></div>}
          <label className="field">公開儲存庫網址<input value={chatRepo} maxLength={300} placeholder="https://github.com/擁有者/儲存庫" autoComplete="off" spellCheck={false} onChange={event => setChatRepo(event.target.value)}/></label>
          <label className="field" htmlFor={`${titleId}-chat-instruction`}>給聊天 AI 的說明</label>
          <textarea id={`${titleId}-chat-instruction`} readOnly rows={7} value={chatSkillInstruction(chatRepo, chatTarget?.seed)} spellCheck={false}/>
          <div className="actions"><button ref={copyChatButton} type="button" className="btn btn-ghost" onClick={() => void copyChat()}>複製給聊天 AI</button>{chatCopied && <span role="status" className="field-hint">{chatCopied}</span>}</div>
          <form className="stack" onSubmit={event => void submitChat(event)}>
            <label className="field" htmlFor={`${titleId}-chat-json`}>貼上 JSON<textarea id={`${titleId}-chat-json`} rows={7} value={chatJson} spellCheck={false} placeholder={'貼上聊天 AI 回覆的 JSON。若包在 ```json 裡，整段貼上即可。'} onChange={event => { setChatJson(event.target.value); setChatError(null); }}/></label>
            <div className="actions">
              <button type="button" className="btn btn-ghost" onClick={() => chatFile.current?.click()}>選擇 JSON 檔</button>
              <input ref={chatFile} className="skill-upload-file" type="file" accept=".json,application/json" aria-label="選擇 JSON 檔" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void loadChatFile(file); }}/>
              <button className="btn btn-primary" disabled={chatBusy}>{chatBusy ? '正在送出…' : '用這份 JSON 建立草稿'}</button>
            </div>
          </form>
          {chatError && <p role="alert" className="banner banner-error">{chatError}</p>}
        </section>

        {!showDraftsFirst && draftsSection}

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
    </dialog>;
  return <>
    <button ref={trigger} type="button" className={`btn ${secondary ? 'btn-ghost' : 'btn-primary'} skill-upload-trigger`} aria-haspopup="dialog" onClick={show}>上傳技能</button>
    {typeof document === 'undefined' ? dialogNode : createPortal(dialogNode, document.body)}
  </>;
}
