import {useEffect, useRef, useState} from 'react';
import {ApplicationPageSchema, ApplicationReleaseViewSchema, type ApplicationView} from '../../../../contracts/guild-launchpad/v1/module-registry';
import {z} from 'zod';
import {OpaqueId} from '../../../../contracts/common/v1/identity';
import {TenantPageSchema, WorkspacePageSchema, type TenantView, type WorkspaceView} from '../../../../contracts/guild-launchpad/v1/tenant';
import {ApplicationViewSchema, InstancePageSchema, InstallationPageSchema, InstallationViewSchema, LaunchPlanSchema, PlanInputSchema, LaunchInputSchema, RegistryOperationSchema, type InstanceView, type InstallationView, type LaunchPlan, type RegistryOperation} from '../../../../contracts/guild-launchpad/v1/module-registry';
import {readActing, rememberActing} from './GuildLaunchpadMyWork';
import {TenantSelector, roleLabel} from './TenantSelector';
import {moduleWord, INSTANCE_STATUS_WORDS} from './module-words';
import {formatIsoLocal} from '../format';
import {ApiError, type PortalClient} from '../api';
import './GuildLaunchpadApplications.css';

const REASONS: Record<string, string> = {
  guild_full_member_required: '需要這個公會的正式會員身分，請在聊天室聯絡會長。',
  tenant_manage_required: '你目前沒有可管理的業務空間，請前往業務空間建立或接受邀請。',
  policy_unconfigured: '業務空間尚未設定容量政策，請聯絡擁有者。',
  application_not_available: '這個應用版本目前無法啟動，可以先閱讀版本資料。',
};
const LICENSE = {reviewed: '已審查', unresolved: '待審查', blocked: '授權受阻'};
export function applicationStatus(app: ApplicationView): string {
  if (app.release_status === 'retired' || app.license_state === 'blocked') return '停用／版本需更新';
  if (app.release_status !== 'available' || app.license_state !== 'reviewed') return '審核中';
  if (!app.runtime_profiles.includes('hosted-reviewed')) return '外部／試用';
  return '可用';
}
type Release = z.infer<typeof ApplicationReleaseViewSchema>;

