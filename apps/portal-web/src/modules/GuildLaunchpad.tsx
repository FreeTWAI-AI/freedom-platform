import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {hasLoneSurrogate, recommendedApplications, type FieldError} from '../../../../contracts/guild-launchpad/v1/config';
import {parseConfig, convertV1, type Config, type ConfigView} from '../../../../contracts/guild-launchpad/v2/config';
import {canReplaceLaunchpadLayout} from '../../../../modules/guild-workspace/launchpad-layout-guards';
import {GuildBlock, type GuildBlockLoaders} from '../guild-blocks/runtime';
import {LaunchpadApplicationSchema, type LaunchpadApplication} from '../../../../contracts/guild-launchpad/v1/module-registry';
import {ApiError, type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import type {GuildSummary} from './Onboarding';
import {useModuleMutation} from './shared';
import {MyWorkPanel, rememberActing} from './GuildLaunchpadMyWork';
import {GuildLaunchpadApplications, startable, type LaunchRequest} from './GuildLaunchpadApplications';
import {LegacyLaunchpadPrimary, legacyPrimaryLabel, legacyPrimaryVisible, legacyStorePath, legacyWorkNavigationGuard} from '../../../../modules/guild-workspace/LegacyLaunchpadPrimary';
import './GuildLaunchpad.css';

const CONTROL = /[\u0000-\u001F\u007F\u0080-\u009F]/;
const EMPTY_BLOCK_LOADERS: GuildBlockLoaders = Object.freeze({});
const FIELD_MESSAGE: Record<string, string> = {
  too_short: '不能是空白',
  too_long: '超過長度上限',
  version_invalid: '版本號格式不正確',
  control_character: '不能包含換行或控制字元',
  lone_surrogate: '包含不成對的字元',
  invalid_order: '順序必須是 0 到 1000 的不重複整數',
  enabled_locked: '這個區塊不能關閉',
  unsupported_url: '只接受 https:// 開頭、不含帳號密碼的網址',
  unknown_field: '不能包含未定義的欄位',
  block_kind_invalid: '區塊種類不正確',
  block_kind_duplicate: '區塊種類重複',
  block_kind_missing: '缺少必要的區塊',
  block_set_invalid: '版面必須包含七種區塊各一次',
  block_version_unavailable: '這個區塊版本尚未核准或已無法使用',
  application_release_unknown: '這個應用版本尚未核准',
  application_duplicate: '這個應用已在推薦清單中',
  guild_key_mismatch: '公會代碼與網址不一致',
  schema_version_invalid: '配置版本不正確',
  config_too_large: '配置內容過大',
  stable_key_invalid: '識別碼格式不正確',
  capability_duplicate: '能力不能重複',
  capabilities_invalid: '能力清單不正確',
  delegation_recipient_invalid: '授權對象必須是這個公會的有效成員',
  delegation_expiry_invalid: '授權到期時間必須是未來的時間',
};
const BLOCK_LABEL: Record<Config['blocks'][number]['kind'], string> = {
  mission: '使命', announcements: '公告', skill_books: '技能書', applications: '應用',
  community_tasks: '公共任務', my_work: '我的工作', support: '協助', extension: '公會工具',
};
const OPTIONAL = new Set<Config['blocks'][number]['kind']>(['announcements', 'community_tasks', 'applications', 'extension']);
const INTERN_HINT = '你是這個公會的實習成員：可以閱讀公會內容、在公會聊天室聊天。想發布或編輯，可以在聊天室跟會長打聲招呼，會長能把你設為正式成員。';
const CAPABILITY_LABEL: Record<string, string> = {
  'guild.content.edit': '編輯內容', 'guild.config.preview': '預覽配置', 'guild.config.publish': '發布配置',
};

type BookRef = {book_id: string; title: string; introduction_url: string | null; upstream_url: string};
type AnnouncementRef = {announcement_id: string; title: string; body: string; published_at: string | null};
type ConfigProblem = {code: 'config_schema_unsupported'; revision: string} | null;
type RevisionMeta = {revision: string; status: string; source: string; created_at: string; revert_reason: string | null; reverted_from_revision: string | null};
type DelegationRow = {delegation_id: string; principal_id: string; capabilities: string[]; expires_at: string; expired: boolean; status: string; version: string; display_name: string};
type Candidate = {display_name: string; principal_id: string | null};
type LeaderConfig = ConfigView & {
  viewer_can_edit_config: boolean;
  viewer_can_preview_config: boolean;
  viewer_can_publish_config: boolean;
  viewer_can_manage_delegations: boolean;
  revisions: RevisionMeta[];
  config_problem: ConfigProblem;
  delegations?: DelegationRow[];
  delegation_candidates?: Candidate[];
};
type MemberView = {
  guild: {guild_key: string; name: string; purpose: string};
  config: ConfigView;
  config_problem: ConfigProblem;
  membership: {state: string; member_tier: string};
  announcements: AnnouncementRef[];
  skill_books: BookRef[];
  applications: LaunchpadApplication[];
  viewer_can_edit_config: boolean;
  viewer_can_preview_config: boolean;
  viewer_can_publish_config: boolean;
  viewer_can_manage_delegations: boolean;
};
type PublicView = {
  guild: {guild_key: string; name: string; purpose: string; category: null};
  config: {revision: string; body: Omit<Config, 'extensions'>};
  config_problem: ConfigProblem;
  announcements: AnnouncementRef[];
  skill_books: BookRef[];
};
type PreviewResult = {effective_config: Config; validation: FieldError[]; preview_data_origin: 'synthetic_fixture'};

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function asConfig(guildKey: string, body: {schema_version?: Config['schema_version']; mission_override?: string | null; blocks: Config['blocks']; application_refs: Config['application_refs']; starter?: Config['starter']; support?: Config['support']}): Config {
  return parseConfig({
    schema_version: body.schema_version ?? 'guild-launchpad.config/v1',
    guild_key: guildKey,
    mission_override: body.mission_override ?? null,
    blocks: [...body.blocks].sort((a, b) => a.order - b.order).map((block, order) => ({...block, order})),
    application_refs: [...body.application_refs].sort((a, b) => a.order - b.order).map((ref, order) => ({...ref, order})),
    starter: body.starter ?? {title_label: '', objective_hint: '', note_hint: ''},
    support: body.support ?? {kind: 'platform_help', public_url: null},
    extensions: {},
  }, guildKey);
}
function fieldHits(errors: FieldError[], path: string): FieldError[] {
  return errors.filter(error => error.path === path || error.path.endsWith(`.${path}`) || error.path.startsWith(`${path}.`) || error.path.startsWith(`body.${path}.`));
}
function fieldMessage(code: string): string {
  return FIELD_MESSAGE[code] ?? '這個欄位格式不正確';
}
function describedBy(errors: FieldError[], path: string, errorId: string, hintId?: string): string | undefined {
  const ids: string[] = [];
  if (hintId) ids.push(hintId);
  if (fieldHits(errors, path).length) ids.push(errorId);
  return ids.length ? ids.join(' ') : undefined;
}
function looseText(error: FieldError, draft: Config): string {
  const message = fieldMessage(error.code);
  const path = error.path.replace(/^body\./, '');
  const indexed = /^blocks\.(\d+)(?:\.|$)/.exec(path);
  if (indexed) {
    const kind = draft.blocks[Number(indexed[1])]?.kind;
    const label = kind && Object.hasOwn(BLOCK_LABEL, kind) ? `${BLOCK_LABEL[kind]}區塊` : '區塊';
    return `${label}：${message}`;
  }
  if (path === 'blocks' || path.startsWith('blocks.')) return `版面區塊：${message}`;
  const application = /^application_refs\.(\d+)(?:\.|$)/.exec(path);
  if (application) return `推薦應用 ${draft.application_refs[Number(application[1])]?.application_key ?? ''}：${message}`;
  if (path === 'application_refs' || path.startsWith('application_refs.')) return `推薦應用清單：${message}`;
  return message;
}
function blockedReason(value: string): boolean {
  return value.trim().length < 3 || CONTROL.test(value) || hasLoneSurrogate(value);
}

export function MyWorkUnavailable({visitor, starter}: {visitor: boolean; starter?: Config['starter'] | null}) {
  if (visitor) return <p>登入並加入公會後，可以在這裡看到自己的工作。</p>;
  return <div className="stack">
    <p>業務空間尚未在此環境啟用</p>
    <p>這個環境還沒有開啟公會業務空間，所以這裡不能建立或保存工作。</p>
    {starter && <dl className="detail-list">
      <div><dt>標題</dt><dd>{starter.title_label}</dd></div>
      <div><dt>目標</dt><dd>{starter.objective_hint}</dd></div>
      <div><dt>筆記</dt><dd>{starter.note_hint}</dd></div>
    </dl>}
  </div>;
}

type LaunchpadSection = {id: string; label: string; group: '工作' | '公會資源' | '管理'};
const INFO_KINDS = new Set<Config['blocks'][number]['kind']>(['mission', 'announcements', 'community_tasks', 'support']);
function blockSection(block: Config['blocks'][number]): string {
  return INFO_KINDS.has(block.kind) ? 'information' : `block:${block.id}`;
}
function launchpadSections(guildKey: string, config: Config, applications: LaunchpadApplication[], member: boolean, editor: boolean): LaunchpadSection[] {
  const blocks = [...config.blocks].filter(block => block.enabled).sort((a, b) => a.order - b.order);
  const primary = recommendedApplications(config.application_refs, applications)[0];
  const dedicated = member && !blocks.some(block => block.kind === 'extension') && primary
    && legacyPrimaryVisible(primary, blocks.some(block => block.kind === 'applications'));
  const sections: LaunchpadSection[] = dedicated ? [{id: 'primary', label: legacyPrimaryLabel(guildKey, primary), group: '工作'}] : [];
  for (const block of blocks) {
    const id = blockSection(block);
    if (sections.some(section => section.id === id)) continue;
    sections.push({id, label: id === 'information' ? '公會資訊' : block.kind === 'extension' ? block.title || '公會工具'
      : block.kind === 'applications' ? '工具目錄' : BLOCK_LABEL[block.kind],
      group: block.kind === 'my_work' || block.kind === 'extension' ? '工作' : '公會資源'});
  }
  if (editor) sections.push({id: 'management', label: '管理啟動台', group: '管理'});
  return sections;
}

function Reading({guild, config, announcements, skillBooks, applications, visitor, memberTier, mode, client, guildKey, userId, registerLeave, registerPendingLeave, canLeave, canNavigate, onLogin, blockLoaders, supplierConsoleEnabled, activeSection, selectSection}: {
  activeSection: string;
  selectSection: (section: string) => void;
  guild: {name: string; purpose: string};
  config: Config;
  announcements: AnnouncementRef[];
  skillBooks: BookRef[];
  applications: LaunchpadApplication[];
  visitor: boolean;
  onLogin?: () => void;
  blockLoaders: GuildBlockLoaders;
  memberTier?: string;
  supplierConsoleEnabled?: boolean;
  mode: 'public' | 'member';
  client: PortalClient;
  guildKey: string;
  userId?: string;
  registerLeave: (guard: (() => boolean) | null) => void;
  registerPendingLeave: (guard: (() => boolean) | null) => void;
  canLeave: () => boolean;
  canNavigate: () => boolean;
}) {
  const [workRefresh, setWorkRefresh] = useState(0);
  const workSection = useRef<HTMLElement | null>(null);
  const [launchRequest, setLaunchRequest] = useState<LaunchRequest | undefined>();
  const [launching, setLaunching] = useState(false);
  const focusWork = () => {
    const work = config.blocks.find(block => block.kind === 'my_work' && block.enabled);
    if (work) selectSection(blockSection(work));
    requestAnimationFrame(() => {workSection.current?.focus();});
  };
  const returnSection = useRef<string | null>(null);
  const applicationsSection = useRef<HTMLElement | null>(null);
  const focusAfterReveal = useRef(false);
  const focusAfterReturn = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (focusAfterReveal.current && applicationsSection.current && !applicationsSection.current.hidden) {
      focusAfterReveal.current = false;
      applicationsSection.current.querySelector<HTMLElement>('.application-flow h3')?.focus();
    }
    if (focusAfterReturn.current) {
      focusAfterReturn.current.focus();
      focusAfterReturn.current = null;
    }
  }, [activeSection]);
  const onLaunchStateChange = useCallback((active: boolean, returnFocus?: HTMLButtonElement | null) => {
    setLaunching(active);
    if (active) {
      const applications = config.blocks.find(block => block.kind === 'applications' && block.enabled);
      if (applications) {
        if (activeSection !== blockSection(applications)) {
          returnSection.current = activeSection;
          focusAfterReveal.current = true;
          selectSection(blockSection(applications));
        } else applicationsSection.current?.querySelector<HTMLElement>('.application-flow h3')?.focus();
      }
    } else if (returnSection.current) {
      focusAfterReturn.current = returnFocus ?? null;
      selectSection(returnSection.current); returnSection.current = null;
    } else returnFocus?.focus();
  }, [config.blocks, activeSection, selectSection]);
  const showWork = (tenantId: string, workspaceId: string) => {
    if (!canLeave() || !userId) return false;
    rememberActing(userId, tenantId, workspaceId); setWorkRefresh(value => value + 1);
    const work = config.blocks.find(block => block.kind === 'my_work' && block.enabled);
    if (work) {returnSection.current = blockSection(work); selectSection(blockSection(work));}
    return true;
  };
  const showStore = (tenantId: string, instanceId: string) => {
    if (!canNavigate()) return false;
    window.location.hash = legacyStorePath(guildKey, tenantId, instanceId); return true;
  };
  useEffect(() => { if (workRefresh) focusWork(); }, [workRefresh]);
  const blocks = [...config.blocks].sort((a, b) => a.order - b.order).filter(block => block.enabled || config.schema_version === 'guild-launchpad.config/v1' && !OPTIONAL.has(block.kind));
  const primary = recommendedApplications(config.application_refs, applications)[0];
  const showPrimary = !blocks.some(block => block.kind === 'extension') && !visitor && mode === 'member' && Boolean(userId) && primary
    && legacyPrimaryVisible(primary, blocks.some(block => block.kind === 'applications'));
  return <>
    {showPrimary && <div hidden={activeSection !== 'primary'}><LegacyLaunchpadPrimary primary={primary} config={config} guildKey={guildKey} memberTier={memberTier} internHint={INTERN_HINT} client={client}
      focusWork={focusWork} canLeave={canLeave} canNavigate={canNavigate} launchRequest={launchRequest} setLaunchRequest={setLaunchRequest}/></div>}
    {blocks.map(block => <section key={block.id} hidden={activeSection !== blockSection(block)} className="guild-launchpad-block" ref={block.kind === 'my_work' ? workSection : block.kind === 'applications' ? applicationsSection : undefined} tabIndex={block.kind === 'my_work' ? -1 : undefined}>
      {block.kind !== 'extension' && !(block.kind === 'applications' && launching) && <><h2>{block.kind === 'applications' ? '工具目錄' : BLOCK_LABEL[block.kind]}</h2>{block.title && <p>{block.title}</p>}</>}
      {block.kind === 'extension' && <GuildBlock id={block.extension_id} heading={block.title} loaders={blockLoaders} client={client} guildKey={guildKey}
        viewer={visitor || mode === 'public' ? 'visitor' : memberTier === 'full' ? 'member' : 'read_only'}
        navigate={path => {if (canNavigate()) window.location.hash = path;}}
        startableApplications={applications.filter(startable).map(app => app.application_key)}
        supplierConsoleEnabled={supplierConsoleEnabled === true}
        startApplication={memberTier === 'full' && blocks.some(item => item.kind === 'applications') ? key => {
          const app = applications.find(item => item.application_key === key);
          if (app && startable(app) && canLeave()) setLaunchRequest({application_key: app.application_key, release_ref: app.release_ref, nonce: (launchRequest?.nonce ?? 0) + 1});
        } : undefined}/>}
      {block.kind === 'mission' && <p>{config.mission_override ?? guild.purpose}</p>}
      {block.kind === 'announcements' && (announcements.length
        ? <ul>{announcements.map(item => <li key={item.announcement_id}><strong>{item.title}</strong><p>{item.body}</p></li>)}</ul>
        : <p>目前沒有公告。</p>)}
      {block.kind === 'skill_books' && <div className="guild-launchpad-books">{skillBooks.length ? skillBooks.map(book => {
        const intro = httpsUrl(book.introduction_url);
        const upstream = httpsUrl(book.upstream_url);
        return <p key={book.book_id}>{book.title}{intro && <> · <a href={intro} rel="noopener noreferrer" target="_blank">閱讀介紹</a></>}{upstream && <> · <a href={upstream} rel="noopener noreferrer" target="_blank">上游</a></>}</p>;
      }) : <p className="muted">目前沒有可顯示的技能書。</p>}</div>}
      {block.kind === 'applications' && <GuildLaunchpadApplications client={client} guildKey={guildKey} publicMode={mode === 'public' || !userId} userId={userId} onLogin={onLogin} onWork={showWork} onStore={showStore} canLeave={canLeave} registerPendingLeave={registerPendingLeave} visitor={visitor} recommendedRefs={config.application_refs} launchRequest={launchRequest} onLaunchStateChange={onLaunchStateChange}/>}
      {block.kind === 'community_tasks' && <p>目前沒有可顯示的公共任務。</p>}
      {block.kind === 'my_work' && (visitor || mode === 'public'
        ? <MyWorkUnavailable visitor={visitor || mode === 'public'} starter={visitor || mode === 'public' ? null : config.starter}/>
        : memberTier === 'full'
          ? <MyWorkPanel key={workRefresh} client={client} guildKey={guildKey} userId={userId} starter={config.starter} registerLeave={registerLeave} canNavigate={legacyWorkNavigationGuard(guildKey) ? canNavigate : undefined}/>
          : <p className="field-hint" role="status">{INTERN_HINT}</p>)}
      {block.kind === 'support' && <SupportLine support={config.support}/>}
    </section>)}
  </>;
}
function SupportLine({support}: {support: Config['support']}) {
  const href = httpsUrl(support.public_url);
  if (href) return <p><a href={href} rel="noopener noreferrer" target="_blank">{support.kind === 'guild_public_contact' ? '公會公開聯絡' : '平台說明'}</a></p>;
  if (support.kind === 'guild_public_contact') return <p>這個公會尚未提供公開聯絡方式。</p>;
  return <p>需要協助時，可開啟頁面工具中的「頁面說明」。</p>;
}

