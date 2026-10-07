import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { hasLoneSurrogate, type Config } from '../../../../contracts/guild-launchpad/v1/config';
import type { TenantView, WorkspaceView } from '../../../../contracts/guild-launchpad/v1/tenant';
import type { WorkspaceModuleBindingView } from '../../../../contracts/guild-launchpad/v1/module-registry';
import type { LaunchpadContext, Operation, ResultView, UploadView, WorkView } from '../../../../contracts/guild-launchpad/v1/tenant-work';
import { ApiError, type InstanceSelectionCandidate, type PortalClient } from '../api';
import { formatIsoLocal } from '../format';
import { TenantSelector } from './TenantSelector';
import { getWorkResultText, putWorkResultContent, type ResultContentType } from './work-result-client';
import './GuildLaunchpadMyWork.css';

const LEAVE = '有尚未儲存的內容，確定要離開嗎？';
const UPGRADE = '你是這個公會的實習成員：可以閱讀公會內容、在公會聊天室聊天。想發布或編輯，可以在聊天室跟會長打聲招呼，會長能把你設為正式成員。';
const CAPABILITY = '需要這個業務空間的擁有者或管理員。你可以切換到另一個業務空間，或聯絡它的擁有者。';
const INACTIVE = '目前無法使用這個業務空間。';
const POLICY = '保存功能尚未啟用';
const QUOTA = '已達容量上限。仍可閱讀與下載已保存的成果。';
const STORAGE = '儲存空間暫時無法使用，已保存的內容不受影響';
const UNCONFIRMED = '尚未確認是否儲存，請按重試（不會重複保存）';
const WORK_GONE = '這份工作已無法繼續保存。筆記還在這個畫面。';
const WORK_GONE_FILE = '這份工作已無法繼續保存。附件沒有送出。';
const CREATE_UNCONFIRMED = '工作已送出，但還沒確認。請再按一次「建立」繼續確認（不會重複建立）。';
const ENABLE_STALE = '工作空間的版本已更新，已重新載入。';
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F]/;
const DISPLAY_FORBIDDEN = /[\\/\u0000-\u001f\u007f\uD800-\uDFFF]/;
const PROGRESS_LABEL = { todo: '待辦', in_progress: '進行中', done: '完成' } as const;
type Progress = keyof typeof PROGRESS_LABEL;
type Page<T> = { items: T[]; next_cursor: string | null; source_version: string };
type Choice = { kind: 'create_new' } | { kind: 'reuse'; instance_id: string; expected_version: string };
type SavePhase = 'prepare' | 'put' | 'finalize' | 'confirm';
type SaveAttempt = {
  phase: SavePhase;
  key: string;
  bytes: Uint8Array;
  sha256: string;
  contentType: ResultContentType;
  displayName: string;
  expectedWorkVersion: string;
  sourceText: string | null;
  uploadId?: string;
  uploadVersion?: string;
  putVersion?: string;
  resultId?: string;
};
type Call = { signal?: AbortSignal; live: () => boolean };