export function GuildLaunchpadApplications({client, guildKey, publicMode, userId, onLogin, onWork}: {
  client: PortalClient; guildKey: string; publicMode: boolean; userId?: string; onLogin?: () => void; onWork?: () => void;
}) {
  const [items, setItems] = useState<ApplicationView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');
  const [details, setDetails] = useState<Record<string, Release>>({});
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [launch, setLaunch] = useState<ApplicationView | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const restored = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    controller.current = new AbortController(); generation.current++;
    setLaunch(null); restored.current = false; setItems([]); setCursor(null); setDetails({}); setOpenDetail(null); setProblem('');
    void load();
    return () => { controller.current?.abort(); generation.current++; };
  }, [client, guildKey, publicMode, userId]);
  useEffect(() => {
    if (restored.current || publicMode || !userId || loading) return;
    restored.current = true;
    const pending = savedLaunches(userId, guildKey).at(-1);
    if (!pending) return;
    const app = pending.application ?? items.find(item => item.application_key === pending.application_key && item.release_ref === pending.release_ref);
    if (app) { setLaunch(app); return; }
    const ticket = generation.current;
    // An offering can disappear while its original launch still needs attention.
    void client.get(`/applications/${encodeURIComponent(pending.application_key)}/releases/${encodeURIComponent(pending.release_ref)}`, {signal: controller.current?.signal})
      .then(value => { if (ticket === generation.current) setLaunch(ApplicationReleaseViewSchema.parse(value)); })
      .catch(error => { if (ticket === generation.current) setProblem(problemText(error)); });
  }, [items, loading, publicMode, userId, guildKey, client]);
  function closeLaunch() { setLaunch(null); opener.current?.focus(); }
  async function load(next?: string) {
    const ticket = generation.current;
    setLoading(true); setProblem('');
    try {
      const page = ApplicationPageSchema.parse(await client.get(`/applications?guild_key=${encodeURIComponent(guildKey)}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, {signal: controller.current?.signal, skipAuthHandler: publicMode}));
      if (ticket !== generation.current) return;
      setItems(old => next ? [...old, ...page.items] : page.items); setCursor(page.next_cursor);
    } catch (error) {
      if (ticket === generation.current && !(error instanceof ApiError && error.code === 'aborted')) setProblem(problemText(error));
    } finally { if (ticket === generation.current) setLoading(false); }
  }
  async function release(app: ApplicationView) {
    const key = `${app.application_key}:${app.release_ref}`;
    if (openDetail === key) { setOpenDetail(null); return; }
    const ticket = generation.current; setProblem('');
    try {
      const detail = details[key] ?? ApplicationReleaseViewSchema.parse(await client.get(`/applications/${encodeURIComponent(app.application_key)}/releases/${encodeURIComponent(app.release_ref)}`, {signal: controller.current?.signal, skipAuthHandler: publicMode}));
      if (ticket !== generation.current) return;
      setDetails(old => ({...old, [key]: detail})); setOpenDetail(key);
    } catch (error) {
      if (ticket === generation.current && !(error instanceof ApiError && error.code === 'aborted')) setProblem(problemText(error));
    }
  }
  return <div className="launchpad-applications stack">
    {problem && <p role="alert" className="banner banner-error">{problem}<button type="button" className="btn btn-ghost" onClick={() => void load()}>重試</button></p>}
    {loading && <p role="status">正在載入應用…</p>}
    {!loading && !problem && items.length === 0 && <p>此公會目前沒有已核准的應用</p>}
    {items.map(app => {
      const key = `${app.application_key}:${app.release_ref}`;
      const detail = details[key];
      return <article key={key} className="application-card stack">
        <div className="application-heading"><h3>{app.display_name}</h3><span className="pill">{applicationStatus(app)}</span></div>
        <p>版本：{app.release_ref} · 授權：{LICENSE[app.license_state]}</p>
        <p className="field-hint">來源以固定提交與成品摘要核對。</p>
        <div className="application-actions"><button type="button" className="btn btn-ghost" aria-expanded={openDetail === key} onClick={() => void release(app)}>版本資料</button>
          {!publicMode && <button type="button" className="btn btn-ghost" disabled={!app.eligibility?.can_launch} onClick={event => { opener.current = event.currentTarget; setLaunch(app); }}>啟動應用</button>}
        </div>
        {!publicMode && app.eligibility?.reason_codes.map(code => <p key={code} className="field-hint">{REASONS[code]}</p>)}
        {!publicMode && app.eligibility?.reason_codes.includes('tenant_manage_required') && <a className="btn btn-ghost" href="#business">建立或選擇業務空間</a>}
        {openDetail === key && detail && <section className="stack" aria-label={`${app.display_name}版本資料`}>
          <p>來源提交：<code>{detail.source_commit.slice(0, 12)}</code></p>
          <p>成品摘要：<code>{detail.artifact_digest.value.slice(0, 12)}</code></p>
          <p>授權審查：{LICENSE[detail.license_state]} · {detail.license_review_ref ?? '尚無審查參照'}</p>
          <p>技能書參照：{detail.skill_book_refs.join('、') || '未列出'}</p>
          <ul>{detail.module_requirements.map(requirement => <li key={requirement.requirement_key}>{moduleWord(requirement.module_key)}：{requirement.required ? '必要' : '選用'}，{requirement.allow_reuse ? '允許共用既有實例' : '須建立獨立空白實例'}</li>)}</ul>
        </section>}
      </article>;
    })}
    {launch && userId && <LaunchFlow key={`${launch.application_key}:${launch.release_ref}`} client={client} guildKey={guildKey} userId={userId} app={launch} onClose={closeLaunch} onWork={onWork}/>}
    {cursor && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load(cursor)}>載入更多</button>}
    {publicMode && items.length > 0 && <p>登入後可確認啟動資格。{onLogin && <button type="button" className="btn btn-ghost" onClick={onLogin}>登入查看資格</button>}</p>}
  </div>;
}

const SavedLaunchSchema = z.object({
  tenant_id: OpaqueId, workspace_id: OpaqueId, application_key: ApplicationViewSchema.shape.application_key,
  release_ref: ApplicationViewSchema.shape.release_ref, key: z.string().uuid(), input: LaunchInputSchema,
  operation: RegistryOperationSchema.nullable(), application: ApplicationViewSchema.optional(),
}).strict();
type SavedLaunch = z.infer<typeof SavedLaunchSchema>;
type Dependency = z.infer<typeof PlanInputSchema>['dependencies'][number];
type Attempt = {key: string; path: string; body: unknown; ifMatch?: string; kind: 'plan' | 'reconcile' | 'cancel'};
function launchKey(userId: string, guildKey: string) { return `freedom-application-launch:${userId}:${guildKey}`; }
function savedLaunches(userId: string, guildKey: string): SavedLaunch[] {
  try { return z.array(SavedLaunchSchema).parse(JSON.parse(sessionStorage.getItem(launchKey(userId, guildKey)) ?? '[]')); }
  catch { return []; }
}
function storeLaunch(userId: string, guildKey: string, item: SavedLaunch, remove = false) {
  const old = savedLaunches(userId, guildKey).filter(row => row.key !== item.key);
  sessionStorage.setItem(launchKey(userId, guildKey), JSON.stringify(remove ? old : [...old, item]));
}
// These errors reject launch inside its transaction. An authorization/not-found
// error can also come from the route's read after commit, so keep that launch.
const DECLINED_LAUNCH = new Set([
  'plan_stale', 'version_conflict', 'quota_exceeded', 'policy_unconfigured', 'guild_full_member_required',
  'application_not_available', 'license_unresolved', 'instance_unavailable', 'workspace_binding_conflict',
  'workspace_unavailable', 'validation_failed', 'configuration_invalid', 'dependency_cycle',
  'invalid_input', 'invalid_json', 'idempotency_required', 'invalid_version',
  'installation_selection_required', 'dependency_selection_required',
]);
const STATE: Record<RegistryOperation['state'], string> = {
  requested: '已送出', running: '配置中', needs_reconciliation: '結果未確認', succeeded: '已啟用', failed: '失敗', cancelled: '已停止',
};
const WARNING: Record<string, string> = {
  reuse_existing_data: '將共用既有資料，不會複製一份。', creates_empty_instance: '將建立獨立空白資料，使用額外容量。',
};
const DIMENSION: Record<string, string> = {
  module_instances: '模組實例數', 'module_instances.work': '人工工作實例數', concurrent_provisions: '同時配置數',
  retained_bytes: '保存位元組', work_items: '工作數',
};
// Keep domain codes explicit; the original server detail is shown before this next step.
const NEXT: Record<string, string> = {
  plan_stale: '方案已過期，請重新產生。選擇已保留，請核對最新候選與版本。',
  version_conflict: '版本已改變。選擇已保留，請核對最新候選與版本。',
  instance_changed: '實例已改變，請核對最新候選與版本。',
  instance_unavailable: '請選擇另一個可用實例，或建立獨立空白實例。',
  installation_selection_required: '請沿用這個工作區的現有安裝，或選擇另一個工作區。',
  dependency_selection_required: '請明確選擇每個模組實例，再產生方案。',
  instance_selection_required: '請選擇要共用的實例，再產生方案。',
  workspace_binding_conflict: '這個工作區已綁定其他實例，請選擇另一個工作區。',
  workspace_unavailable: '請選擇另一個可用工作區。',
  quota_exceeded: '已達容量上限。既有工作仍可使用，請聯絡業務空間擁有者調整容量。',
  policy_unconfigured: '請聯絡業務空間擁有者設定容量政策。',
  guild_full_member_required: REASONS.guild_full_member_required,
  capability_denied: '請切換到你擁有或管理的業務空間，或聯絡其擁有者。',
  tenant_not_found: '請切換業務空間，並確認目前成員資格。',
  not_found: '請重新載入目前業務空間，確認目標仍可讀取。',
  guild_not_found: '請返回公會列表，選擇可讀取的公會。',
  application_not_available: REASONS.application_not_available,
  license_unresolved: '授權尚未核准，請先閱讀版本資料。',
  idempotency_conflict: '原操作識別碼與內容不一致，已記錄問題。請保留原操作並聯絡支援。',
  operation_not_cancellable: '操作已結束，請查看目前進度。',
  authority_changed: '授權版本已改變，請核對原操作或聯絡支援。',
  dependency_in_use: '依賴仍在使用，請聯絡業務空間擁有者。',
  contract_incompatible: '版本不相容，請選擇其他實例或聯絡支援。',
  dependency_cycle: '依賴形成循環，請聯絡支援核對這個應用版本。',
  configuration_invalid: '此版本無法接受空白設定，請聯絡支援核對版本。',
  invalid_cursor: '分頁已無法讀取，請重新載入清單。',
  invalid_input: '請檢查選擇後再送出。', validation_failed: '請檢查選擇後再送出。', invalid_json: '請重新載入頁面後再送出。',
  idempotency_required: '操作識別碼無效，請聯絡支援。', invalid_version: '版本格式無效，請重新載入原操作。',
  version_required: '缺少版本，請重新載入原操作。',
  login_required: '請重新登入後查看原操作。', session_expired: '請重新登入後查看原操作。',
  dependency_unavailable: '依賴暫時無法回應，請核對原操作。',
  tenant_context_unavailable: '業務空間暫時無法讀取，請稍後查看原操作。',
  failed_known: '請保留操作識別碼並聯絡業務空間擁有者。',
  effect_identity_conflict: '原效果需要支援人員核對，請保留操作識別碼。',
  attempt_limit: '已達核對次數上限，請聯絡支援。', member_cancelled: '已停止後續步驟，既有資料會保留。',
  provider_missing: '提供者暫時無法使用，請核對原操作或聯絡支援。',
  effect_unknown: '原效果尚未確認，請核對原操作；既有資料會保留。',
  foundation_mapping_unavailable: '資源範圍暫時無法讀取，請稍後查看原操作。',
  principal_disabled: '請聯絡支援確認你的身分狀態。', scope_disabled: '請切換業務空間或聯絡其擁有者。',
  tenant_suspended: '請聯絡業務空間擁有者恢復使用。', tenant_recovery_required: '請聯絡業務空間擁有者完成復原。',
  tenant_capability_denied: '請切換到可用的業務空間。',
  invalid_expected_version: '版本格式無效，請重新載入原操作。', invalid_command_json: '請重新載入頁面並核對操作內容。',
  invalid_scoped_command: '請保留操作識別碼並聯絡支援。', invalid_operation: '請保留操作識別碼並聯絡支援。',
  invalid_target: '請重新載入業務空間並核對目標。', scoped_context_required: '請聯絡支援核對操作範圍。',
  scoped_context_active: '請保留操作識別碼並聯絡支援。', internal_error: '請保留原操作並稍後查看進度。',
  host_rejected: '請從目前工作台重新載入頁面。', origin_rejected: '請從目前工作台重新載入頁面。',
  csrf_rejected: '請重新載入頁面後查看原操作。', json_required: '請重新載入頁面後再送出。',
  body_too_large: '內容過長，請重新核對選擇。',
  onboarding_required: '請先選擇主要公會，再返回查看原操作。',
};
function problemText(error: unknown, actionHeld = false) {
  if (!(error instanceof ApiError)) return '回應未能確認，請查看原操作。';
  if (error.network) return `${error.message}${actionHeld ? ' 原操作識別碼已保留。' : ''}`;
  const detail = error.detail ?? error.message;
  const dimension = error.code === 'quota_exceeded' ? Object.keys(DIMENSION).find(key => detail.includes(`（${key}）`) || detail.includes(`(${key})`)) : undefined;
  return `${detail}${dimension ? ` 容量維度：${DIMENSION[dimension]}。` : ''} ${NEXT[error.code ?? ''] ?? '請保留操作識別碼並聯絡支援。'}`;
}
function terminal(operation: RegistryOperation | null) { return operation && ['succeeded', 'failed', 'cancelled'].includes(operation.state); }
function dependencyWords(choice: Dependency) {
  return choice.choice === 'create' ? `另建獨立空白的${moduleWord(choice.requirement_key)}`
    : `共用既有的${moduleWord(choice.requirement_key)}（ID 尾碼 ${choice.instance_id.slice(-6)}，版本 ${choice.expected_version}）`;
}

function LaunchFlow({client, guildKey, userId, app, onClose, onWork}: {
  client: PortalClient; guildKey: string; userId: string; app: ApplicationView; onClose: () => void; onWork?: () => void;
}) {
  const initial = useRef(savedLaunches(userId, guildKey).filter(item => item.application_key === app.application_key && item.release_ref === app.release_ref).at(-1));
  const [tenants, setTenants] = useState<TenantView[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [instances, setInstances] = useState<Record<string, InstanceView[]>>({});
  const [installations, setInstallations] = useState<InstallationView[]>([]);
  const [installationChoice, setInstallationChoice] = useState('');
  const [choices, setChoices] = useState<Record<string, Dependency>>({});
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [pending, setPending] = useState<SavedLaunch | null>(initial.current ?? null);
  const pendingRef = useRef(pending);
  const [installation, setInstallation] = useState<InstallationView | null>(null);
  const [problem, setProblem] = useState('');
  const [changed, setChanged] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState<Attempt | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const abort = useRef(new AbortController());
  const generation = useRef(0);
  const place = useRef({tenantId: '', workspaceId: ''});
  const heading = useRef<HTMLHeadingElement>(null);
  const planHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (plan && !pending) planHeading.current?.focus(); }, [plan, pending]);
  const tenant = tenants.find(item => item.tenant_id === tenantId);
  const workspace = workspaces.find(item => item.workspace_id === workspaceId);
  const operation = pending?.operation ?? null;
  const canManage = tenant?.status === 'active' && ['owner', 'admin'].includes(tenant.my_membership.role);
  function ticket() {
    const value = generation.current; const location = {...place.current}; const signal = abort.current.signal;
    return {signal, live: () => !signal.aborted && value === generation.current && location.tenantId === place.current.tenantId && location.workspaceId === place.current.workspaceId};
  }
  function resetRequests() { abort.current.abort(); abort.current = new AbortController(); generation.current++; busyRef.current = false; setBusy(false); }
  function remember(next: SavedLaunch) {
    storeLaunch(userId, guildKey, next); pendingRef.current = next; setPending(next);
  }
  function close() {
    const held = pendingRef.current;
    if (held && terminal(held.operation)) storeLaunch(userId, guildKey, held, true);
    resetRequests(); onClose();
  }
  async function loadTenants() {
    const call = ticket(); setReadFailed(false); setProblem('');
    try {
      const list: TenantView[] = []; let cursor: string | null = null;
      do {
        const page = TenantPageSchema.parse(await client.get(`/tenants?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {signal: call.signal}));
        if (!call.live()) return;
        list.push(...page.items); cursor = page.next_cursor;
      } while (cursor);
      setTenants(list);
      const stored = readActing(userId);
      const next = list.find(row => row.tenant_id === initial.current?.tenant_id) ?? list.find(row => row.tenant_id === stored.tenant_id) ?? list[0];
      if (next) await selectTenant(next.tenant_id, initial.current?.workspace_id ?? stored.workspace_id);
    } catch (error) { if (call.live()) { setReadFailed(true); setProblem(problemText(error)); } }
  }
  useEffect(() => {
    heading.current?.focus();
    void loadTenants();
    const switched = (event: Event) => {
      const detail = (event as CustomEvent<{userId: string; tenantId: string; workspaceId: string}>).detail;
      if (detail.userId === userId && (detail.tenantId !== place.current.tenantId || detail.workspaceId !== place.current.workspaceId)) { resetRequests(); onClose(); }
    };
    window.addEventListener('freedom-acting-change', switched);
    return () => { abort.current.abort(); generation.current++; window.removeEventListener('freedom-acting-change', switched); };
  }, [client, guildKey, userId, app.application_key]);
  async function selectTenant(id: string, preferred?: string | null) {
    resetRequests(); place.current = {tenantId: id, workspaceId: ''};
    setTenantId(id); setWorkspaceId(''); setWorkspaces([]); clearPrivate();
    const call = ticket();
    try {
      const list: WorkspaceView[] = []; let cursor: string | null = null;
      do {
        const page = WorkspacePageSchema.parse(await client.get(`/tenants/${id}/workspaces?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {signal: call.signal}));
        if (!call.live()) return;
        list.push(...page.items.filter(item => item.status === 'active')); cursor = page.next_cursor;
      } while (cursor);
      setWorkspaces(list);
      const next = list.find(item => item.workspace_id === preferred) ?? list[0];
      if (next) await selectWorkspace(id, next.workspace_id);
    } catch (error) { if (call.live()) { setReadFailed(true); setProblem(problemText(error)); } }
  }
  function clearPrivate() {
    setInstances({}); setInstallations([]); setChoices({}); setInstallationChoice(''); setPlan(null); setInstallation(null);
    setPending(null); pendingRef.current = null; setProblem(''); setChanged(''); setReady(false); setRetry(null); setReadFailed(false); attempt.current = null;
  }
  async function selectWorkspace(id: string, workspace: string) {
    resetRequests(); clearPrivate(); place.current = {tenantId: id, workspaceId: workspace}; setWorkspaceId(workspace);
    rememberActing(userId, id, workspace, true);
    const held = savedLaunches(userId, guildKey).find(item => item.tenant_id === id && item.workspace_id === workspace && item.application_key === app.application_key);
    if (held) { pendingRef.current = held; setPending(held); if (held.operation) await progress(held); return; }
    await candidates(false);
  }
  async function candidates(keep: boolean) {
    const call = ticket(); const {tenantId: id, workspaceId: workId} = place.current;
    setReady(false);
    const currentTenant = tenants.find(item => item.tenant_id === id);
    // During initial load, tenants state is not committed yet; the server still checks authority.
    if (currentTenant && !['owner', 'admin'].includes(currentTenant.my_membership.role)) return;
    try {
      const existing: InstallationView[] = []; let cursor: string | null = null;
      do {
        const page = InstallationPageSchema.parse(await client.get(`/tenants/${id}/application-installations?application_key=${encodeURIComponent(app.application_key)}&workspace_id=${workId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {signal: call.signal}));
        if (!call.live()) return;
        existing.push(...page.items.filter(item => !['archived','failed'].includes(item.status))); cursor = page.next_cursor;
      } while (cursor);
      const found: Record<string, InstanceView[]> = {};
      for (const requirement of app.module_requirements) {
        const rows: InstanceView[] = []; cursor = null;
        do {
          const page = InstancePageSchema.parse(await client.get(`/tenants/${id}/module-instances?module_key=${encodeURIComponent(requirement.module_key)}&status=active${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {signal: call.signal}));
          if (!call.live()) return;
          rows.push(...page.items); cursor = page.next_cursor;
        } while (cursor);
        found[requirement.requirement_key] = rows;
      }
      if (!call.live()) return;
      setInstances(found); setInstallations(existing); setReadFailed(false);
      if (!keep) {
        setInstallationChoice(existing.length === 1 ? existing[0].installation_id : existing.length === 0 ? 'create_new' : '');
        const defaults: Record<string, Dependency> = {};
        for (const requirement of app.module_requirements) {
          const rows = requirement.allow_reuse ? found[requirement.requirement_key] : [];
          const candidate = rows.length === 1 ? rows[0] : null;
          if (candidate) defaults[requirement.requirement_key] = {requirement_key: requirement.requirement_key, choice: 'reuse', instance_id: candidate.instance_id, expected_version: candidate.version};
          else if (rows.length === 0) defaults[requirement.requirement_key] = {requirement_key: requirement.requirement_key, choice: 'create', configuration: {}};
        }
        setChoices(defaults);
      }
      setReady(true);
    } catch (error) { if (call.live()) { setReadFailed(true); setProblem(problemText(error)); } }
  }
  async function runAction(next: Attempt) {
    if (busyRef.current) return;
    attempt.current = next; setRetry(null); setProblem(''); busyRef.current = true; setBusy(true);
    const call = ticket();
    try {
      const result = await client.post(next.path, next.body, {idempotencyKey: next.key, ifMatch: next.ifMatch, signal: call.signal});
      if (!call.live()) return;
      if (next.kind === 'plan') setPlan(LaunchPlanSchema.parse(result));
      else if (pendingRef.current) { const held = {...pendingRef.current, operation: RegistryOperationSchema.parse(result)}; remember(held); await showInstallation(held, call); }
      attempt.current = null;
    } catch (error) {
      if (!call.live()) return;
      setProblem(problemText(error, true));
      if (error instanceof ApiError && error.network) { setRetry(next); return; }
      // PortalClient reports this bug through the existing client-error path.
      if (error instanceof ApiError && error.code === 'idempotency_conflict') { setRetry(null); return; }
      attempt.current = null;
      if (error instanceof ApiError && (error.status === 412 || ['plan_stale','instance_changed','instance_unavailable','installation_selection_required','dependency_selection_required'].includes(error.code ?? ''))) {
        setPlan(null); setChanged(NEXT[error.code ?? ''] ?? NEXT.version_conflict);
        if (next.kind === 'plan') await candidates(true); else if (pendingRef.current) await progress(pendingRef.current);
      }
    } finally { if (call.live()) { busyRef.current = false; setBusy(false); } }
  }
  async function makePlan() {
    if (!ready || !canManage || busyRef.current || pendingRef.current || attempt.current) return;
    const input = PlanInputSchema.parse({guild_key: guildKey, workspace_id: workspaceId, application_key: app.application_key, release_ref: app.release_ref,
      installation_choice: installationChoice === 'create_new' ? 'create_new' : 'reuse_existing',
      ...(installationChoice !== 'create_new' ? {existing_installation_id: installationChoice} : {}),
      dependencies: app.module_requirements.map(item => choices[item.requirement_key]), configuration: {},
    });
    await runAction({key: crypto.randomUUID(), path: `/tenants/${tenantId}/application-launch-plans`, body: input, kind: 'plan'});
  }
  async function confirm() {
    if (!plan || busyRef.current || pendingRef.current) return;
    const held: SavedLaunch = {tenant_id: tenantId, workspace_id: workspaceId, application_key: app.application_key, release_ref: app.release_ref, application: app,
      input: {plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest}, key: crypto.randomUUID(), operation: null};
    try { remember(held); } catch { setProblem('瀏覽器無法保留原操作，請允許分頁儲存後再啟動。'); return; }
    await launchOriginal(held);
  }
  async function launchOriginal(held: SavedLaunch) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setProblem(''); const call = ticket();
    try {
      const operation = RegistryOperationSchema.parse(await client.post(`/tenants/${held.tenant_id}/application-installations`, held.input, {idempotencyKey: held.key, signal: call.signal}));
      if (!call.live()) return;
      const next = {...held, operation}; remember(next); await showInstallation(next, call);
    } catch (error) {
      if (!call.live()) return;
      setProblem(problemText(error, true));
      if (error instanceof ApiError && !error.network && DECLINED_LAUNCH.has(error.code ?? '')) {
        storeLaunch(userId, guildKey, held, true); pendingRef.current = null; setPending(null); setPlan(null);
        await candidates(true);
        if (['plan_stale','version_conflict'].includes(error.code ?? '')) setChanged(NEXT.plan_stale);
      }
    } finally { if (call.live()) { busyRef.current = false; setBusy(false); } }
  }
  async function showInstallation(held: SavedLaunch, call: ReturnType<typeof ticket>) {
    if (held.operation?.state !== 'succeeded') return;
    // A failed follow-up read does not change the confirmed command outcome.
    try {
      const result = InstallationViewSchema.parse(await client.get(`/tenants/${held.tenant_id}/application-installations/by-operation/${held.operation.operation_id}`, {signal: call.signal}));
      if (call.live()) setInstallation(result);
    } catch (error) { if (call.live()) setProblem(problemText(error)); }
  }
  async function progress(held = pendingRef.current) {
    if (!held) return;
    if (!held.operation) { await launchOriginal(held); return; }
    const call = ticket(); setProblem('');
    try {
      const result = RegistryOperationSchema.parse(await client.get(`/tenants/${held.tenant_id}/operations/${held.operation.operation_id}`, {signal: call.signal, background: true}));
      if (!call.live()) return;
      const next = {...held, operation: result}; remember(next); await showInstallation(next, call);
    } catch (error) { if (call.live()) setProblem(problemText(error, true)); }
  }
  useEffect(() => {
    if (!pending?.operation || !['requested','running'].includes(pending.operation.state)) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let backoff = 2;
    const schedule = () => {
      const held = pendingRef.current;
      if (cancelled || !held?.operation || !['requested','running'].includes(held.operation.state)) return;
      timer = setTimeout(() => { void progress(held).finally(() => { backoff = Math.min(10, backoff * 2); schedule(); }); }, Math.max(2, backoff, held.operation.retry_after_seconds ?? 2) * 1000);
    };
    schedule(); return () => { cancelled = true; clearTimeout(timer); };
  }, [pending?.key, operation?.state, tenantId]);
  async function control(kind: 'reconcile' | 'cancel') {
    const held = pendingRef.current;
    if (!held?.operation || busyRef.current || attempt.current) return;
    await runAction({key: crypto.randomUUID(), path: `/tenants/${held.tenant_id}/operations/${held.operation.operation_id}/${kind}`,
      body: kind === 'cancel' ? {reason: 'member_cancelled'} : {}, ifMatch: held.operation.version, kind});
  }
  const decided = app.module_requirements.every(item => {
    const choice = choices[item.requirement_key];
    return choice && (choice.choice === 'create' || instances[item.requirement_key]?.some(row => row.instance_id === choice.instance_id && row.version === choice.expected_version));
  });
  return <section className="application-flow stack" aria-label="啟動應用" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <div className="application-heading"><h3 ref={heading} tabIndex={-1}>啟動{app.display_name}</h3><button type="button" className="btn btn-ghost" onClick={close}>取消</button></div>
    <p>{app.release_ref}</p>
    {tenants.length > 0 && <TenantSelector tenants={tenants} selectedId={tenantId} onSelect={id => { if (id !== tenantId) void selectTenant(id); }}/ >}
    {tenant && <p>目前業務空間：{tenant.display_name} · {roleLabel(tenant.my_membership.role)}{workspace && `／${workspace.name}`}</p>}
    {tenants.length === 0 && <p>你還沒有業務空間。<a className="btn btn-ghost" href="#business">建立或選擇業務空間</a></p>}
    {tenant && !canManage && <p>{NEXT.capability_denied}</p>}
    {problem && <p role="alert" className="banner banner-error">{problem}</p>}
    {changed && <div role="status"><p>{changed}</p><ul>{Object.entries(instances).flatMap(([key, rows]) => rows.map(row => <li key={`${key}:${row.instance_id}`}>{moduleWord(key)}：ID 尾碼 {row.instance_id.slice(-6)}，最新版本 {row.version}，{INSTANCE_STATUS_WORDS[row.status]}</li>))}</ul></div>}
    {retry && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void runAction(retry)}>重試</button>}
    {readFailed && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => tenantId && workspaceId ? void candidates(true) : void loadTenants()}>重新載入清單</button>}
    {canManage && !pending && !plan && <>
      <fieldset className="fieldset"><legend>工作區</legend><div className="application-actions">{workspaces.map(item => <button type="button" key={item.workspace_id} className="btn btn-ghost" aria-current={item.workspace_id === workspaceId ? 'true' : undefined} onClick={() => { if (item.workspace_id !== workspaceId) void selectWorkspace(tenantId, item.workspace_id); }}>{item.name}</button>)}</div></fieldset>
      {!ready && <p role="status">正在載入可用實例…</p>}
      {ready && <>
        {installations.length > 0 && <fieldset className="fieldset"><legend>安裝選擇</legend>
          {installations.map(item => <label key={item.installation_id} className="application-choice"><input type="radio" name="installation" checked={installationChoice === item.installation_id} disabled={busy || Boolean(retry)} onChange={() => { setInstallationChoice(item.installation_id); const next: Record<string, Dependency> = {}; for (const link of item.modules) { const row = instances[link.requirement_key]?.find(candidate => candidate.instance_id === link.instance_id); if (row) next[link.requirement_key] = {requirement_key: link.requirement_key, choice: 'reuse', instance_id: row.instance_id, expected_version: row.version}; } setChoices(next); }}/><span>沿用這個安裝（ID 尾碼 {item.installation_id.slice(-6)}，版本 {item.version}，{INSTANCE_STATUS_WORDS[item.status]}）</span></label>)}
          <button type="button" className="btn btn-ghost" disabled>另建新的安裝</button><p className="field-hint">這個版本每個工作區只允許一個現有安裝；請選擇另一個工作區建立新安裝。</p>
        </fieldset>}
        {app.module_requirements.map(requirement => <fieldset className="fieldset" key={requirement.requirement_key}><legend>{moduleWord(requirement.module_key)}（{requirement.required ? '必要' : '選用'}）</legend>
          {requirement.allow_reuse && (instances[requirement.requirement_key] ?? []).map(row => <label key={row.instance_id} className="application-choice"><input type="radio" name={`dependency-${requirement.requirement_key}`} disabled={busy || Boolean(retry)} checked={choices[requirement.requirement_key]?.choice === 'reuse' && (choices[requirement.requirement_key] as Extract<Dependency, {choice: 'reuse'}>).instance_id === row.instance_id && (choices[requirement.requirement_key] as Extract<Dependency, {choice: 'reuse'}>).expected_version === row.version} onChange={() => setChoices(old => ({...old, [requirement.requirement_key]: {requirement_key: requirement.requirement_key, choice: 'reuse', instance_id: row.instance_id, expected_version: row.version}}))}/><span>將共用既有的{moduleWord(requirement.module_key)}（ID 尾碼 {row.instance_id.slice(-6)}，版本 {row.version}，{INSTANCE_STATUS_WORDS[row.status]}）</span></label>)}
          <label className="application-choice"><input type="radio" name={`dependency-${requirement.requirement_key}`} disabled={busy || Boolean(retry)} checked={choices[requirement.requirement_key]?.choice === 'create'} onChange={() => setChoices(old => ({...old, [requirement.requirement_key]: {requirement_key: requirement.requirement_key, choice: 'create', configuration: {}}}))}/><span>另建獨立空白的{moduleWord(requirement.module_key)}</span></label>
          <p className="field-hint">新實例不複製既有資料，會使用額外容量。</p>
        </fieldset>)}
        <button type="button" className="btn btn-primary application-primary" disabled={busy || Boolean(attempt.current) || !installationChoice || !decided} onClick={() => void makePlan()}>產生啟動方案</button>
      </>}
    </>}
    {plan && !pending && <section className="stack" aria-label="確認啟動方案">
      <h4 ref={planHeading} tabIndex={-1}>確認啟動方案</h4><p>{tenant?.display_name}／{workspace?.name} · {app.display_name} · {plan.release_ref}</p>
      <p>{installationChoice === 'create_new' ? '建立新安裝' : `沿用安裝（ID 尾碼 ${installationChoice.slice(-6)}）`}</p>
      <ul>{plan.choices.map(choice => <li key={choice.requirement_key}>{dependencyWords(choice)}</li>)}</ul>
      <p>容量變化</p><ul>{plan.capacity_delta.length ? plan.capacity_delta.map(item => <li key={item.dimension}>{DIMENSION[item.dimension] ?? item.dimension}：+{item.units}</li>) : <li>不增加實例容量</li>}</ul>
      <ul>{plan.warnings.map((item, index) => <li key={index}>{item.requirement_key && `${moduleWord(item.requirement_key)}：`}{WARNING[item.code] ?? `${item.code}：請在確認前核對這個提醒。`}</li>)}</ul>
      <p>有效期限：<time dateTime={plan.expires_at}>{formatIsoLocal(plan.expires_at)}</time></p>
      <div className="application-actions"><button type="button" className="btn btn-primary application-primary" disabled={busy} onClick={() => void confirm()}>確認啟動</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>修改選擇</button></div>
    </section>}
    {pending && <section className="stack" aria-label="啟動進度">
      <p aria-live="polite">{tenant?.display_name}／{workspace?.name} · {operation ? STATE[operation.state] : '結果未確認'}</p>
      {operation && <p>操作識別碼：<code>{operation.operation_id}</code> · 版本 {operation.version}</p>}
      {operation?.problem && <p role="alert">{operation.problem.detail} {NEXT[operation.problem.code] ?? '請保留操作識別碼並聯絡支援。'}</p>}
      {!terminal(operation) && <div className="application-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void progress()}>查看進度</button>
        <button type="button" className="btn btn-ghost" disabled={busy || !operation || Boolean(attempt.current)} onClick={() => void control('reconcile')}>核對原操作</button>
        <button type="button" className="btn btn-ghost" disabled={busy || !operation || Boolean(attempt.current)} onClick={() => void control('cancel')}>停止後續步驟</button>
        {!operation && <p>尚未取得操作識別碼。查看進度會以原識別碼核對原請求；取得操作後才能核對或停止後續步驟。</p>}
      </div>}
      {operation?.state === 'succeeded' && <>
        {installation ? <><p>安裝 ID 尾碼 {installation.installation_id.slice(-6)} · {INSTANCE_STATUS_WORDS[installation.status]}</p><ul>{installation.modules.map(item => <li key={item.requirement_key}>{moduleWord(item.requirement_key)}：ID 尾碼 {item.instance_id.slice(-6)}</li>)}</ul>
          {app.application_key === 'manual-workspace' && <button type="button" className="btn btn-ghost" onClick={() => { rememberActing(userId, pending.tenant_id, pending.workspace_id, true); close(); onWork?.(); }}>前往我的工作</button>}</>
          : <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void progress()}>查看安裝</button>}
      </>}
    </section>}
  </section>;
}