export function PublicGuildLaunchpad({client, guildKey, onLogin, pageTools, blockLoaders = EMPTY_BLOCK_LOADERS}: {client: PortalClient; guildKey: string; onLogin: () => void; pageTools?: ReactNode; blockLoaders?: GuildBlockLoaders}) {
  return <div className="guild-launchpad-public">
    <header><img src="/brand/freedom-workshop.webp" alt="自由工坊" width={1280} height={720}/><div className="guild-launchpad-public-tools">{pageTools}<button type="button" className="btn btn-ghost" onClick={onLogin}>會員登入</button></div></header>
    <main><GuildLaunchpad client={client} guildKey={guildKey} mode="public" onLogin={onLogin} blockLoaders={blockLoaders}/></main>
  </div>;
}

export function GuildLaunchpad({client, guildKey, mode, onBack, onLogin, userId, registerPendingLeave, supplierConsoleEnabled, blockLoaders = EMPTY_BLOCK_LOADERS}: {
  client: PortalClient; guildKey: string; mode: 'public' | 'member'; onBack?: () => void; onLogin?: () => void; userId?: string;
  registerPendingLeave?: (guard: (() => boolean) | null) => void;
  blockLoaders?: GuildBlockLoaders;
  supplierConsoleEnabled?: boolean;
}) {
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const selectSection = useCallback((id: string) => setSelectedSection(id), []);
  useEffect(() => {setSelectedSection(null);}, [client, guildKey, mode]);
  const [guild, setGuild] = useState<{name: string; purpose: string} | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementRef[]>([]);
  const [skillBooks, setSkillBooks] = useState<BookRef[]>([]);
  const [applications, setApplications] = useState<LaunchpadApplication[]>([]);
  const [recommendationChoice, setRecommendationChoice] = useState('');
  const [extensionChoice, setExtensionChoice] = useState('');
  const [extensionTitles, setExtensionTitles] = useState<Record<string, string>>({});
  const [visitor, setVisitor] = useState(mode === 'public');
  const [memberTier, setMemberTier] = useState<string | undefined>();
  const [configProblem, setConfigProblem] = useState<ConfigProblem>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [saved, setSaved] = useState<ConfigView | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [pointer, setPointer] = useState('1');
  const [leader, setLeader] = useState<LeaderConfig | null>(null);
  const [access, setAccess] = useState({edit: false, preview: false, publish: false, delegate: false});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [banner, setBanner] = useState('');
  const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{mode: 'public' | 'member' | 'my_work'; result: PreviewResult} | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [revertTarget, setRevertTarget] = useState<string | null>(null);
  const [revertReason, setRevertReason] = useState('');
  const [grantPrincipal, setGrantPrincipal] = useState('');
  const [grantCaps, setGrantCaps] = useState<string[]>(['guild.content.edit']);
  const [grantExpiry, setGrantExpiry] = useState('');
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const previewDialog = useRef<HTMLDialogElement>(null);
  const publishDialog = useRef<HTMLDialogElement>(null);
  const revertDialog = useRef<HTMLDialogElement>(null);
  const revokeDialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const keys = useRef(new Map<string, string>());
  const generation = useRef(0);
  const leaveGuard = useRef<(() => boolean) | null>(null);
  const registerLeave = useCallback((guard: (() => boolean) | null) => { leaveGuard.current = guard; }, []);
  const launchLeaveGuard = useRef<(() => boolean) | null>(null);
  const registerLaunchLeave = useCallback((guard: (() => boolean) | null) => {
    launchLeaveGuard.current = guard;
  }, []);
  useEffect(() => {
    // Keep tenant creation and production / direction-card Result checkpoints in the existing
    // App guard; either child clearing its guard must not erase the other.
    registerPendingLeave?.(() => (!launchLeaveGuard.current || launchLeaveGuard.current())
      && (!legacyWorkNavigationGuard(guildKey) || !leaveGuard.current || leaveGuard.current()));
    return () => registerPendingLeave?.(null);
  }, [guildKey, registerPendingLeave]);
  const canLeave = () => (!launchLeaveGuard.current || launchLeaveGuard.current()) && (!leaveGuard.current || leaveGuard.current());
  // Route changes are checked once by App; local context switches still check here.
  const canNavigate = () => legacyWorkNavigationGuard(guildKey) && registerPendingLeave ? true : canLeave();
  const headingId = useId();
  const {mutate, busy: joining, error: joinError} = useModuleMutation(client);
  const dirty = Boolean(draft && JSON.stringify(draft) !== savedJson);
  const canPublish = Boolean(saved?.status === 'draft' && saved.config_id && !dirty);
  const showEditor = mode === 'member' && !visitor && (access.edit || access.preview || access.publish);
  useEffect(() => {
    if (!showEditor) return;
    let live = true;
    void Promise.all(Object.entries(blockLoaders).map(async ([id, load]) => {
      try {return [id, (await load()).title] as const;} catch {return null;}
    })).then(entries => {if (live) setExtensionTitles(Object.fromEntries(entries.filter(entry => entry !== null)));});
    return () => {live = false;};
  }, [showEditor, blockLoaders]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const canAdoptLayout = (next: Config) => {
    const allowed = canReplaceLaunchpadLayout(draftRef.current, next, {applications: launchLeaveGuard.current, my_work: leaveGuard.current});
    if (!allowed) setBanner('版面尚未變更。請回到原工作區確認未儲存內容或待確認的操作，再調整版面。');
    return allowed;
  };

  function remember(view: ConfigView, announce = true) {
    const next = asConfig(guildKey, view.body);
    // Check current mounted editors at adoption: this response may predate pending work.
    if (!canAdoptLayout(next)) {
      setBanner('最新配置尚未套用。請先確認原操作，再重新載入最新版本。'); setConflict(true);
      return false;
    }
    setDraft(next); setSaved(view); setSavedJson(JSON.stringify(next)); setPointer(view.pointer_version); setErrors([]); setConflict(false);
    if (announce && view.status === 'published' && view.source === 'guild_editor') setStatus(`已發布版本 ${view.revision}`);
    return true;
  }
  function openDialog(dialog: HTMLDialogElement | null, button: HTMLButtonElement) {
    opener.current = button; dialog?.showModal();
  }
  function closeDialog(dialog: HTMLDialogElement | null) { dialog?.close(); opener.current?.focus(); }

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true); setBanner(''); setGuild(null); setApplications([]); setRecommendationChoice('');
    const signal = controller.signal;
    const applyPublic = (value: PublicView) => {
      setGuild(value.guild); setAnnouncements(value.announcements); setSkillBooks(value.skill_books); setConfigProblem(value.config_problem);
      setVisitor(true); setMemberTier(undefined); setAccess({edit: false, preview: false, publish: false, delegate: false}); setLeader(null);
      setApplications([]);
      const next = asConfig(guildKey, value.config.body);
      setDraft(next); setSaved(null); setSavedJson(JSON.stringify(next));
    };
    const load = async () => {
      if (mode === 'public') {
        const value = await client.get<PublicView>(`/public/guilds/${guildKey}/launchpad`, {skipAuthHandler: true, signal});
        if (current !== generation.current) return;
        applyPublic(value);
        return;
      }
      try {
        const member = await client.get<MemberView>(`/guilds/${guildKey}/launchpad`, {signal});
        if (current !== generation.current) return;
        setGuild(member.guild); setAnnouncements(member.announcements); setSkillBooks(member.skill_books); setConfigProblem(member.config_problem);
        setVisitor(false); setMemberTier(member.membership.member_tier);
        setApplications(LaunchpadApplicationSchema.array().parse(member.applications));
        const flags = {edit: member.viewer_can_edit_config, preview: member.viewer_can_preview_config, publish: member.viewer_can_publish_config, delegate: member.viewer_can_manage_delegations};
        setAccess(flags);
        if (flags.edit || flags.preview || flags.publish) {
          const config = await client.get<LeaderConfig>(`/guilds/${guildKey}/launchpad-config`, {signal});
          if (current !== generation.current) return;
          setLeader(config); setConfigProblem(config.config_problem); remember(config);
        } else {
          setLeader(null); setConfigProblem(member.config_problem); remember(member.config, false);
          setStatus('');
        }
      } catch (error) {
        if (current !== generation.current) return;
        if (error instanceof ApiError && error.code === 'guild_member_required') {
          applyPublic(await client.get<PublicView>(`/public/guilds/${guildKey}/launchpad`, {skipAuthHandler: true, signal}));
          return;
        }
        throw error;
      }
    };
    void load().catch(error => {
      if (current !== generation.current || (error instanceof ApiError && error.code === 'aborted')) return;
      setBanner(error instanceof Error ? error.message : '啟動台暫時無法載入。');
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { controller.abort(); generation.current += 1; };
  }, [client, guildKey, mode]);

  async function reload() {
    setBusy(true); setBanner('');
    try {
      if (mode === 'public' || visitor) return;
      const member = await client.get<MemberView>(`/guilds/${guildKey}/launchpad`);
      setAnnouncements(member.announcements); setSkillBooks(member.skill_books); setMemberTier(member.membership.member_tier); setConfigProblem(member.config_problem);
      setApplications(LaunchpadApplicationSchema.array().parse(member.applications));
      if (access.edit || access.preview || access.publish) {
        const config = await client.get<LeaderConfig>(`/guilds/${guildKey}/launchpad-config`);
        setLeader(config); setConfigProblem(config.config_problem); remember(config);
      } else remember(member.config);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : '重新載入失敗。');
    } finally { setBusy(false); }
  }
  async function command<T>(action: string, path: string, body: unknown, ifMatch?: string): Promise<T> {
    const fingerprint = `${action}\n${ifMatch ?? ''}\n${JSON.stringify(body)}`;
    const key = keys.current.get(fingerprint) ?? crypto.randomUUID();
    keys.current.set(fingerprint, key);
    try {
      const result = await client.post<T>(path, body, {idempotencyKey: key, ifMatch});
      keys.current.delete(fingerprint);
      return result;
    } catch (error) {
      if (!(error instanceof ApiError) || !error.network) keys.current.delete(fingerprint);
      throw error;
    }
  }
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 412) setConflict(true);
    if (error instanceof ApiError && error.errors?.length) setErrors(error.errors);
    setBanner(error instanceof Error ? error.message : '操作未完成。');
  }
  async function saveDraft() {
    if (!draft || busy) return;
    setBusy(true); setBanner(''); setErrors([]);
    try {
      const view = await command<ConfigView>('draft', `/guilds/${guildKey}/launchpad-config/drafts`, {body: draft}, pointer);
      if (!remember(view, false)) return;
      setStatus(`已儲存草稿版本 ${view.revision}`);
      const config = await client.get<LeaderConfig>(`/guilds/${guildKey}/launchpad-config`);
      setLeader(config); setPointer(view.pointer_version);
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function publish() {
    if (!saved?.config_id || !canPublish || busy) return;
    setBusy(true); setBanner(''); setErrors([]);
    try {
      const view = await command<ConfigView>('publish', `/guilds/${guildKey}/launchpad-config/${saved.config_id}/publish`, {expected_body_sha256: saved.body_sha256}, pointer);
      const adopted = remember(view); closeDialog(publishDialog.current); setConfirmPublish(false);
      if (!adopted) return;
      const config = await client.get<LeaderConfig>(`/guilds/${guildKey}/launchpad-config`);
      setLeader(config); setPointer(view.pointer_version);
      const member = await client.get<MemberView>(`/guilds/${guildKey}/launchpad`);
      setAnnouncements(member.announcements); setSkillBooks(member.skill_books);
      setApplications(LaunchpadApplicationSchema.array().parse(member.applications));
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function revert() {
    if (!revertTarget || busy || blockedReason(revertReason)) return;
    setBusy(true); setBanner(''); setErrors([]);
    try {
      const view = await command<ConfigView>('revert', `/guilds/${guildKey}/launchpad-config/revert`, {to_revision: revertTarget, reason: revertReason.trim()}, pointer);
      const adopted = remember(view); closeDialog(revertDialog.current); setRevertTarget(null); setRevertReason('');
      if (!adopted) return;
      const config = await client.get<LeaderConfig>(`/guilds/${guildKey}/launchpad-config`);
      setLeader(config); setPointer(view.pointer_version);
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function runPreview(previewMode: 'public' | 'member' | 'my_work', button: HTMLButtonElement) {
    if (!draft || busy) return;
    setBusy(true); setBanner(''); setErrors([]);
    try {
      const result = await client.post<PreviewResult>(`/guilds/${guildKey}/launchpad-config/preview`, {body: draft, preview_mode: previewMode});
      setPreview({mode: previewMode, result}); openDialog(previewDialog.current, button);
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function grant() {
    if (!grantPrincipal || !grantExpiry || grantCaps.length === 0 || busy) return;
    const expires = new Date(grantExpiry);
    if (Number.isNaN(expires.getTime())) { setBanner('請選擇授權到期時間。'); return; }
    setBusy(true); setBanner('');
    try {
      await command('grant', `/guilds/${guildKey}/launchpad-delegations`, {principal_id: grantPrincipal, capabilities: grantCaps, expires_at: expires.toISOString()});
      const config = await client.get<LeaderConfig>(`/guilds/${guildKey}/launchpad-config`);
      setLeader(config); setStatus('已新增授權。');
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function revoke() {
    const row = leader?.delegations?.find(item => item.delegation_id === revokeId);
    if (!row || blockedReason(revokeReason) || busy) return;
    setBusy(true); setBanner('');
    try {
      await command('revoke', `/guilds/${guildKey}/launchpad-delegations/${row.delegation_id}/revoke`, {reason: revokeReason.trim()}, row.version);
      const config = await client.get<LeaderConfig>(`/guilds/${guildKey}/launchpad-config`);
      setLeader(config); closeDialog(revokeDialog.current); setRevokeId(null); setRevokeReason(''); setStatus('已撤銷授權。');
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function join() {
    setBanner('');
    try {
      const directory = await client.get<{items: GuildSummary[]}>('/guilds/directory');
      const membership = directory.items.find(item => item.guild_key === guildKey)?.membership;
      const result = await mutate(`/guilds/${guildKey}/join`, {}, membership?.aggregate_version);
      if (result) {
        window.dispatchEvent(new Event('freedom-profile-updated'));
        window.location.reload();
      }
    } catch (error) { fail(error); }
  }
  function updateBlock(index: number, patch: Partial<Pick<Config['blocks'][number], 'title' | 'enabled' | 'order'>>) {
    const current = draftRef.current;
    if (!current) return;
    const next = {...current, blocks: current.blocks.map((block, blockIndex) => blockIndex === index ? {...block, ...patch} : block)} as Config;
    if (canAdoptLayout(next)) setDraft(next);
  }
  function moveBlock(index: number, delta: number) {
    setDraft(current => {
      if (!current) return current;
      const next = index + delta;
      if (next < 0 || next >= current.blocks.length) return current;
      const blocks = current.blocks.slice();
      const [item] = blocks.splice(index, 1);
      blocks.splice(next, 0, item);
      return {...current, blocks: blocks.map((block, order) => ({...block, order}))} as Config;
    });
  }
  function moveRecommendation(index: number, delta: number) {
    setDraft(current => {
      if (!current || index + delta < 0 || index + delta >= current.application_refs.length) return current;
      const refs = [...current.application_refs];
      const [ref] = refs.splice(index, 1);
      refs.splice(index + delta, 0, ref);
      return {...current, application_refs: refs.map((item, order) => ({...item, order}))};
    });
  }
  const addableApplications = applications.filter(app => !app.eligibility.reason_codes.includes('application_not_available')
    && !draft?.application_refs.some(ref => ref.application_key === app.application_key));
  const selectedApplication = addableApplications.find(app => JSON.stringify([app.application_key, app.release_ref]) === recommendationChoice);
  const title = guild?.name ?? (loading ? '公會啟動台' : '找不到這個公會');
  const titleId = mode === 'member' ? 'workspace-page-title' : headingId;
  const readingConfig = draft;
  const sections = readingConfig ? launchpadSections(guildKey, readingConfig, applications, !visitor && mode === 'member' && Boolean(userId), showEditor) : [];
  const groups = (['工作', '公會資源', '管理'] as const).map(group => ({label: group, items: sections.filter(section => section.group === group)})).filter(group => group.items.length);
  const defaultSection = visitor ? sections.find(section => section.id === 'information') : sections.find(section => section.group === '工作');
  const activeSection = sections.find(section => section.id === selectedSection)?.id ?? defaultSection?.id ?? sections[0]?.id ?? '';

  const looseErrors = errors.filter(error => !['mission_override', 'starter.title_label', 'starter.objective_hint', 'starter.note_hint', 'support.public_url', 'reason'].some(path => error.path === path || error.path.endsWith(`.${path}`)) && !/blocks\.\d+\.(title|enabled|order)/.test(error.path));

  return <section className="guild-launchpad" aria-labelledby={titleId}>
    <header className="guild-launchpad-heading">
      <div><h1 id={titleId}>{title}</h1>
        {memberTier && !visitor && <p className="field-hint guild-launchpad-membership">成員身分：{memberTier === 'intern' ? '實習成員' : memberTier === 'full' ? '正式成員' : memberTier}</p>}
      </div>
      {mode === 'member' && <button type="button" className="btn btn-ghost btn-small" onClick={() => { if (!canNavigate()) return; onBack?.(); }}>返回公會列表</button>}
    </header>
    <p className="guild-launchpad-status" role="status" aria-live="polite">{loading ? '正在載入啟動台…' : status}</p>
    {configProblem && <p className="banner" role="status">這個公會的啟動台設定版本目前無法顯示，先顯示上一個可用版本。</p>}
    {banner && <p className="banner banner-error" role="alert">{banner}</p>}
    {conflict && <p><button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={busy}>重新載入最新版本</button></p>}
    {visitor && mode === 'member' && guild && <div className="actions"><button type="button" className="btn btn-primary" disabled={busy || joining} onClick={() => void join()}>加入{guild.name}</button></div>}
    {visitor && joinError && <p className="banner banner-error" role="alert">{joinError}</p>}
    <div className="guild-launchpad-layout">
    {sections.length > 0 && <>
      <nav className="guild-launchpad-nav" aria-label="公會功能">
        {groups.map(group => <div key={group.label} className="guild-launchpad-nav-group">
          <p>{group.label}</p>{group.items.map(item => <button type="button" key={item.id} aria-current={activeSection === item.id ? 'page' : undefined} onClick={() => selectSection(item.id)}>{item.label}</button>)}
        </div>)}
      </nav>
      <label className="guild-launchpad-mobile-nav">公會功能<select value={activeSection} onChange={event => selectSection(event.target.value)}>
        {groups.map(group => <optgroup key={group.label} label={group.label}>{group.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}
      </select></label>
    </>}
    <div className="guild-launchpad-content">
    {readingConfig && guild && <Reading guild={guild} config={readingConfig} announcements={visitor ? [] : announcements} skillBooks={skillBooks} applications={applications} visitor={visitor} memberTier={visitor ? undefined : memberTier} mode={mode} client={client} guildKey={guildKey} userId={userId} registerLeave={registerLeave} registerPendingLeave={registerLaunchLeave} canLeave={canLeave} canNavigate={canNavigate} onLogin={onLogin} blockLoaders={blockLoaders} supplierConsoleEnabled={supplierConsoleEnabled} activeSection={activeSection} selectSection={selectSection}/>}
    {showEditor && draft && <form hidden={activeSection !== 'management'} className="card guild-launchpad-editor" onSubmit={event => event.preventDefault()}>
      <h2>調整版面</h2>
      {looseErrors.length > 0 && <ul>{looseErrors.map(error => <li key={`${error.path}:${error.code}`}>{looseText(error, draft)}</li>)}</ul>}
      <label className="field" htmlFor="launchpad-mission">公會使命補充
        <input id="launchpad-mission" aria-describedby={describedBy(errors, 'mission_override', 'launchpad-mission-error', 'launchpad-mission-hint')} value={draft.mission_override ?? ''} maxLength={1200} onChange={event => setDraft({...draft, mission_override: event.target.value === '' ? null : event.target.value})}/>
      </label>
      <p className="field-hint" id="launchpad-mission-hint">這段文字不能換行</p>
      <FieldNote id="launchpad-mission-error" errors={errors} path="mission_override"/>
      <fieldset className="fieldset">
        <legend>版面區塊</legend>
        {draft.schema_version === 'guild-launchpad.config/v1' ? <div className="stack">
          <p className="field-hint">目前使用原有七區塊版面。轉為可組裝版面後，可以加入已核准的公會工具；先保存與預覽，再由有發布權限的人發布。原版本仍可回復。</p>
          <div className="actions"><button type="button" className="btn btn-ghost btn-small" disabled={busy || !access.edit} onClick={() => {if (canLeave()) setDraft(convertV1(draft));}}>啟用可組裝版面</button></div>
        </div> : <div className="stack">
          <label className="field" htmlFor="launchpad-extension">加入公會工具</label>
          <select id="launchpad-extension" value={extensionChoice} disabled={busy || !access.edit} onChange={event => setExtensionChoice(event.target.value)}>
            <option value="">選擇已核准的區塊</option>{Object.entries(extensionTitles).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </select>
          <div className="actions"><button type="button" className="btn btn-ghost btn-small" disabled={busy || !access.edit || !Object.hasOwn(extensionTitles, extensionChoice) || draft.blocks.length >= 24} onClick={() => {
            if (!canLeave() || draft.schema_version !== 'guild-launchpad.config/v2' || !Object.hasOwn(extensionTitles, extensionChoice)) return;
            setDraft({...draft, blocks: [...draft.blocks, {id: `extension_${crypto.randomUUID()}`, kind: 'extension', extension_id: extensionChoice, title: extensionTitles[extensionChoice], order: draft.blocks.length, enabled: true, settings: {}}]});
            setExtensionChoice('');
          }}>新增公會區塊</button></div>
          <p className="field-hint">只使用已審查的區塊，不接受貼入程式。排序、顯示與標題仍需保存、預覽及發布；區塊不會增加會員權限。</p>
        </div>}
        <div className="stack">{draft.blocks.map((block, index) => {
          const name = block.kind === 'extension' ? extensionTitles[block.extension_id] ?? block.title ?? '目前無法使用的公會工具' : BLOCK_LABEL[block.kind];
          return <div key={block.id} className="guild-launchpad-block" role="group" aria-labelledby={`launchpad-block-name-${index}`}>
            <p id={`launchpad-block-name-${index}`}>{name}</p>
            <div className="guild-launchpad-block-actions">
              <button type="button" className="btn btn-ghost" aria-label={`上移${name}`} aria-describedby={describedBy(errors, `blocks.${index}.order`, `launchpad-block-order-${index}-error`)} disabled={busy || index === 0} onClick={() => moveBlock(index, -1)}>上移</button>
              <button type="button" className="btn btn-ghost" aria-label={`下移${name}`} aria-describedby={describedBy(errors, `blocks.${index}.order`, `launchpad-block-order-${index}-error`)} disabled={busy || index === draft.blocks.length - 1} onClick={() => moveBlock(index, 1)}>下移</button>
              {(draft.schema_version === 'guild-launchpad.config/v2' || OPTIONAL.has(block.kind)) && <label className="checkbox-row"><input type="checkbox" checked={block.enabled} aria-describedby={describedBy(errors, `blocks.${index}.enabled`, `launchpad-block-enabled-${index}-error`, `launchpad-block-name-${index}`)} onChange={event => updateBlock(index, {enabled: event.target.checked})}/>顯示這個區塊</label>}
              {block.kind === 'extension' && <button type="button" className="btn btn-ghost btn-small" aria-label={`移除這個區塊：${name}`} disabled={busy || !access.edit} onClick={() => {
                if (canLeave() && draft.schema_version === 'guild-launchpad.config/v2') setDraft({...draft, blocks: draft.blocks.filter(item => item.id !== block.id).map((item, order) => ({...item, order}))});
              }}>移除這個區塊</button>}
            </div>
            <FieldNote id={`launchpad-block-order-${index}-error`} errors={errors} path={`blocks.${index}.order`}/>
            <FieldNote id={`launchpad-block-enabled-${index}-error`} errors={errors} path={`blocks.${index}.enabled`}/>
            <label className="field" htmlFor={`launchpad-block-title-${index}`}>區塊標題<input id={`launchpad-block-title-${index}`} aria-describedby={describedBy(errors, `blocks.${index}.title`, `launchpad-block-title-${index}-error`)} value={block.title ?? ''} maxLength={120} onChange={event => updateBlock(index, {title: event.target.value === '' ? null : event.target.value})}/></label>
            <FieldNote id={`launchpad-block-title-${index}-error`} errors={errors} path={`blocks.${index}.title`}/>
          </div>;
        })}</div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>推薦應用</legend>
        <p className="field-hint" id="launchpad-recommendations-hint">排在第一個的應用會成為會員看到的主要動作。</p>
        {!draft.blocks.find(block => block.kind === 'applications')?.enabled && <p className="field-hint">應用區塊關閉時，會員看不到推薦應用；主要動作只保留我的工作。</p>}
        <ol className="guild-launchpad-ref-list">{draft.application_refs.map((ref, index) => {
          const label = applications.find(app => app.application_key === ref.application_key && app.release_ref === ref.release_ref)?.display_name ?? `${ref.application_key} · ${ref.release_ref}`;
          const path = `application_refs.${index}`;
          const errorId = `launchpad-recommendation-${index}-error`;
          return <li className="guild-launchpad-ref-row" key={`${ref.application_key}:${ref.release_ref}`} aria-describedby={describedBy(errors, path, errorId)}>
            <span>{label}</span>
            <div className="guild-launchpad-block-actions">
              <button type="button" className="btn btn-ghost" aria-label={`上移${label}`} aria-describedby={describedBy(errors, path, errorId)} disabled={busy || index === 0} onClick={() => moveRecommendation(index, -1)}>上移</button>
              <button type="button" className="btn btn-ghost" aria-label={`下移${label}`} aria-describedby={describedBy(errors, path, errorId)} disabled={busy || index === draft.application_refs.length - 1} onClick={() => moveRecommendation(index, 1)}>下移</button>
              <button type="button" className="btn btn-ghost" aria-label={`移除${label}`} aria-describedby={describedBy(errors, path, errorId)} disabled={busy} onClick={() => setDraft({...draft, application_refs: draft.application_refs.filter((_, at) => at !== index).map((item, order) => ({...item, order}))})}>移除</button>
            </div>
            <FieldNote id={errorId} errors={errors} path={path}/>
          </li>;
        })}</ol>
        <label className="field">加入推薦應用<select value={selectedApplication ? recommendationChoice : ''} aria-describedby="launchpad-recommendations-hint" disabled={busy || draft.application_refs.length >= 30} onChange={event => setRecommendationChoice(event.target.value)}>
          <option value="">選擇應用</option>{addableApplications.map(app => <option key={`${app.application_key}:${app.release_ref}`} value={JSON.stringify([app.application_key, app.release_ref])}>{app.display_name} · {app.release_ref}</option>)}
        </select></label>
        <div className="guild-launchpad-actions"><button type="button" className="btn btn-ghost" disabled={busy || !selectedApplication || draft.application_refs.length >= 30} onClick={() => {
          if (!selectedApplication || draft.application_refs.length >= 30) return;
          setDraft({...draft, application_refs: [...draft.application_refs, {application_key: selectedApplication.application_key, release_ref: selectedApplication.release_ref, order: draft.application_refs.length}]});
          setRecommendationChoice('');
        }}>加入推薦</button></div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>起步提示</legend>
        <label className="field" htmlFor="launchpad-starter-title">標題<input id="launchpad-starter-title" aria-describedby={describedBy(errors, 'starter.title_label', 'launchpad-starter-title-error')} value={draft.starter.title_label} maxLength={480} onChange={event => setDraft({...draft, starter: {...draft.starter, title_label: event.target.value}})}/></label>
        <FieldNote id="launchpad-starter-title-error" errors={errors} path="starter.title_label"/>
        <label className="field" htmlFor="launchpad-starter-objective">目標<input id="launchpad-starter-objective" aria-describedby={describedBy(errors, 'starter.objective_hint', 'launchpad-starter-objective-error')} value={draft.starter.objective_hint} maxLength={480} onChange={event => setDraft({...draft, starter: {...draft.starter, objective_hint: event.target.value}})}/></label>
        <FieldNote id="launchpad-starter-objective-error" errors={errors} path="starter.objective_hint"/>
        <label className="field" htmlFor="launchpad-starter-note">筆記<input id="launchpad-starter-note" aria-describedby={describedBy(errors, 'starter.note_hint', 'launchpad-starter-note-error')} value={draft.starter.note_hint} maxLength={480} onChange={event => setDraft({...draft, starter: {...draft.starter, note_hint: event.target.value}})}/></label>
        <FieldNote id="launchpad-starter-note-error" errors={errors} path="starter.note_hint"/>
      </fieldset>
      <fieldset className="fieldset">
        <legend>協助連結</legend>
        <label className="field">協助類型<select value={draft.support.kind} onChange={event => setDraft({...draft, support: {...draft.support, kind: event.target.value as Config['support']['kind']}})}><option value="platform_help">平台說明</option><option value="guild_public_contact">公會公開聯絡</option></select></label>
        <label className="field" htmlFor="launchpad-support-url">公開網址<input id="launchpad-support-url" aria-describedby={describedBy(errors, 'support.public_url', 'launchpad-support-url-error')} value={draft.support.public_url ?? ''} maxLength={2048} placeholder="https://" onChange={event => setDraft({...draft, support: {...draft.support, public_url: event.target.value === '' ? null : event.target.value}})}/></label>
        <FieldNote id="launchpad-support-url-error" errors={errors} path="support.public_url"/>
      </fieldset>
      {!canPublish && access.publish && <p className="field-hint">{saved?.status === 'draft' && dirty ? '尚未儲存的修改不會進入這個版本。' : '請先儲存草稿'}</p>}
      <div className="guild-launchpad-actions">
        {access.preview && <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={event => void runPreview('public', event.currentTarget)}>預覽公開</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={event => void runPreview('member', event.currentTarget)}>預覽會員</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={event => void runPreview('my_work', event.currentTarget)}>預覽我的工作</button>
        </>}
        {access.edit && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void saveDraft()}>儲存草稿</button>}
        {access.publish && <button type="button" className="btn btn-primary" disabled={busy || !canPublish} onClick={event => { setConfirmPublish(true); openDialog(publishDialog.current, event.currentTarget); }}>發布</button>}
      </div>
      {access.publish && leader && <fieldset className="fieldset">
        <legend>版本</legend>
        {leader.revisions.length === 0 ? <p>還沒有任何版本。</p> : <ul>{leader.revisions.map(revision => <li key={revision.revision}>版本 {revision.revision} · {revision.status === 'draft' ? '草稿' : revision.status === 'published' ? '已發布' : '已取代'}{revision.revert_reason ? ` · 回復自版本 ${revision.reverted_from_revision}：${revision.revert_reason}` : ''}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={event => { setRevertTarget(revision.revision); setRevertReason(''); openDialog(revertDialog.current, event.currentTarget); }}>回復到此版本</button>
        </li>)}</ul>}
      </fieldset>}
      {access.delegate && leader?.delegations && <fieldset className="fieldset">
        <legend>授權</legend>
        <label className="field">成員<select value={grantPrincipal} onChange={event => setGrantPrincipal(event.target.value)}><option value="">選擇成員</option>{(leader.delegation_candidates ?? []).map((candidate, index) => <option key={candidate.principal_id ?? `missing-principal-${index}`} value={candidate.principal_id ?? ''} disabled={!candidate.principal_id}>{candidate.display_name}{candidate.principal_id ? '' : '（尚未建立身份，無法授權）'}</option>)}</select></label>
        <div>{Object.entries(CAPABILITY_LABEL).map(([capability, label]) => <label key={capability} className="checkbox-row"><input type="checkbox" checked={grantCaps.includes(capability)} onChange={event => setGrantCaps(current => event.target.checked ? [...current, capability] : current.filter(item => item !== capability))}/>{label}</label>)}</div>
        <label className="field">到期時間<input type="datetime-local" value={grantExpiry} onChange={event => setGrantExpiry(event.target.value)}/></label>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void grant()}>授權</button>
        {leader.delegations.length === 0 ? <p>目前沒有授權。</p> : <ul>{leader.delegations.map(row => <li key={row.delegation_id}>{row.display_name} · {row.capabilities.map(capability => CAPABILITY_LABEL[capability] ?? capability).join('、')} · <time dateTime={row.expires_at}>{formatIsoLocal(row.expires_at)}</time>{row.expired ? ' · 已過期' : ''}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={event => { setRevokeId(row.delegation_id); setRevokeReason(''); openDialog(revokeDialog.current, event.currentTarget); }}>撤銷</button>
        </li>)}</ul>}
      </fieldset>}
    </form>}
    </div>
    </div>
    <dialog ref={previewDialog} aria-labelledby="launchpad-preview-title" onClose={() => opener.current?.focus()}>
      <h2 id="launchpad-preview-title">合成預覽</h2>
      {preview?.mode === 'my_work' && <p>預覽不讀取會員的業務空間。</p>}
      <p>預覽資料來源：{preview?.result.preview_data_origin === 'synthetic_fixture' ? '合成資料' : ''}</p>
      {preview && <ul>{[...preview.result.effective_config.blocks].sort((a, b) => a.order - b.order).map(block => <li key={block.id}>{BLOCK_LABEL[block.kind]}{block.title ? `：${block.title}` : ''}</li>)}</ul>}
      <button type="button" className="btn btn-ghost" onClick={() => closeDialog(previewDialog.current)}>關閉</button>
    </dialog>
    <dialog ref={publishDialog} aria-labelledby="launchpad-publish-title" onClose={() => { setConfirmPublish(false); opener.current?.focus(); }}>
      <h2 id="launchpad-publish-title">確認發布</h2>
      <p>發布後，訪客與會員會看到這個已儲存的草稿。</p>
      <div className="guild-launchpad-actions"><button type="button" className="btn btn-primary" disabled={busy || !confirmPublish} onClick={() => void publish()}>確認發布</button><button type="button" className="btn btn-ghost" onClick={() => closeDialog(publishDialog.current)}>取消</button></div>
    </dialog>
    <dialog ref={revertDialog} aria-labelledby="launchpad-revert-title" onClose={() => opener.current?.focus()}>
      <h2 id="launchpad-revert-title">確認回復</h2>
      <p>回復會建立一個新的已發布版本，沿用版本 {revertTarget} 的內容。</p>
      <label className="field">回復原因<input aria-describedby={describedBy(errors, 'reason', 'launchpad-revert-reason-error', 'launchpad-revert-reason-hint')} value={revertReason} maxLength={1000} onChange={event => setRevertReason(event.target.value)}/></label>
      <p className="field-hint" id="launchpad-revert-reason-hint">這段文字不能換行，至少 3 個字。</p>
      <FieldNote id="launchpad-revert-reason-error" errors={errors} path="reason"/>
      <div className="guild-launchpad-actions"><button type="button" className="btn btn-primary" disabled={busy || blockedReason(revertReason)} onClick={() => void revert()}>確認回復</button><button type="button" className="btn btn-ghost" onClick={() => closeDialog(revertDialog.current)}>取消</button></div>
    </dialog>
    <dialog ref={revokeDialog} aria-labelledby="launchpad-revoke-title" onClose={() => opener.current?.focus()}>
      <h2 id="launchpad-revoke-title">撤銷授權</h2>
      <label className="field">撤銷原因<input aria-describedby={describedBy(errors, 'reason', 'launchpad-revoke-reason-error')} value={revokeReason} maxLength={1000} onChange={event => setRevokeReason(event.target.value)}/></label>
      <FieldNote id="launchpad-revoke-reason-error" errors={errors} path="reason"/>
      <div className="guild-launchpad-actions"><button type="button" className="btn btn-primary" disabled={busy || blockedReason(revokeReason)} onClick={() => void revoke()}>確認撤銷</button><button type="button" className="btn btn-ghost" onClick={() => closeDialog(revokeDialog.current)}>取消</button></div>
    </dialog>
  </section>;
}

function FieldNote({errors, path, id}: {errors: FieldError[]; path: string; id: string}) {
  const hits = fieldHits(errors, path);
  if (!hits.length) return null;
  return <p id={id} className="banner banner-error" role="alert">{hits.map(error => fieldMessage(error.code)).join('；')}</p>;
}