// Same sessionStorage key TenantSettings writes. This screen also reads workspace_id.
export function actingKey(userId: string) { return `freedom-acting-tenant:${userId}`; }
export function readActing(userId: string): { tenant_id: string | null; workspace_id: string | null } {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(actingKey(userId)) ?? '') as { tenant_id?: unknown; workspace_id?: unknown };
    return {
      tenant_id: typeof parsed.tenant_id === 'string' ? parsed.tenant_id : null,
      workspace_id: typeof parsed.workspace_id === 'string' ? parsed.workspace_id : null,
    };
  } catch { return { tenant_id: null, workspace_id: null }; }
}
export function rememberActing(userId: string, tenantId: string, workspaceId: string, announce = false) {
  try { sessionStorage.setItem(actingKey(userId), JSON.stringify({ tenant_id: tenantId, workspace_id: workspaceId })); } catch { /* The screen still shows the current choice. */ }
  if (announce) window.dispatchEvent(new CustomEvent('freedom-acting-change', {detail: {userId, tenantId, workspaceId}}));
}
function byteLength(value: string) { return new TextEncoder().encode(value).length; }
function textProblem(value: string, kind: 'title' | 'objective'): string | null {
  if (value.trim().length === 0) return '不能是空白';
  if (kind === 'title' && (value.length > 120 || byteLength(value) > 480)) return '超過長度上限';
  if (kind === 'objective' && byteLength(value) > 16384) return '超過長度上限';
  if (CONTROL.test(value) || hasLoneSurrogate(value)) return '不能包含不允許的控制字元';
  return null;
}
function noteProblem(value: string): string | null {
  if (value.trim().length === 0) return '不能是空白';
  if (byteLength(value) > 262144) return '筆記超過 262144 位元組。';
  if (CONTROL.test(value) || hasLoneSurrogate(value)) return '不能包含不允許的控制字元';
  return null;
}
function displayNameProblem(value: string): string | null {
  if (value.length < 1 || value.length > 120 || byteLength(value) > 480) return '檔名需要 1 到 120 個字';
  if (DISPLAY_FORBIDDEN.test(value)) return '檔名不能包含斜線或控制字元';
  return null;
}
function contentTypeFor(name: string): ResultContentType | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  return null;
}
function defaultNoteName(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `筆記-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function flagOff(error: ApiError) {
  return error.status === 404 && `${error.detail ?? ''} ${error.message}`.includes('尚未提供');
}
function isAbort(error: unknown) {
  return error instanceof ApiError && error.code === 'aborted';
}
function unconfirmed(error: ApiError) {
  return error.timedOut || error.status === 0;
}
function workUnavailable(error: ApiError) {
  return error.status === 404 || (error.status === 409 && error.code === 'work_archived');
}

export function MyWorkPanel({ client, guildKey, userId, starter, registerLeave }: {
  client: PortalClient;
  guildKey: string;
  userId?: string;
  starter: Config['starter'];
  registerLeave: (guard: (() => boolean) | null) => void;
}) {
  const titleLabel = starter.title_label.trim() || '我的第一個工作';
  const objectiveLabel = starter.objective_hint.trim() || '寫下這次工作的目標。';
  const noteLabel = starter.note_hint.trim() || '記下過程、來源與下一步。';
  const headingId = useId();
  const createHeadingId = useId();
  const openHeadingId = useId();
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const keys = useRef(new Map<string, string>());
  const fileRef = useRef<HTMLInputElement>(null);
  const choiceDialog = useRef<HTMLDialogElement>(null);
  const archiveDialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const place = useRef({ tenantId: '', workspaceId: '' });
  const inactiveRef = useRef(false);
  const [editBase, setEditBase] = useState<{ version: string; title: string; objective: string; progress: Progress } | null>(null);
  const draft = useRef<{
    note: string;
    saved: string;
    file: boolean;
    pending: boolean;
    createDirty: boolean;
    editDirty: boolean;
    editBase: { version: string; title: string; objective: string; progress: Progress } | null;
  }>({ note: '', saved: '', file: false, pending: false, createDirty: false, editDirty: false, editBase: null });
  const [unavailable, setUnavailable] = useState(false);
  const [orphanNote, setOrphanNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tenants, setTenants] = useState<TenantView[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenant, setTenant] = useState<TenantView | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [works, setWorks] = useState<WorkView[]>([]);
  const [worksCursor, setWorksCursor] = useState<string | null>(null);
  const [work, setWork] = useState<WorkView | null>(null);
  const [heldVersion, setHeldVersion] = useState('');
  const [results, setResults] = useState<ResultView[]>([]);
  const [resultsCursor, setResultsCursor] = useState<string | null>(null);
  const [workspaceBinding, setWorkspaceBinding] = useState<WorkspaceModuleBindingView['binding']>(null);
  const bound = workspaceBinding !== null;
  const writable = workspaceBinding?.writable === true;
  const [policyOff, setPolicyOff] = useState(false);
  const [inactive, setInactive] = useState(false);
  const [capabilityDenied, setCapabilityDenied] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  const [quotaHit, setQuotaHit] = useState(false);
  const [storageDown, setStorageDown] = useState(false);
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<InstanceSelectionCandidate[] | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftObjective, setDraftObjective] = useState('');
  const [draftProgress, setDraftProgress] = useState<Progress>('todo');
  const [createError, setCreateError] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editObjective, setEditObjective] = useState('');
  const [editProgress, setEditProgress] = useState<Progress>('todo');
  const [editError, setEditError] = useState('');
  const [conflict, setConflict] = useState<WorkView | null>(null);
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [noteName, setNoteName] = useState(defaultNoteName);
  const [noteError, setNoteError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [stage, setStage] = useState('尚未儲存');
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);
  const [awaitingAck, setAwaitingAck] = useState(false);
  const [resave, setResave] = useState<SaveAttempt | null>(null);
  const [resultText, setResultText] = useState<{ id: string; text: string } | null>(null);
  const [resultError, setResultError] = useState('');
  const createDirty = draftTitle !== '' || draftObjective !== '' || draftProgress !== 'todo';
  const editDirty = Boolean(editBase && (editTitle !== editBase.title || editObjective !== editBase.objective || editProgress !== editBase.progress));
  draft.current = { note, saved: savedNote, file: file !== null, pending: attempt !== null || resave !== null || awaitingAck, createDirty, editDirty, editBase };
  const workspace = workspaces.find(item => item.workspace_id === workspaceId) ?? null;
  const writeLocked = (bound && !writable) || policyOff || inactive || capabilityDenied || quotaHit || upgrade;

  function nextGen(): Call {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const ticket = ++generation.current;
    return { signal: controller.signal, live: () => generation.current === ticket };
  }
  function currentCall(): Call {
    const ticket = generation.current;
    return { signal: abortRef.current?.signal, live: () => generation.current === ticket };
  }
  function leaveOk(includeCreate = true) {
    const now = draft.current;
    if (now.note === now.saved && !now.file && !now.pending && !now.editDirty && (!includeCreate || !now.createDirty)) return true;
    return window.confirm(LEAVE);
  }
  const leaveOkRef = useRef(leaveOk);
  leaveOkRef.current = leaveOk;
  function keyFor(fingerprint: string) {
    const existing = keys.current.get(fingerprint);
    if (existing) return existing;
    const created = crypto.randomUUID();
    keys.current.set(fingerprint, created);
    return created;
  }
  function clearDraft() {
    setNote(''); setSavedNote(''); setNoteName(defaultNoteName()); setNoteError('');
    setFile(null); setFileError('');
    if (fileRef.current) fileRef.current.value = '';
    setStage('尚未儲存'); setAttempt(null); setAwaitingAck(false); setResave(null);
    setResultText(null); setResultError(''); setConflict(null); setEditError('');
    setEditBase(null);
  }
  function clearPrivate() {
    clearDraft();
    setDraftTitle(''); setDraftObjective(''); setDraftProgress('todo'); setCreateError('');
    setEditTitle(''); setEditObjective(''); setEditProgress('todo'); setEditBase(null); setEditError('');
    setOrphanNote(null);
    setWorks([]); setWorksCursor(null); setWork(null); setHeldVersion(''); setResults([]); setResultsCursor(null);
    setWorkspaceBinding(null); setPolicyOff(false); setCapabilityDenied(false); setUpgrade(false); setQuotaHit(false);
    setStorageDown(false); setBanner(''); setCandidates(null); setArchiveOpen(false); setBusy(false);
  }
  function applyAccess(error: ApiError) {
    const detail = `${error.detail ?? ''}\n${error.message}`;
    if (flagOff(error)) { setUnavailable(true); return; }
    if (error.status === 403 && error.code === 'guild_full_member_required') { setUpgrade(true); setBanner(''); return; }
    if (error.status === 403 && detail.includes('目前無法使用這個業務空間')) { inactiveRef.current = true; setInactive(true); setBanner(INACTIVE); return; }
    if (error.status === 403 && (error.code === 'policy_unconfigured' || detail.includes('容量政策'))) { setPolicyOff(true); setBanner(POLICY); return; }
    if (error.status === 403) { setCapabilityDenied(true); setWorks([]); setWork(null); setBanner(CAPABILITY); return; }
    if (error.status === 429 || error.code === 'quota_exceeded') { setQuotaHit(true); setBanner(QUOTA); return; }
    if (error.status === 503) { setStorageDown(true); setBanner(STORAGE); return; }
    setBanner(error.message);
  }

  useEffect(() => {
    registerLeave(() => leaveOkRef.current());
    return () => registerLeave(null);
  }, [registerLeave]);

  useEffect(() => {
    const call = nextGen();
    void loadTenants(call);
    return () => { abortRef.current?.abort(); generation.current += 1; };
  }, [client, guildKey, userId]);

  useEffect(() => {
    const dialog = choiceDialog.current;
    if (!dialog) return;
    if (candidates?.length && !dialog.open) dialog.showModal();
    if (!candidates?.length && dialog.open) dialog.close();
  }, [candidates]);
  useEffect(() => {
    const dialog = archiveDialog.current;
    if (!dialog) return;
    if (archiveOpen && !dialog.open) dialog.showModal();
    if (!archiveOpen && dialog.open) dialog.close();
  }, [archiveOpen]);

  async function loadTenants(call: Call) {
    setLoading(true); setUnavailable(false);
    try {
      const page = await client.get<Page<TenantView>>('/tenants?limit=100', { signal: call.signal });
      if (!call.live()) return;
      setTenants(page.items);
      if (page.items.length === 0) { setTenantId(null); setTenant(null); setWorkspaceId(null); return; }
      const stored = userId ? readActing(userId) : { tenant_id: null, workspace_id: null };
      const next = page.items.find(item => item.tenant_id === stored.tenant_id) ?? page.items[0];
      setTenantId(next.tenant_id);
      await loadWorkspaces(next.tenant_id, stored.workspace_id, call);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (error instanceof ApiError) applyAccess(error);
      else setBanner('業務空間暫時無法載入。');
    } finally { if (call.live()) setLoading(false); }
  }
  async function loadWorkspaces(nextTenantId: string, prefer: string | null, call: Call) {
    try {
      const [detail, page] = await Promise.all([
        client.get<TenantView>(`/tenants/${nextTenantId}`, { signal: call.signal }),
        client.get<Page<WorkspaceView>>(`/tenants/${nextTenantId}/workspaces?limit=100`, { signal: call.signal }),
      ]);
      if (!call.live()) return;
      setTenant(detail);
      inactiveRef.current = detail.status !== 'active';
      setInactive(detail.status !== 'active');
      if (detail.status !== 'active') setBanner(INACTIVE);
      const active = page.items.filter(item => item.status === 'active');
      setWorkspaces(active);
      const next = active.find(item => item.workspace_id === prefer)
        ?? active.find(item => item.workspace_id === detail.default_workspace_id)
        ?? active[0] ?? null;
      setWorkspaceId(next?.workspace_id ?? null);
      place.current = { tenantId: nextTenantId, workspaceId: next?.workspace_id ?? '' };
      if (userId && next) rememberActing(userId, nextTenantId, next.workspace_id);
      if (next) await loadContext(nextTenantId, next.workspace_id, call);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (error instanceof ApiError) applyAccess(error);
      else setBanner('工作區暫時無法載入。');
    }
  }
  async function loadContext(nextTenantId: string, nextWorkspaceId: string, call: Call) {
    try {
      const [context, bindingView] = await Promise.all([
        client.get<LaunchpadContext>(`/tenants/${nextTenantId}/workspaces/${nextWorkspaceId}/launchpad-context?guild_key=${encodeURIComponent(guildKey)}`, { signal: call.signal }),
        client.get<WorkspaceModuleBindingView>(`/tenants/${nextTenantId}/workspaces/${nextWorkspaceId}/module-binding`, { signal: call.signal }),
      ]);
      if (!call.live() || context.tenant_id !== nextTenantId || context.workspace_id !== nextWorkspaceId
        || bindingView.tenant_id !== nextTenantId || bindingView.workspace_id !== nextWorkspaceId) return;
      setWorks(context.work_page.items);
      setWorksCursor(context.work_page.next_cursor);
      setWorkspaceBinding(bindingView.binding);
      setPolicyOff(context.capacity_summary.policy_revision === null);
      setCapabilityDenied(false); setUpgrade(false);
      if (context.capacity_summary.policy_revision === null) setBanner(POLICY);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      setWorks([]); setWorksCursor(null); setWorkspaceBinding(null);
      if (error instanceof ApiError) applyAccess(error);
      else setBanner('工作暫時無法載入。');
    }
  }
  async function reloadUnavailableInstance(error: unknown, call: Call): Promise<boolean> {
    if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'work_instance_unavailable') return false;
    if (draft.current.note !== draft.current.saved) setOrphanNote(draft.current.note);
    setAttempt(null); setAwaitingAck(false); setResave(null); setStage('尚未儲存'); setBanner('');
    if (place.current.tenantId && place.current.workspaceId) {
      await loadContext(place.current.tenantId, place.current.workspaceId, call);
    }
    return true;
  }
  function selectTenant(next: string) {
    if (next === tenantId) return;
    if (!leaveOk()) return;
    clearPrivate();
    inactiveRef.current = false;
    setTenant(null); setWorkspaces([]); setWorkspaceId(null); setTenantId(next); setInactive(false);
    place.current = { tenantId: next, workspaceId: '' };
    if (userId) rememberActing(userId, next, '', true);
    const call = nextGen();
    void loadWorkspaces(next, null, call);
  }
  function selectWorkspace(next: string) {
    if (next === workspaceId || !tenantId) return;
    if (!leaveOk()) return;
    clearPrivate();
    setWorkspaceId(next);
    place.current = { tenantId, workspaceId: next };
    if (userId) rememberActing(userId, tenantId, next, true);
    const call = nextGen();
    void loadContext(tenantId, next, call);
  }
  async function enable(choice?: Choice, button?: HTMLButtonElement) {
    if (!tenantId || !workspaceId || busy || writeLocked) return;
    if (button) opener.current = button;
    const fingerprint = choice ? `choice:${tenantId}:${workspaceId}:${JSON.stringify(choice)}` : `enable:${tenantId}:${workspaceId}`;
    const key = keyFor(fingerprint);
    const call = currentCall();
    setBusy(true); setBanner(''); setStorageDown(false);
    try {
      await client.post<Operation>(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, choice ? { guild_key: guildKey, choice } : { guild_key: guildKey }, { idempotencyKey: key, signal: call.signal });
      if (!call.live()) return;
      keys.current.delete(fingerprint);
      setCandidates(null);
      await loadContext(tenantId, workspaceId, call);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (error instanceof ApiError && error.status === 409 && error.code === 'instance_selection_required') {
        if (error.candidates?.length) setCandidates(error.candidates);
        else setBanner(error.message);
        return;
      }
      if (error instanceof ApiError && error.status === 412) {
        keys.current.delete(fingerprint);
        setCandidates(null);
        setBanner(ENABLE_STALE);
        await loadContext(tenantId, workspaceId, call);
        return;
      }
      if (!(error instanceof ApiError) || !error.network) keys.current.delete(fingerprint);
      if (error instanceof ApiError) applyAccess(error);
      else setBanner('啟用沒有完成。');
    } finally { if (call.live()) setBusy(false); }
  }
  async function createWork(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !workspaceId || !bound || busy || writeLocked) return;
    if (work && !leaveOk(false)) return;
    const titleError = textProblem(draftTitle, 'title');
    const objectiveError = textProblem(draftObjective, 'objective');
    setCreateError(titleError ?? objectiveError ?? '');
    if (titleError || objectiveError) return;
    const body = { title: draftTitle, objective: draftObjective, progress: draftProgress };
    const fingerprint = `create:${tenantId}:${workspaceId}:${JSON.stringify(body)}`;
    const key = keyFor(fingerprint);
    const call = currentCall();
    setBusy(true); setBanner('');
    let posted = false;
    try {
      const operation = await client.post<Operation>(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, body, { idempotencyKey: key, signal: call.signal });
      posted = true;
      if (!call.live()) return;
      const created = await client.get<WorkView>(`/tenants/${tenantId}/works/${operation.resource_ref.resource_id}`, { signal: call.signal });
      if (!call.live()) return;
      keys.current.delete(fingerprint);
      setDraftTitle(''); setDraftObjective(''); setDraftProgress('todo');
      await loadContext(tenantId, workspaceId, call);
      if (!call.live()) return;
      clearDraft();
      setOrphanNote(null);
      setResults([]); setResultsCursor(null);
      showWork(created, true);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (await reloadUnavailableInstance(error, call)) return;
      if (!posted && (!(error instanceof ApiError) || !error.network)) keys.current.delete(fingerprint);
      if (posted) {
        if (error instanceof ApiError && [403, 404, 429].includes(error.status)) applyAccess(error);
        else setBanner(CREATE_UNCONFIRMED);
        return;
      }
      if (error instanceof ApiError) applyAccess(error);
      else setBanner('工作沒有建立。');
    } finally { if (call.live()) setBusy(false); }
  }
  function showWork(value: WorkView, replaceForm: boolean) {
    setWork(value); setHeldVersion(value.version); setConflict(null);
    if (replaceForm) {
      setEditTitle(value.title); setEditObjective(value.objective); setEditProgress(value.progress);
      setEditBase({ version: value.version, title: value.title, objective: value.objective, progress: value.progress });
    }
  }
  function refreshWork(fresh: WorkView) {
    const isDirty = draft.current.editDirty;
    const base = draft.current.editBase;
    if (!isDirty || !base) {
      showWork(fresh, true);
      return;
    }
    setWork(fresh);
    setHeldVersion(fresh.version);
    if (fresh.title === base.title && fresh.objective === base.objective && fresh.progress === base.progress) {
      setEditBase({ version: fresh.version, title: fresh.title, objective: fresh.objective, progress: fresh.progress });
    }
  }
  async function openWork(workId: string) {
    if (!tenantId || work?.work_id === workId) return;
    if (!leaveOk(false)) return;
    clearDraft();
    setOrphanNote(null);
    const call = nextGen();
    setBusy(true);
    try {
      const [value, page] = await Promise.all([
        client.get<WorkView>(`/tenants/${tenantId}/works/${workId}`, { signal: call.signal }),
        client.get<Page<ResultView>>(`/tenants/${tenantId}/works/${workId}/results?limit=20`, { signal: call.signal }),
      ]);
      if (!call.live()) return;
      showWork(value, true);
      setResults(page.items); setResultsCursor(page.next_cursor); setStage('尚未儲存');
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      setWork(null); setHeldVersion(''); setResults([]); setResultsCursor(null);
      setEditTitle(''); setEditObjective(''); setEditProgress('todo'); setEditBase(null); setEditError('');
      if (error instanceof ApiError) applyAccess(error);
      else setBanner('這份工作暫時無法開啟。');
    } finally { if (call.live()) setBusy(false); }
  }
  async function loadMoreWorks() {
    if (!tenantId || !workspaceId || !worksCursor || busy) return;
    const call = currentCall();
    setBusy(true);
    try {
      const page = await client.get<Page<WorkView>>(`/tenants/${tenantId}/workspaces/${workspaceId}/works?cursor=${encodeURIComponent(worksCursor)}&limit=50`, { signal: call.signal });
      if (!call.live()) return;
      setWorks(current => [...current, ...page.items.filter(item => current.every(existing => existing.work_id !== item.work_id))]);
      setWorksCursor(page.next_cursor);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (error instanceof ApiError) applyAccess(error);
    } finally { if (call.live()) setBusy(false); }
  }
  async function loadMoreResults() {
    if (!tenantId || !work || !resultsCursor || busy) return;
    const call = currentCall();
    setBusy(true);
    try {
      const page = await client.get<Page<ResultView>>(`/tenants/${tenantId}/works/${work.work_id}/results?cursor=${encodeURIComponent(resultsCursor)}&limit=50`, { signal: call.signal });
      if (!call.live()) return;
      setResults(current => [...current, ...page.items.filter(item => current.every(existing => existing.result_id !== item.result_id))]);
      setResultsCursor(page.next_cursor);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (error instanceof ApiError) applyAccess(error);
    } finally { if (call.live()) setBusy(false); }
  }
  async function saveEdits() {
    if (!tenantId || !work || !editBase || busy || writeLocked || conflict) return;
    const titleError = textProblem(editTitle, 'title');
    const objectiveError = textProblem(editObjective, 'objective');
    setEditError(titleError ?? objectiveError ?? '');
    if (titleError || objectiveError) return;
    const body = { title: editTitle, objective: editObjective, progress: editProgress };
    const fingerprint = `edit:${work.work_id}:${editBase.version}:${JSON.stringify(body)}`;
    const key = keyFor(fingerprint);
    const call = currentCall();
    setBusy(true); setBanner('');
    try {
      await client.patch<Operation>(`/tenants/${tenantId}/works/${work.work_id}`, body, { idempotencyKey: key, ifMatch: editBase.version, signal: call.signal });
      if (!call.live()) return;
      keys.current.delete(fingerprint);
      const fresh = await client.get<WorkView>(`/tenants/${tenantId}/works/${work.work_id}`, { signal: call.signal });
      if (!call.live()) return;
      showWork(fresh, true);
      setWorks(current => current.map(item => item.work_id === fresh.work_id ? fresh : item));
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (await reloadUnavailableInstance(error, call)) return;
      if (error instanceof ApiError && error.status === 412) {
        keys.current.delete(fingerprint);
        try {
          const fresh = await client.get<WorkView>(`/tenants/${tenantId}/works/${work.work_id}`, { signal: call.signal });
          if (!call.live()) return;
          setConflict(fresh);
          setBanner('這份工作剛剛被更新。');
        } catch (reloadError) {
          if (call.live() && !isAbort(reloadError)) setBanner(reloadError instanceof Error ? reloadError.message : '重新載入失敗。');
        }
        return;
      }
      if (!(error instanceof ApiError) || !error.network) keys.current.delete(fingerprint);
      if (error instanceof ApiError) applyAccess(error);
    } finally { if (call.live()) setBusy(false); }
  }
  function keepMine() {
    if (!conflict) return;
    setHeldVersion(conflict.version);
    setWork(current => current ? { ...current, version: conflict.version } : current);
    setEditBase({ version: conflict.version, title: conflict.title, objective: conflict.objective, progress: conflict.progress });
    setConflict(null); setBanner('');
  }
  function takeServer() {
    if (!conflict) return;
    showWork(conflict, true); setBanner('');
  }
  async function archive() {
    if (!tenantId || !work || busy || writeLocked) return;
    const fingerprint = `archive:${work.work_id}:${heldVersion}`;
    const key = keyFor(fingerprint);
    const call = currentCall();
    const archivedId = work.work_id;
    setBusy(true); setBanner('');
    try {
      await client.post<Operation>(`/tenants/${tenantId}/works/${work.work_id}/archive`, {}, { idempotencyKey: key, ifMatch: heldVersion, signal: call.signal });
      if (!call.live()) return;
      keys.current.delete(fingerprint);
      setArchiveOpen(false);
      clearDraft(); setWork(null); setResults([]);
      setWorks(current => current.filter(item => item.work_id !== archivedId));
      if (place.current.workspaceId) await loadContext(tenantId, place.current.workspaceId, call);
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (!(error instanceof ApiError) || !error.network) keys.current.delete(fingerprint);
      if (error instanceof ApiError) applyAccess(error);
    } finally { if (call.live()) setBusy(false); }
  }
  async function beginNoteSave() {
    if (!work || busy || writeLocked || attempt) return;
    const problem = noteProblem(note) ?? displayNameProblem(noteName);
    setNoteError(problem ?? '');
    if (problem || note.trim().length === 0) return;
    const call = currentCall();
    const bytes = new TextEncoder().encode(note);
    const hash = await sha256Hex(bytes);
    if (!call.live()) return;
    await startSave({
      phase: 'prepare', key: crypto.randomUUID(), bytes, sha256: hash, contentType: 'text/markdown',
      displayName: noteName, expectedWorkVersion: heldVersion, sourceText: note,
    }, call);
  }
  async function beginFileSave() {
    if (!work || !file || busy || writeLocked || attempt) return;
    const contentType = contentTypeFor(file.name);
    if (!contentType) { setFileError('只接受 .txt 或 .md 檔案。'); return; }
    if (file.size < 1 || file.size > 262144) { setFileError('檔案大小必須在 1 到 262144 位元組之間。'); return; }
    const nameProblem = displayNameProblem(file.name);
    if (nameProblem) { setFileError(nameProblem); return; }
    const call = currentCall();
    const buffer = await file.arrayBuffer();
    if (!call.live()) return;
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength < 1 || bytes.byteLength > 262144) { setFileError('檔案大小必須在 1 到 262144 位元組之間。'); return; }
    const hash = await sha256Hex(bytes);
    if (!call.live()) return;
    setFileError('');
    await startSave({
      phase: 'prepare', key: crypto.randomUUID(), bytes, sha256: hash, contentType,
      displayName: file.name, expectedWorkVersion: heldVersion, sourceText: null,
    }, call);
  }
  async function startSave(next: SaveAttempt, call: Call) {
    setAttempt(next); setResave(null); setAwaitingAck(false); setStorageDown(false); setBanner('');
    await runSave(next, call);
  }
  async function runSave(next: SaveAttempt, call: Call) {
    if (!tenantId || !work) return;
    const workId = work.work_id;
    let current = next;
    setBusy(true);
    try {
      if (current.phase === 'prepare') {
        setStage('上傳中…');
        const operation = await client.post<Operation>(`/tenants/${tenantId}/works/${workId}/results/uploads`, {
          content_type: current.contentType, byte_size: current.bytes.byteLength, sha256: current.sha256,
          display_name: current.displayName, expected_work_version: current.expectedWorkVersion,
        }, { idempotencyKey: current.key, signal: call.signal });
        if (!call.live()) return;
        current = { ...current, uploadId: operation.resource_ref.resource_id, phase: 'put' };
        setAttempt(current);
      }
      if (current.phase === 'put') {
        setStage('上傳中…');
        if (!current.uploadVersion) {
          const upload = await client.get<UploadView>(`/tenants/${tenantId}/works/${workId}/results/uploads/${current.uploadId}`, { signal: call.signal });
          if (!call.live()) return;
          current = { ...current, uploadVersion: upload.version };
          setAttempt(current);
        }
        const verified = await putWorkResultContent(client, `/api/v1/tenants/${tenantId}/works/${workId}/results/uploads/${current.uploadId}/content`, current.bytes, current.contentType, current.uploadVersion!, current.key, call.signal);
        if (!call.live()) return;
        current = { ...current, putVersion: verified.version, phase: 'finalize' };
        setAttempt(current);
      }
      if (current.phase === 'finalize') {
        setStage('核對中…');
        const operation = await client.post<Operation>(`/tenants/${tenantId}/works/${workId}/results/uploads/${current.uploadId}/finalize`, { expected_work_version: current.expectedWorkVersion }, { idempotencyKey: current.key, ifMatch: current.putVersion, signal: call.signal });
        if (!call.live()) return;
        current = { ...current, resultId: operation.resource_ref.resource_id, phase: 'confirm' };
        setAttempt(current);
      }
      if (current.phase === 'confirm' && current.resultId) {
        const result = await client.get<ResultView>(`/tenants/${tenantId}/works/${workId}/results/${current.resultId}`, { signal: call.signal });
        if (!call.live()) return;
        const [fresh, page] = await Promise.all([
          client.get<WorkView>(`/tenants/${tenantId}/works/${workId}`, { signal: call.signal }),
          client.get<Page<ResultView>>(`/tenants/${tenantId}/works/${workId}/results?limit=20`, { signal: call.signal }),
        ]);
        if (!call.live()) return;
        refreshWork(fresh);
        setWorks(items => items.map(item => item.work_id === fresh.work_id ? fresh : item));
        setResults(page.items); setResultsCursor(page.next_cursor);
        if (current.sourceText !== null) setSavedNote(current.sourceText);
        else { setFile(null); if (fileRef.current) fileRef.current.value = ''; }
        setStage(`已儲存・第 ${result.revision} 版・${formatIsoLocal(result.created_at)}`);
        setAttempt(null); setAwaitingAck(false); setBanner('');
      }
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      if (await reloadUnavailableInstance(error, call)) return;
      if (!(error instanceof ApiError)) { setAwaitingAck(true); setStage(UNCONFIRMED); return; }
      if (error.status === 503) { setStorageDown(true); setBanner(STORAGE); setStage('尚未儲存'); return; }
      if (current.phase === 'finalize' && workUnavailable(error)) {
        if (current.sourceText !== null) setOrphanNote(current.sourceText);
        setAttempt(null); setAwaitingAck(false); setWork(null); setResults([]); setStage('尚未儲存');
        setBanner(current.sourceText !== null ? WORK_GONE : WORK_GONE_FILE);
        if (place.current.tenantId && place.current.workspaceId) await loadContext(place.current.tenantId, place.current.workspaceId, call);
        return;
      }
      if (error.status === 412) {
        setAttempt(null); setAwaitingAck(false); setResave(current); setStage('尚未儲存'); setBanner('工作版本已改變。');
        try {
          const fresh = await client.get<WorkView>(`/tenants/${tenantId}/works/${workId}`, { signal: call.signal });
          if (!call.live()) return;
          refreshWork(fresh);
        } catch { /* The resave button stays until a later reload. */ }
        return;
      }
      if (unconfirmed(error) || error.network) { setAwaitingAck(true); setStage(UNCONFIRMED); return; }
      setAttempt(null); setAwaitingAck(false);
      applyAccess(error); setStage('尚未儲存');
    } finally { if (call.live()) setBusy(false); }
  }
  async function saveAgain() {
    if (!resave || !work || busy) return;
    const call = currentCall();
    await startSave({
      ...resave, phase: 'prepare', key: crypto.randomUUID(), uploadId: undefined, uploadVersion: undefined, putVersion: undefined, resultId: undefined,
      expectedWorkVersion: heldVersion,
    }, call);
  }
  async function showResult(result: ResultView) {
    if (!tenantId || !work) return;
    const call = currentCall();
    setResultError('');
    try {
      const text = await getWorkResultText(client, `/api/v1/tenants/${tenantId}/works/${work.work_id}/results/${result.result_id}/content`, call.signal);
      if (!call.live()) return;
      setResultText({ id: result.result_id, text });
    } catch (error) {
      if (!call.live() || isAbort(error)) return;
      setResultError(error instanceof Error ? error.message : '內容暫時無法讀取。');
    }
  }
  function goBusiness(event: MouseEvent<HTMLAnchorElement>) {
    if (!leaveOk()) event.preventDefault();
  }

  if (unavailable) return <div className="stack">
    <p>業務空間尚未在此環境啟用</p>
    <p>這個環境還沒有開啟公會業務空間，所以這裡不能建立或保存工作。</p>
    <dl className="detail-list">
      <div><dt>標題</dt><dd>{starter.title_label}</dd></div>
      <div><dt>目標</dt><dd>{starter.objective_hint}</dd></div>
      <div><dt>筆記</dt><dd>{starter.note_hint}</dd></div>
    </dl>
  </div>;
  if (loading && tenants.length === 0 && !banner) return <p role="status">正在載入工作…</p>;
  if (upgrade) return <p className="field-hint" role="status">{UPGRADE}</p>;
  if (!loading && tenants.length === 0) return <div className="my-work">
    <p>你還沒有業務空間。</p>
    <a className="btn btn-ghost" href="#business" onClick={goBusiness}>前往業務空間</a>
  </div>;

  return <div className="my-work">
    {banner && <p className={banner === POLICY || banner === QUOTA || banner === STORAGE || banner === ENABLE_STALE ? 'banner' : 'banner banner-error'} role={banner === POLICY || banner === QUOTA || banner === STORAGE || banner === ENABLE_STALE ? 'status' : 'alert'}>{banner}</p>}
    {orphanNote !== null && <section className="stack" aria-label="未送出的筆記"><label className="field" htmlFor="my-work-orphan-note">未送出的筆記<textarea id="my-work-orphan-note" readOnly value={orphanNote}/></label></section>}
    {tenants.length > 0 && <TenantSelector tenants={tenants} selectedId={tenantId} onSelect={selectTenant}/>}
    {workspaces.length > 1 && <fieldset className="fieldset">
      <legend>工作區</legend>
      <div className="my-work-actions">{workspaces.map(item => <button key={item.workspace_id} type="button" className={item.workspace_id === workspaceId ? 'btn btn-primary' : 'btn btn-ghost'} aria-current={item.workspace_id === workspaceId ? 'true' : undefined} onClick={() => selectWorkspace(item.workspace_id)}>{item.name}</button>)}</div>
    </fieldset>}
    {tenant && workspace && <h3 id={headingId}>{tenant.display_name}／{workspace.name}</h3>}
    {tenant && workspace && !capabilityDenied && !upgrade && <>
      {bound ? <p className="my-work-status" role="status">{writable ? '繼續工作'
        : workspaceBinding?.instance_status === 'suspended' ? '這個工作區的模組已暫停，舊的工作仍可查看；恢復後才能新增或修改。'
        : workspaceBinding?.instance_status === 'archived' ? '這個工作區的模組已封存，舊的工作仍可查看；請改用其他工作區建立新工作。'
        : '這個工作區的模組目前無法寫入，舊的工作仍可查看。'}</p> : <button type="button" className="btn btn-primary my-work-primary" disabled={busy || writeLocked} onClick={event => void enable(undefined, event.currentTarget)}>啟用手動工作</button>}
      {bound && <>
        <section aria-label="工作">
          {works.length === 0 ? <p>這個工作區還沒有工作。</p> : <ul>{works.map(item => <li key={item.work_id}>
            <button type="button" className="btn btn-ghost" aria-current={work?.work_id === item.work_id ? 'true' : undefined} onClick={() => void openWork(item.work_id)}>{item.title}</button>
            <span>{PROGRESS_LABEL[item.progress]}</span>
          </li>)}</ul>}
          {worksCursor && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void loadMoreWorks()}>載入更多</button>}
        </section>
        {writable && <>
        <h4 id={createHeadingId}>新增工作</h4>
        <form className="stack" aria-labelledby={createHeadingId} onSubmit={event => void createWork(event)}>
          <label className="field" htmlFor="my-work-title">{titleLabel}
            <input id="my-work-title" aria-describedby={createError ? 'my-work-create-error' : undefined} value={draftTitle} maxLength={120} disabled={busy || writeLocked} onChange={event => setDraftTitle(event.target.value)}/>
          </label>
          <label className="field" htmlFor="my-work-objective">{objectiveLabel}
            <textarea id="my-work-objective" aria-describedby={createError ? 'my-work-create-error' : undefined} value={draftObjective} disabled={busy || writeLocked} onChange={event => setDraftObjective(event.target.value)}/>
          </label>
          <label className="field" htmlFor="my-work-progress">進度
            <select id="my-work-progress" value={draftProgress} disabled={busy || writeLocked} onChange={event => setDraftProgress(event.target.value as Progress)}>
              <option value="todo">待辦</option>
              <option value="in_progress">進行中</option>
              <option value="done">完成</option>
            </select>
          </label>
          {createError && <p id="my-work-create-error" className="banner banner-error" role="alert">{createError}</p>}
          <button type="submit" className="btn btn-primary my-work-primary" disabled={busy || writeLocked}>建立</button>
        </form>
        </>}
      </>}
      {work && <section className="stack my-work-open" aria-labelledby={openHeadingId}>
        <h4 id={openHeadingId}>{work.title}</h4>
        {!writable && <dl className="detail-list">
          <div><dt>目標</dt><dd>{work.objective}</dd></div>
          <div><dt>進度</dt><dd>{PROGRESS_LABEL[work.progress]}</dd></div>
        </dl>}
        {writable && <>
        <form className="stack" onSubmit={event => { event.preventDefault(); void saveEdits(); }}>
          <label className="field" htmlFor="my-work-edit-title">標題
            <input id="my-work-edit-title" aria-describedby={editError ? 'my-work-edit-error' : undefined} value={editTitle} maxLength={120} disabled={busy || writeLocked} onChange={event => setEditTitle(event.target.value)}/>
          </label>
          <label className="field" htmlFor="my-work-edit-objective">目標
            <textarea id="my-work-edit-objective" aria-describedby={editError ? 'my-work-edit-error' : undefined} value={editObjective} disabled={busy || writeLocked} onChange={event => setEditObjective(event.target.value)}/>
          </label>
          <label className="field" htmlFor="my-work-edit-progress">進度
            <select id="my-work-edit-progress" value={editProgress} disabled={busy || writeLocked} onChange={event => setEditProgress(event.target.value as Progress)}>
              <option value="todo">待辦</option>
              <option value="in_progress">進行中</option>
              <option value="done">完成</option>
            </select>
          </label>
          {editError && <p id="my-work-edit-error" className="banner banner-error" role="alert">{editError}</p>}
          {conflict && <div className="my-work-conflict">
            <p>這份工作剛剛被更新。</p>
            <p>我的標題：{editTitle}</p>
            <p>伺服器的標題：{conflict.title}</p>
            <p>我的目標：{editObjective}</p>
            <p>伺服器的目標：{conflict.objective}</p>
            <p>我的進度：{PROGRESS_LABEL[editProgress]}</p>
            <p>伺服器的進度：{PROGRESS_LABEL[conflict.progress]}</p>
            <div className="my-work-actions">
              <button type="button" className="btn btn-ghost" onClick={keepMine}>留下我的內容</button>
              <button type="button" className="btn btn-ghost" onClick={takeServer}>改用伺服器的版本</button>
            </div>
          </div>}
          <div className="my-work-actions">
            <button type="submit" className="btn btn-ghost" disabled={busy || writeLocked || Boolean(conflict)}>儲存變更</button>
            <button type="button" className="btn btn-ghost" disabled={busy || writeLocked} onClick={event => { if (!leaveOk(false)) return; opener.current = event.currentTarget; setArchiveOpen(true); }}>封存</button>
          </div>
        </form>
        <form className="stack" aria-label="筆記" onSubmit={event => { event.preventDefault(); void beginNoteSave(); }}>
          <label className="field" htmlFor="my-work-note">{noteLabel}
            <textarea id="my-work-note" aria-describedby={noteError ? 'my-work-note-error' : undefined} value={note} disabled={busy || writeLocked} onChange={event => { setNote(event.target.value); if (!attempt) setStage('尚未儲存'); }}/>
          </label>
          <label className="field" htmlFor="my-work-note-name">筆記檔名
            <input id="my-work-note-name" aria-describedby={noteError ? 'my-work-note-error' : undefined} value={noteName} maxLength={120} disabled={busy || writeLocked} onChange={event => setNoteName(event.target.value)}/>
          </label>
          {noteError && <p id="my-work-note-error" className="banner banner-error" role="alert">{noteError}</p>}
          <button type="submit" className="btn btn-primary my-work-primary" disabled={busy || writeLocked || Boolean(attempt)}>儲存筆記</button>
        </form>
        <form className="stack" aria-label="附上檔案" onSubmit={event => { event.preventDefault(); void beginFileSave(); }}>
          <label className="field" htmlFor="my-work-file">附件
            <input id="my-work-file" ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" aria-describedby={fileError ? 'my-work-file-error' : undefined} disabled={busy || writeLocked} onChange={event => { setFile(event.target.files?.[0] ?? null); setFileError(''); if (!attempt) setStage('尚未儲存'); }}/>
          </label>
          {fileError && <p id="my-work-file-error" className="banner banner-error" role="alert">{fileError}</p>}
          <button type="submit" className="btn btn-ghost" disabled={busy || writeLocked || !file || Boolean(attempt)}>儲存附件</button>
        </form>
        <p className="my-work-stage" aria-live="polite">{stage}</p>
        {(awaitingAck || (storageDown && attempt)) && <button type="button" className="btn btn-ghost" disabled={busy || !attempt} onClick={() => { if (attempt) void runSave(attempt, currentCall()); }}>重試</button>}
        {resave && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void saveAgain()}>用最新版本再儲存一次</button>}
        </>}
        <section aria-label="成果">
          {results.length === 0 ? <p>{writable ? '還沒有成果。寫下筆記或附上檔案後按儲存。' : '還沒有成果。'}</p> : <ul>{results.map(result => <li key={result.result_id} className="my-work-result">
            <p className="my-work-name">{result.display_name}</p>
            <p>第 {result.revision} 版 · <time dateTime={result.created_at}>{formatIsoLocal(result.created_at)}</time> · {result.byte_size} 位元組 · {result.sha256.slice(0, 12)}</p>
            <div className="my-work-actions">
              <a className="btn btn-ghost" href={`/api/v1/tenants/${tenantId}/works/${work.work_id}/results/${result.result_id}/content`} download={result.display_name}>下載</a>
              <button type="button" className="btn btn-ghost" onClick={() => void showResult(result)}>查看內容</button>
            </div>
            {resultText?.id === result.result_id && <pre>{resultText.text}</pre>}
          </li>)}</ul>}
          {resultError && <p className="banner banner-error" role="alert">{resultError}</p>}
          {resultsCursor && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void loadMoreResults()}>載入更多</button>}
        </section>
      </section>}
    </>}
    <dialog ref={choiceDialog} aria-labelledby="my-work-choice-title" onClose={() => { setCandidates(null); opener.current?.focus(); }}>
      <h2 id="my-work-choice-title">要沿用哪一個工作空間？</h2>
      <ul>{(candidates ?? []).map(candidate => <li key={candidate.instance_id}>
        <p id={`my-work-candidate-${candidate.instance_id}`}>{candidate.instance_id.slice(0, 8)} · {formatIsoLocal(candidate.created_at)} · 已綁定 {candidate.bound_workspace_count} 個工作區</p>
        <button type="button" className="btn btn-ghost" aria-describedby={`my-work-candidate-${candidate.instance_id}`} disabled={busy} onClick={() => void enable({ kind: 'reuse', instance_id: candidate.instance_id, expected_version: candidate.version })}>沿用這個工作空間</button>
      </li>)}</ul>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void enable({ kind: 'create_new' })}>建立新的工作空間</button>
    </dialog>
    <dialog ref={archiveDialog} aria-labelledby="my-work-archive-title" onClose={() => { setArchiveOpen(false); opener.current?.focus(); }}>
      <h2 id="my-work-archive-title">封存這份工作</h2>
      <p>封存後不再顯示，但不會刪除已保存的成果</p>
      <div className="my-work-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void archive()}>確認封存</button>
        <button type="button" className="btn btn-ghost" onClick={() => setArchiveOpen(false)}>取消</button>
      </div>
    </dialog>
  </div>;
}
