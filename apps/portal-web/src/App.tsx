import {sellerOrdersRoute} from './modules/hosted-seller-order-state'
import {buyerRoute} from './modules/hosted-order-state'
import { client, PortalContext, describeError, isOwnRef, type ActionError, type PortalContextValue } from './portal-session'
import { ErrorPanel } from './portal-feedback'
import { Navigation, TAB_TITLES } from './Navigation'
import React, { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageLoadBoundary } from './LazyPage'
import { RequestFeedback } from './RequestFeedback'
import { MEMBER_ACCESS_EXPIRED_MESSAGE } from './access-fetch'
import { ApiError } from './api'
import {EntryResources} from './modules/EntryResources'
import {CHAT_ENTRY_EVENT,isChatEntry,type ChatEntry} from './modules/chat-entry'
import type { OnboardingView } from './modules/Onboarding'
import type { MemberCardData } from './modules/Membership'
import { MemberAvatar } from './modules/MemberAvatar'
import { GitHubSocialProvider } from './modules/GitHubSocial'
import { AuthorClaimProvider } from './modules/AuthorClaim'
import { SettingsMenu } from './modules/SettingsMenu'
import {NotificationBell,type BellAction} from './modules/NotificationBell'
import {FloatingMessages} from './modules/FloatingMessages'
import './SocialLayout.css'
import { PlatformPurpose, entryIntentFromHash, entryIntentLabel, type EntryIntent } from './PlatformPurpose'
import {DevelopmentAccessProvider} from './modules/DevelopmentAccess'
import { GameConsoleProvider, GameConsolePopout, useGameConsole } from './GameConsole'
import {PageTools} from './PageTools'
import {GuideHost} from './modules/newcomer-guides/GuideHost'
import { logConsoleEvent } from './game-console-core'
import { consoleChannel } from './game-console-routing'
import { BrandPoster, CommunityLinks, CommunityPanel, type SiteConfig } from './modules/Community'
import { PublicDiscovery, publicDiscoveryPath, validatePublicReturn } from './modules/PublicDiscovery'
import { CommunitySearch } from './modules/CommunitySearch'
import { guildKeyFromHash } from './modules/guild-launchpad-route'
import {ShareLauncher,SHARE_TARGETS,type ShareTarget} from './ShareLauncher'
import { setSharingDraftAccount } from './modules/authoring-drafts'
import type { SessionPayload, TabId } from './types'
import {LanguageProvider,LanguagePicker,useLanguage} from './language'
import {authErrorMessage} from './auth-messages'
import {AppInstallProvider,InstallAppButton} from './AppInstall'

const PublicGuildLaunchpad = lazy(() => import('./modules/GuildLaunchpad').then(m => ({default: m.PublicGuildLaunchpad})))
const WorkbenchPanel = lazy(() => import('./modules/WorkbenchPanel').then(m => ({default: m.WorkbenchPanel})))
const ShowcasePanel = lazy(() => import('./modules/ShowcasePanel').then(m => ({default: m.ShowcasePanel})))
const EngagementPanel = lazy(() => import('./modules/EngagementPanel').then(m => ({default: m.EngagementPanel})))
const SkillsPanel = lazy(() => import('./modules/SkillsPanel').then(m => ({default: m.SkillsPanel})))
const MemberHome = lazy(() => import('./modules/MemberHome').then(m => ({default: m.MemberHome})))
const FriendsPanel = lazy(() => import('./modules/FriendsPanel').then(m => ({default: m.FriendsPanel})))
const PublicMemberPage = lazy(() => import('./modules/PublicMemberPage').then(m => ({default: m.PublicMemberPage})))
const Onboarding = lazy(() => import('./modules/Onboarding').then(m => ({default: m.Onboarding})))
const AccountPanel = lazy(() => import('./modules/Membership').then(m => ({default: m.AccountPanel})))
const MembersPanel = lazy(() => import('./modules/Membership').then(m => ({default: m.MembersPanel})))
const SquadsPanel = lazy(() => import('./modules/Squads').then(m => ({default: m.SquadsPanel})))
const CoCreationPanel = lazy(() => import('./modules/CoCreationPanel').then(m => ({default: m.CoCreationPanel})))
const AdminPanel = lazy(() => import('./modules/AdminPanel').then(m => ({default: m.AdminPanel})))
const GitHubCallback = lazy(() => import('./modules/GitHubCallback').then(m => ({default: m.GitHubCallback})))
const MemberTasks = lazy(() => import('./modules/MemberTasks').then(m => ({default: m.MemberTasks})))
const MemberMessages = lazy(() => import('./modules/MemberMessages').then(m => ({default: m.MemberMessages})))
const EventsPanel = lazy(() => import('./modules/EventsPanel').then(m => ({default: m.EventsPanel})))
const SocialZone = lazy(() => import('./modules/SocialZone').then(m => ({default: m.SocialZone})))
const MemberServices = lazy(() => import('./modules/MemberServices').then(m => ({default: m.MemberServices})))
const PromotionBoards = lazy(() => import('./modules/PromotionBoards').then(m => ({default: m.PromotionBoards})))
const EventHighlights = lazy(() => import('./modules/EventHighlights').then(m => ({default: m.EventHighlights})))
const PublicEventPage = lazy(() => import('./modules/PublicEventPage').then(m => ({default: m.PublicEventPage})))
const TaskBoardPanel = lazy(() => import('./modules/TaskBoardPanel').then(m => ({default: m.TaskBoardPanel})))
const WelcomePreview = lazy(() => import('./modules/WelcomePreview').then(m => ({default: m.WelcomePreview})))
const MemberGuildWorkspace = lazy(() => import('./modules/GuildWorkspace').then(m => ({default: m.MemberGuildWorkspace})))
const HostedOrderPage = lazy(() => import('./modules/HostedOrder').then(m => ({default: m.HostedOrderPage})))
const HostedStore = lazy(() => import('./modules/HostedStore').then(m => ({default: m.HostedStore})))
const TenantSettings = lazy(() => import('./modules/TenantSettings').then(m => ({default: m.TenantSettings})))
const PositioningPanel = lazy(() => import('./modules/PositioningPanels').then(m => ({default: m.PositioningPanel})))
const GuildsPanel = lazy(() => import('./modules/PositioningPanels').then(m => ({default: m.GuildsPanel})))
const SupplierPanel = lazy(() => import('./modules/CommercePanels').then(m => ({default: m.SupplierPanel})))
const RetailPanel = lazy(() => import('./modules/CommercePanels').then(m => ({default: m.RetailPanel})))
const OpenSourcePanel = lazy(() => import('./modules/OpenSourcePanels').then(m => ({default: m.OpenSourcePanel})))
const MarketingPanel = lazy(() => import('./modules/OpenSourcePanels').then(m => ({default: m.MarketingPanel})))
const PrivateWorkAI = lazy(() => import('./modules/PrivateWorkAI').then(m => ({default: m.PrivateWorkAI})))
import { MyContent } from './modules/MyContent'

const DEMO_ACCOUNTS = [
  { email: 'maker@local.test', label: '作者示範帳號' },
  { email: 'reviewer@local.test', label: '回饋示範帳號' },
  { email: 'client@local.test', label: '委託示範帳號' },
] as const
const DEMO_PASSWORD = 'freedom-local-demo'
const onboardingStarted=(userId:string)=>{try{return sessionStorage.getItem(`freedom-onboarding-started:${userId}`)==='yes'}catch{return false}}
const rememberOnboarding=(userId:string,started:boolean)=>{try{if(started)sessionStorage.setItem(`freedom-onboarding-started:${userId}`,'yes');else sessionStorage.removeItem(`freedom-onboarding-started:${userId}`)}catch{/* Keep the in-memory choice. */}}

const TAB_GUIDANCE: Record<TabId, string> = {
  friends: '查看好友、待回覆邀請與可用的私訊入口。',
  home: '查看會員摘要與常用入口，從這裡繼續公會和技能書旅程。',
  positioning: '透過情境題整理你的能力與想走的方向；結果由你確認，也可以日後重新探索。',
  guilds: '加入感興趣的職業公會，設定主要公會，查看公會技能書。',
  skills: '預覽技能書，領取已解鎖的內容，選一本開始練習。',
  members: '認識工坊夥伴，查看他們願意公開的名片資訊。',
  account: '編輯名片資料、頭像與公開範圍。',
  cocreation: '查看一起開發的作品和參與入口。',
  squads: '查看小隊與共同進行的協作。',
  opensource: '貼上 GitHub 網址與介紹，預覽後分享到社群技能書。',
  'private-ai': '建立私人工作、閱讀成果，並逐次確認模型推論的資料與上限。',
  workbench: '查看自己的工作、認領紀錄與進度。',
  showcase: '瀏覽作品和需求，尋找合作機會。',
  engagement: '查看合作紀錄與目前狀態。',
  supplier: '下載 MD，讓 AI 整理商品並製作內部商店。',
  retail: '挑商品、下載 MD，讓 AI 製作公開商店。',
  marketing: '撰寫介紹草稿並記錄分享成果。',
  'guild-workspace': '管理你有權負責的公會資訊與技能書。',
  reservations: '查看本人預留；預留不代表付款或出貨。',
  stores: '管理商店展示與店主預留紀錄；預留不代表付款或履約。',
  business: '建立業務空間、切換工作區，並邀請仍在本社群的夥伴。',
  community: '查看自由工坊的社群入口和公開資訊。',
  'community-search': '依關鍵字、類型與主題搜尋目前可閱讀的社群內容。',
  'my-content': '找回私人草稿，查看本人內容的發布與審核狀態。',
  todos: '查看會員待辦事項與可直接前往的操作。',
  messages: '查看收到的訊息與對話。',
  events: '查看社群活動、審核結果與報名狀態。',
  highlights: '活動結束後會自動出現在這裡。這一頁是公開的，參加過的夥伴可以補上照片、海報和影片連結。',
  tasks: '探索工坊工作、GitHub Issue／PR 歷史與已連結 GitHub 的會員排行，查看有來源的驗收紀錄。',
  social: '發布近況與作品、按讚留言，也能分享外部社群連結。',
  services: '列出社員的本業服務。用你的連結分享出去，點擊計入業務推廣排行榜。服務頁是公開的。',
  promotion: '查看六種分享的點擊排行。分數只供比較，不計入經驗或驗收。',
}

export function App() {
  const page = new URLSearchParams(window.location.search).get('game-console')==='popout' ? <GameConsolePopout client={client}/>
    : window.location.pathname==='/github/callback' ? <GitHubCallback/>
    : window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/') ? <AdminConsoleShell/> : <MemberApp/>
  return <LanguageProvider><AppInstallProvider><RequestFeedback/><PageLoadBoundary label="自由工坊" resetKey={window.location.pathname}>{page}</PageLoadBoundary></AppInstallProvider></LanguageProvider>
}

const resetTokenFromHash=()=>/^#reset-password\/([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1]??null
const eventIdFromLocation=()=>{
  const inHash=/^#events\/([0-9a-f-]{36})(?:\?.*)?$/.exec(window.location.hash)?.[1];
  if(inHash)return inHash;
  if(window.location.hash)return null;
  return /^\/events\/([0-9a-f-]{36})\/?$/.exec(window.location.pathname)?.[1]??null;
}
const memberCardFromLocation=()=>/^\/member-cards\/([A-Za-z0-9_-]{43})\/?$/.exec(window.location.pathname)?.[1]??null
const clearResetHash=()=>window.history.replaceState(null,'',window.location.pathname+window.location.search)

function AdminConsoleShell(){
  const [memberId,setMemberId]=useState<string|null>(null)
  useEffect(()=>{let live=true;void client.getSession().then(session=>{if(live){client.csrfToken=session.csrf_token;setMemberId(session.user.user_id)}}).catch(()=>{if(live)setMemberId(null)});return()=>{live=false}},[])
  return <GameConsoleProvider client={memberId?client:undefined} userId={memberId??undefined} feedEnabled={Boolean(memberId)} standalone>
    <AdminPanel memberClient={memberId?client:undefined}/>
  </GameConsoleProvider>
}

function MemberApp() {
  const {t}=useLanguage()
  const [phase, setPhase] = useState<'boot' | 'login' | 'ready'>('boot')
  const [session, setSession] = useState<SessionPayload | null>(null)
  const [bootError, setBootError] = useState<ActionError | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)
  const [publicReturnNotice, setPublicReturnNotice] = useState<string | null>(null)
  const [site, setSite] = useState<SiteConfig | null>(null)
  const [onboarding, setOnboarding] = useState<OnboardingView | null>(null)
  const [gateError, setGateError] = useState('')
  const [exploring,setExploring]=useState(true)
  const [resetToken,setResetToken]=useState(resetTokenFromHash)
  const [publicEventId,setPublicEventId]=useState(eventIdFromLocation)
  const [eventLoginRequested,setEventLoginRequested]=useState(false)
  const [locationHash,setLocationHash]=useState(() => window.location.hash)
  const [entryIntent,setEntryIntent]=useState<EntryIntent|null>(entryIntentFromHash)
  const [siteLoaded,setSiteLoaded]=useState(false)
  const [launchpadLoginRequested,setLaunchpadLoginRequested]=useState(false)
  const [sharedCardToken,setSharedCardToken]=useState(memberCardFromLocation)
  const [memberLoginRequested,setMemberLoginRequested]=useState(false)
  const returnToWorkshop=()=>{window.history.replaceState(null,'','/#home');setSharedCardToken(null);setMemberLoginRequested(false);window.dispatchEvent(new HashChangeEvent('hashchange'));}
  const editOwnCard=()=>{window.history.replaceState(null,'','/#account');setSharedCardToken(null);setMemberLoginRequested(false);window.dispatchEvent(new HashChangeEvent('hashchange'));}
  useEffect(()=>{const changed=()=>{setSharedCardToken(memberCardFromLocation());setMemberLoginRequested(false)};window.addEventListener('popstate',changed);return()=>window.removeEventListener('popstate',changed)},[])
  useEffect(()=>{const changed=()=>setResetToken(resetTokenFromHash());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed)},[])
  useEffect(()=>{const changed=()=>{setLocationHash(window.location.hash);setEntryIntent(entryIntentFromHash());setPublicEventId(eventIdFromLocation());setEventLoginRequested(false);setLaunchpadLoginRequested(false)};window.addEventListener('hashchange',changed);window.addEventListener('popstate',changed);return()=>{window.removeEventListener('hashchange',changed);window.removeEventListener('popstate',changed)}},[])
  const sessionGeneration = useRef(0)
  const loadOnboarding = useCallback(async () => {
    const generation = sessionGeneration.current
    setGateError('')
    try { const value=await client.get<OnboardingView>('/me/onboarding');if(generation===sessionGeneration.current)setOnboarding(value) }
    catch (error) { if(generation===sessionGeneration.current)setGateError(describeError(error).message) }
  }, [])
  useEffect(() => { void client.get<SiteConfig>('/site').then(value => { setSite(value); setSiteLoaded(true) }).catch(() => { setSite(null); setSiteLoaded(true) }) }, [])
  useEffect(() => { if (session) void loadOnboarding(); else setOnboarding(null) }, [session, loadOnboarding])
  useEffect(() => {
    if (!session || !onboarding || onboarding.required && !onboarding.completed || !entryIntent) return
    // Only a chosen entry is forwarded, after the server confirms that the joining gate is complete.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${entryIntent}`)
    setEntryIntent(null)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [session, onboarding, entryIntent])

  const applySession = useCallback((next: SessionPayload) => {
    sessionGeneration.current += 1
    client.csrfToken = next.csrf_token
    setSharingDraftAccount(next.user.user_id, client.sessionGeneration)
    setOnboarding(null)
    setExploring(!onboardingStarted(next.user.user_id))
    setSession(next)
    setEventLoginRequested(false)
    setPhase('ready')
    setBootError(null)
    setLoginNotice(null)
  }, [])

  const toLogin = useCallback((notice?: string) => {
    window.dispatchEvent(new Event('freedom-game-console-session-end'))
    sessionGeneration.current += 1
    client.csrfToken = null
    setSharingDraftAccount(null, client.sessionGeneration)
    setOnboarding(null)
    setExploring(true)
    setSession(null)
    setPhase('login')
    if (notice) setLoginNotice(notice)
  }, [])

  const bootstrap = useCallback(async () => {
    setPhase('boot')
    setBootError(null)
    try {
      const next = await client.getSession()
      applySession(next)
    } catch (err) {
      if (err instanceof ApiError && err.accessExpired) {
        setLoginNotice(null)
        setBootError(describeError(err))
        setPhase('login')
        return
      }
      if (err instanceof ApiError && err.unauthorized) {
        toLogin()
        return
      }
      setBootError(describeError(err))
      setPhase('login')
    }
  }, [applySession, toLogin])

  useEffect(() => {
    client.onUnauthorized = () => {
      if (client.accessExpired) {
        window.dispatchEvent(new Event('freedom-game-console-session-end'))
        sessionGeneration.current += 1
        client.csrfToken = null
        setSharingDraftAccount(null, client.sessionGeneration)
        setOnboarding(null)
        setSession(null)
        setLoginNotice(null)
        setBootError({ message: MEMBER_ACCESS_EXPIRED_MESSAGE, network: false, conflict: false, accessExpired: true })
        setPhase('login')
        return
      }
      toLogin('登入已過期，請重新登入。')
    }
    void bootstrap()
    return () => {
      client.onUnauthorized = null
    }
  }, [bootstrap, toLogin])

  // A request owned by an unmounted workspace may finish after re-login.
  const renderedSessionGeneration = sessionGeneration.current
  const leaveCurrentSession = (notice?: string) => {
    if (sessionGeneration.current === renderedSessionGeneration) toLogin(notice)
  }

  if (phase === 'boot') {
    return (
      <div className="app-frame">
        {site?.demo_accounts_enabled && <DemoBanner />}
        <div className="centered">
          <p className="muted" role="status">
            正在確認登入狀態…
          </p>
        </div>
      </div>
    )
  }

  if (resetToken || phase !== 'ready' || !session) {
    if(!resetToken&&sharedCardToken&&!memberLoginRequested)return <PublicMemberPage client={client} token={sharedCardToken} onLogin={()=>setMemberLoginRequested(true)} onReturn={returnToWorkshop}/>;
    if(!resetToken&&locationHash.split('?')[0]==='#community-search'&&site?.community_search_enabled===true)return <div className="app-frame"><main className="main stack"><BrandPoster compact/><header className="topbar"><h1>搜尋社群內容</h1><PageTools pageId="community-search" client={client}/></header><a className="btn btn-secondary btn-small community-search-action" href="#home">返回登入</a><CommunitySearch client={client} authKey={null}/></main></div>;
    if(!resetToken&&publicEventId&&!eventLoginRequested)return <PublicEventPage client={client} id={publicEventId} revalidatePublic={site?.community_discovery_enabled===true} onLogin={()=>{if(site?.community_discovery_enabled&&site.registration_enabled)window.location.assign(`/?join=1&return_to=${encodeURIComponent(`/events/${publicEventId}`)}`);else setEventLoginRequested(true)}}/>;
    const launchpadKey=guildKeyFromHash(locationHash);
    if(!resetToken&&launchpadKey&&site?.guild_launchpad_enabled===true&&!launchpadLoginRequested)return <PageLoadBoundary label="自由工坊" resetKey={launchpadKey}><PublicGuildLaunchpad key={launchpadKey} client={client} guildKey={launchpadKey} onLogin={()=>setLaunchpadLoginRequested(true)}/></PageLoadBoundary>;
    if(!resetToken&&launchpadKey&&!siteLoaded)return <div className="app-frame"><div className="centered"><p className="muted" role="status">正在確認公開頁面…</p></div></div>;
    return (
      <div className="app-frame">
        {site?.demo_accounts_enabled && <DemoBanner />}
        {sharedCardToken&&<button type="button" className="btn btn-ghost" onClick={()=>setMemberLoginRequested(false)}>返回邀請名片</button>}
        <LoginView
          site={site}
          notice={loginNotice}
          bootError={bootError}
          onRetrySession={() => void bootstrap()}
          onLoggedIn={(next, returnNotice) => { applySession(next); setPublicReturnNotice(returnNotice ?? null) }}
          entryIntent={entryIntent}
          onChooseEntry={intent=>{setEntryIntent(intent);window.location.hash=`join/${intent}`}}
          resetToken={resetToken}
          onCancelReset={()=>{clearResetHash();setResetToken(null)}}
          onPasswordReset={next=>{clearResetHash();setResetToken(null);applySession(next)}}
        />
      </div>
    )
  }

  return (
    <GameConsoleProvider key={session.user.user_id} client={client} userId={session.user.user_id} session={session} site={site} feedEnabled={Boolean(onboarding&&(!onboarding.required||onboarding.completed))} standalone={!onboarding||onboarding.required&&!onboarding.completed}>
    {publicReturnNotice && <p className="banner banner-info" role="status">{publicReturnNotice}</p>}
    {publicEventId && site?.community_discovery_enabled ? <PublicEventPage client={client} id={publicEventId} revalidatePublic onLogin={()=>window.location.assign('/#home')}/> : !onboarding ? <div className="centered"><div className="card stack"><h1>自由工坊</h1>{gateError ? <><p role="alert">{gateError}</p><button className="btn btn-primary" onClick={() => void loadOnboarding()}>重新載入定位進度</button></> : <p role="status">正在確認你的定位旅程…</p>}</div></div>
    : onboarding.required && !onboarding.completed ? exploring&&!onboardingStarted(session.user.user_id)
      ? <WelcomePreview client={client} name={session.user.display_name} entryLabel={entryIntent?t(`intent.${entryIntent}`):undefined} onCompleted={()=>{rememberOnboarding(session.user.user_id,false);void loadOnboarding()}} onStart={()=>{rememberOnboarding(session.user.user_id,true);setExploring(false)}} onLogout={() => void client.logout(crypto.randomUUID()).then(() => leaveCurrentSession()).catch(error => setGateError(describeError(error).message))}/>
      : <Onboarding client={client} initial={onboarding} profileName={session.user.display_name} onExplore={()=>{rememberOnboarding(session.user.user_id,false);setExploring(true)}} onCompleted={() => { rememberOnboarding(session.user.user_id,false);if(!entryIntent && !buyerRoute(window.location.hash) && !sellerOrdersRoute(window.location.hash) && !sellerOrdersRoute(window.location.hash + '/orders'))window.location.hash = 'home'; void loadOnboarding() }} onLogout={() => void client.logout(crypto.randomUUID()).then(() => leaveCurrentSession()).catch(error => setGateError(describeError(error).message))}/>
    : sharedCardToken ? <PublicMemberPage client={client} token={sharedCardToken} session={session} onLogin={()=>{}} onReturn={returnToWorkshop} onEdit={editOwnCard}/> : <>
    <GitHubSocialProvider client={client} session={session}><AuthorClaimProvider client={client}><DevelopmentAccessProvider client={client} session={session}>
    <Workspace key={`${session.user.user_id}:${client.sessionGeneration}`}
      site={site}
      session={session}
      onLoggedOut={() => leaveCurrentSession()}
      onSessionExpired={() => leaveCurrentSession('登入已過期，請重新登入。')}
    />
    </DevelopmentAccessProvider></AuthorClaimProvider></GitHubSocialProvider>
    </>}
    </GameConsoleProvider>
  )
}

function DemoBanner() {
  const {t}=useLanguage()
  return (
    <div className="demo-banner" role="status">
      {t('auth.demoBanner')}
    </div>
  )
}

function LoginView({
  site,
  notice,
  bootError,
  onRetrySession,
  onLoggedIn,
  entryIntent,
  onChooseEntry,
  resetToken,
  onCancelReset,
  onPasswordReset,
}: {
  site: SiteConfig | null
  notice: string | null
  bootError: ActionError | null
  onRetrySession: () => void
  onLoggedIn: (session: SessionPayload, returnNotice?: string) => void
  entryIntent: EntryIntent | null
  onChooseEntry: (intent: EntryIntent) => void
  resetToken:string|null
  onCancelReset:()=>void
  onPasswordReset:(session:SessionPayload)=>void
}) {
  const [mode, setMode] = useState<'login' | 'register' | 'request-reset'>('login')
  const [returnPath] = useState(() => publicDiscoveryPath(new URLSearchParams(window.location.search).get('return_to')))
  const emailInput = useRef<HTMLInputElement>(null)
  const authForm = useRef<HTMLFormElement>(null)
  const discoveryEnabled = site?.community_discovery_enabled === true && !resetToken
  const join = useCallback(() => {
    setMode('register'); setError(null); setResetNotice('')
    requestAnimationFrame(() => { authForm.current?.scrollIntoView({ block: 'start' }); emailInput.current?.focus({ preventScroll: true }) })
  }, [])
  useEffect(() => { if (discoveryEnabled && site?.registration_enabled && new URLSearchParams(window.location.search).get('join') === '1') join() }, [discoveryEnabled, site?.registration_enabled, join])
  const activeMode=resetToken?'confirm-reset':mode
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword,setConfirmPassword]=useState('')
  const [resetNotice,setResetNotice]=useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const {language,t}=useLanguage()
  const errorDetails=error?{...describeError(error),message:authErrorMessage(error,language)}:null

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      if(activeMode==='request-reset'){
        await client.post('/auth/reset/request',{email:email.trim()},{skipAuthHandler:true})
        setResetNotice('若此信箱有可用帳號，且寄送服務正常，請在 30 分鐘內查看重設連結。')
        return
      }
      if(activeMode==='confirm-reset'){
        if(password!==confirmPassword)throw new Error('兩次輸入的新密碼不一致。')
        const session=await client.post<SessionPayload>('/auth/reset/confirm',{token:resetToken,password},{skipAuthHandler:true})
        if(!session?.user||!session.csrf_token)throw new Error('登入回應不完整')
        onPasswordReset(session)
        return
      }
      const session = activeMode === 'register'
        ? await client.register({email:email.trim(),password,nickname:nickname.trim()})
        : await client.login(email.trim(), password)
      if (!session?.user || !session.csrf_token) {
        throw new Error('登入回應不完整')
      }
      if (activeMode === 'register' && discoveryEnabled && returnPath) {
        let allowed = false
        try { allowed = await validatePublicReturn(returnPath) } catch { /* Registration succeeded even when original content cannot be checked. */ }
        if (allowed) { window.location.assign(returnPath); return }
        onLoggedIn(session, '帳號已建立。原本的公開內容目前無法確認或已停止公開，你仍可繼續逛工坊。')
      } else onLoggedIn(session)
    } catch (err) {
      setError(err)
    } finally {
      setPending(false)
    }
  }

  const accessExpired = Boolean(bootError?.accessExpired || errorDetails?.accessExpired)
  return (
    <main className={`login-layout${discoveryEnabled ? ' discovery-login-layout' : ''}`}>
      <div className="login-entry-tools"><LanguagePicker className="login-language-row"/><InstallAppButton/></div>
      {discoveryEnabled ? <section className="login-story discovery-story"><BrandPoster/><PublicDiscovery onJoin={join} registrationEnabled={Boolean(site?.registration_enabled)}/></section> : <section className="login-story"><BrandPoster/><div className="login-story-copy"><h1>{t('auth.headline')}</h1><p className="login-purpose-intro">{t('auth.intro')}</p><PlatformPurpose variant="public" disabled={pending||accessExpired||activeMode==='confirm-reset'} onAction={target=>{
        if(target!=='supplier'&&target!=='showcase'&&target!=='tasks')return
        onChooseEntry(target);setMode(site?.registration_enabled?'register':'login');setError(null);setResetNotice('')
        requestAnimationFrame(()=>emailInput.current?.focus())
      }}/></div></section>}
      <div className="login-form-area">
      <section className="card login-card" aria-labelledby="login-heading">
        {!accessExpired && activeMode!=='confirm-reset'&&<div className="auth-switch" role="group" aria-label={t('auth.switch')}><button type="button" className={activeMode==='login'?'selected':''} aria-pressed={activeMode==='login'} onClick={()=>{setMode('login');setError(null);setResetNotice('')}}>{t('auth.memberLogin')}</button>{site?.registration_enabled&&<button type="button" className={activeMode==='register'?'selected':''} aria-pressed={activeMode==='register'} onClick={()=>{setMode('register');setError(null);setResetNotice('')}}>{t('auth.create')}</button>}</div>}
        <header className="login-card-heading"><h2 id="login-heading">{t(accessExpired?'auth.accessExpired':activeMode==='register'?'auth.join':activeMode==='request-reset'?'auth.forgot':activeMode==='confirm-reset'?'auth.newPasswordTitle':'auth.login')}</h2><PageTools pageId="registration" compact/></header>
        {entryIntent&&!accessExpired&&activeMode!=='confirm-reset'&&activeMode!=='request-reset'&&<p className="purpose-next-destination" role="status">{language==='zh-Hant'?`${activeMode==='register'?'加入':'登入'}後前往：${entryIntentLabel(entryIntent)}。`:t('auth.destination',{destination:t(`intent.${entryIntent}`)})}</p>}
        {discoveryEnabled && returnPath && activeMode === 'register' && <p className="muted">建立帳號後，會先確認並返回原本的公開內容；選公會與完整定位可以稍後再做。</p>}
        {notice && !accessExpired && (
          <p className="banner banner-info" role="status">
            {language==='zh-Hant'?notice:authErrorMessage({message:notice},language)}
          </p>
        )}
        {bootError && (
          <ErrorPanel error={{...bootError,message:authErrorMessage(bootError,language)}} onReload={onRetrySession} reloadLabel={t('auth.checkSession')} />
        )}
        {errorDetails && <ErrorPanel error={errorDetails} />}
        {resetNotice&&<p className="banner banner-info" role="status">{t('auth.resetNotice')}</p>}
        {!accessExpired && <form ref={authForm} className="stack" onSubmit={(event) => void onSubmit(event)}>
          {activeMode==='register'&&<p className="registration-progress">{t('auth.progress')}</p>}
          {activeMode!=='confirm-reset'&&<label className="field">
            <span className="field-label">{t('auth.email')}</span>
            <input
              ref={emailInput}
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
            />
          </label>}
          {activeMode!=='request-reset'&&<label className="field">
            <span className="field-label">{t(activeMode==='confirm-reset'?'auth.newPassword':'auth.password')}</span>
            <input
              name="password"
              type="password"
              autoComplete={activeMode==='register'||activeMode==='confirm-reset'?'new-password':'current-password'}
              minLength={activeMode==='register'||activeMode==='confirm-reset'?12:undefined}
              maxLength={128}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
            />
          </label>}
          {activeMode==='confirm-reset'&&<label className="field">{t('auth.confirmPassword')}<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)} disabled={pending}/></label>}
          {activeMode==='register'&&<><label className="field"><span className="field-label" id="register-nickname-label">{t('auth.nickname')}</span><input name="nickname" maxLength={60} autoComplete="nickname" aria-labelledby="register-nickname-label" aria-describedby="register-nickname-hint" placeholder={t('auth.optionalName')} value={nickname} onChange={event=>setNickname(event.target.value)} disabled={pending}/><span className="field-hint" id="register-nickname-hint">{t('auth.nicknameHint')}</span></label><p className="field-hint">{t('auth.passwordHint')} {t(site?.password_recovery_enabled?'auth.recoveryAvailable':'auth.recoveryUnavailable')}</p></>}
          {activeMode==='request-reset'&&<p className="field-hint">{t('auth.resetHint')}</p>}
          <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending}>
            {t(pending?'auth.pending':activeMode==='register'?'auth.createExplore':activeMode==='request-reset'?'auth.sendReset':activeMode==='confirm-reset'?'auth.savePassword':'auth.login')}
          </button>
        </form>}
        {!accessExpired&&<div className="login-secondary-actions">
          {site?.password_recovery_enabled&&activeMode==='login'&&<button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>{setMode('request-reset');setError(null);setResetNotice('')}}>{t('auth.forgotButton')}</button>}
          {activeMode==='request-reset'&&<button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>{setMode('login');setError(null);setResetNotice('')}}>{t('auth.backLogin')}</button>}
          {activeMode==='confirm-reset'&&<button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancelReset}>{t('auth.backLogin')}</button>}
        </div>}
        {!accessExpired && site?.demo_accounts_enabled&&activeMode==='login'&&<aside className="help-box" aria-label={t('auth.demo')}>
          <p>
            {language==='zh-Hant'?<>示範帳號（虛構身分，不是真實人士）。密碼皆為 </>:t('auth.demoHint')} <code>{DEMO_PASSWORD}</code>。
          </p>
          <div className="chip-row">
            {DEMO_ACCOUNTS.map((account,index) => (
              <button
                key={account.email}
                type="button"
                className="chip"
                disabled={pending}
                onClick={() => {
                  setEmail(account.email)
                  setPassword(DEMO_PASSWORD)
                }}
              >
                {t(index===0?'auth.demoMaker':index===1?'auth.demoReviewer':'auth.demoClient')}
                <span className="chip-email">{account.email}</span>
              </button>
            ))}
          </div>
        </aside>}
      </section></div>
      <p className="login-language-scope field-hint">{t('language.scope')}</p>
      <div className="login-public-resources"><EntryResources client={client} communitySearchEnabled={!resetToken&&site?.community_search_enabled===true}/></div>
      <CommunityLinks/>
    </main>
  )
}

function Workspace({
  site,
  session,
  onLoggedOut,
  onSessionExpired,
}: {
  site: SiteConfig | null
  session: SessionPayload
  onLoggedOut: () => void
  onSessionExpired: () => void
}) {
  const {t}=useLanguage()
  const [headerMember,setHeaderMember]=useState<MemberCardData|null>(null)
  const [canManageGuild,setCanManageGuild]=useState(false)
  useEffect(()=>{
    let active=true,generation=0;
    const refresh=()=>{
      const current=++generation;
      void client.get<{managed_guilds:unknown[];managed_books:unknown[];can_discuss:boolean;skill_editor_access?:{requires_development_guild:boolean}}>('/guild-workspace')
        .then(value=>{if(active&&current===generation)setCanManageGuild(Boolean(value.can_discuss||value.managed_guilds.length||value.managed_books.length||value.skill_editor_access?.requires_development_guild))})
        .catch(()=>{if(active&&current===generation)setCanManageGuild(false)});
    };
    refresh();window.addEventListener('focus',refresh);window.addEventListener('freedom-profile-updated',refresh);
    return()=>{active=false;generation++;window.removeEventListener('focus',refresh);window.removeEventListener('freedom-profile-updated',refresh)};
  },[session.user.user_id])
  useEffect(()=>{let active=true,generation=0;const refresh=()=>{const current=++generation;void client.get<MemberCardData>(`/members/${session.user.user_id}`).then(value=>{if(active&&current===generation)setHeaderMember(value)}).catch(()=>{})};refresh();window.addEventListener('freedom-profile-updated',refresh);return()=>{active=false;generation++;window.removeEventListener('freedom-profile-updated',refresh)}},[session.user.user_id])
  useEffect(()=>{
    const heartbeat=()=>{if(document.visibilityState==='visible')void client.get('/session',{background:true}).catch(()=>{});};
    const timer=window.setInterval(heartbeat,60_000);
    document.addEventListener('visibilitychange',heartbeat);
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',heartbeat)};
  },[session.user.user_id]);
  const [tab, setTab] = useState<TabId>(() => tabFromHash(site?.guild_launchpad_enabled === true))
  const [locationHash, setLocationHash] = useState(() => window.location.hash)
  const {canEndSession:canEndConsoleSession}=useGameConsole()
  const pageLeaveGuard = useRef<(() => boolean) | null>(null)
  const acceptedHash = useRef(window.location.hash)
  const registerPageLeave = useCallback((guard: (() => boolean) | null) => { pageLeaveGuard.current = guard }, [])
  const replaceBuyerLocation = useCallback((hash: string) => {
    if (!buyerRoute(hash)) return
    // Only the buyer page uses this after holding/confirming its exact attempt.
    acceptedHash.current = hash
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
    setLocationHash(hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])
  const [mobileOpen, setMobileOpen] = useState(false)
  const [notificationTarget,setNotificationTarget]=useState<(BellAction&{sequence:number})|null>(null)
  const notificationSequence=useRef(0)
  const [chatEntry,setChatEntry]=useState<ChatEntry|null>(null)
  const chatEntrySequence=useRef(0)
  const [messageView,setMessageView]=useState<{view:'direct'|'notifications';request:number}>({view:'direct',request:0})
  const [shareEntry,setShareEntry]=useState<{target:ShareTarget;tab:TabId;sequence:number}|null>(null)
  const [shareNotice,setShareNotice]=useState('')
  const shareSequence=useRef(0)
  const menuToggle = useRef<HTMLButtonElement>(null)
  const mainContent = useRef<HTMLElement>(null)
  const workspaceTopbar = useRef<HTMLElement>(null)
  const previousTab = useRef(tab)
  useEffect(() => {
    if (previousTab.current === tab) return
    previousTab.current = tab
    if(tab!=='messages'){
      setChatEntry(null)
      setNotificationTarget(current=>current?.tab==='messages'?null:current)
      setMessageView(current=>({view:'direct',request:current.request+1}))
    }
    logConsoleEvent({channel:consoleChannel('guide_navigation'),kind:'guide',source:'導覽',message:`已進入「${tabTitle(tab)}」。${TAB_GUIDANCE[tab]}`})
    setMobileOpen(false)
    mainContent.current?.focus({ preventScroll: true })
    workspaceTopbar.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [tab])
  const selectTab = useCallback((next: TabId) => {
    const nextHash = `#${next}`
    if (nextHash !== acceptedHash.current && pageLeaveGuard.current && !pageLeaveGuard.current()) return
    acceptedHash.current = nextHash
    setMobileOpen(false)
    mainContent.current?.focus({ preventScroll: true })
    setTab(next)
    if(next==='messages'){
      setChatEntry(null)
      setNotificationTarget(current=>current?.tab==='messages'?null:current)
      setMessageView(current=>({view:'direct',request:current.request+1}))
    }
    if(/^\/events\/[0-9a-f-]{36}\/?$/.test(window.location.pathname)){
      window.history.replaceState(null,'',`/#${next}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
    else window.location.hash = next
  }, [])
  function chooseShare(target:ShareTarget){
    const destination=target==='post'&&tab==='home'?'home':SHARE_TARGETS[target].tab
    setShareNotice('');setShareEntry({target,tab:destination,sequence:++shareSequence.current});selectTab(destination)
  }
  useEffect(()=>{
    if(!shareEntry)return
    if(tab!==shareEntry.tab){setShareEntry(null);return}
    const root=mainContent.current;if(!root)return
    let done=false
    const definition=SHARE_TARGETS[shareEntry.target]
    const settle=()=>{
      if(done)return
      const target=root.querySelector<HTMLElement>(definition.selector)
      if(target&&!target.matches(':disabled')){
        done=true;observer.disconnect()
        if(definition.activate)target.click()
        else{target.scrollIntoView({block:'center',behavior:'instant'});target.focus({preventScroll:true})}
        setShareEntry(current=>current?.sequence===shareEntry.sequence?null:current)
      }else if(root.querySelector('[role="alert"]')){
        done=true;observer.disconnect();setShareNotice('分享入口暫時無法載入，請使用頁面的重新載入。')
        setShareEntry(current=>current?.sequence===shareEntry.sequence?null:current)
      }
    }
    // The existing lazy page and data load own their requests. Only move focus
    // after the chosen real control mounts; never submit a form or upload here.
    const observer=new MutationObserver(settle)
    observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});settle()
    return()=>{done=true;observer.disconnect()}
  },[shareEntry,tab])
  useEffect(()=>{
    const open=(event:Event)=>{const value=(event as CustomEvent).detail;if(!isChatEntry(value))return;selectTab('messages');setChatEntry({...value,request:++chatEntrySequence.current})}
    window.addEventListener(CHAT_ENTRY_EVENT,open);return()=>window.removeEventListener(CHAT_ENTRY_EVENT,open)
  },[selectTab])
  const launchpadEnabled = site?.guild_launchpad_enabled === true
  useEffect(() => {
    setLocationHash(window.location.hash)
    setTab(tabFromHash(launchpadEnabled))
  }, [launchpadEnabled])
  useEffect(() => {
    const changed = () => {
      const nextHash = window.location.hash
      if (nextHash !== acceptedHash.current && pageLeaveGuard.current && !pageLeaveGuard.current()) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${acceptedHash.current}`)
        return
      }
      acceptedHash.current = nextHash
      setLocationHash(nextHash); setTab(tabFromHash(launchpadEnabled))
    }
    window.addEventListener('hashchange', changed)
    window.addEventListener('popstate', changed)
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('popstate', changed) }
  }, [launchpadEnabled])
  const launchpadOpen = site?.guild_launchpad_enabled === true && tab === 'guilds' && guildKeyFromHash(locationHash) !== null
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<ActionError | null>(null)
  const keysRef = useRef(new Map<string, string>())
  const lockRef = useRef(false)

  const mutate = useCallback(
    async (actionId: string, fn: (key: string) => Promise<void>) => {
      if (lockRef.current) return false
      lockRef.current = true
      setPending(actionId)
      setError(null)
      const key = keysRef.current.get(actionId) ?? crypto.randomUUID()
      keysRef.current.set(actionId, key)
      try {
        await fn(key)
        keysRef.current.delete(actionId)
        return true
      } catch (err) {
        const described = describeError(err)
        if (err instanceof ApiError && err.accessExpired) {
          setError(described)
          return false
        }
        if (err instanceof ApiError && err.unauthorized) {
          onSessionExpired()
          return false
        }
        if (!described.network) {
          keysRef.current.delete(actionId)
        } else {
          described.retry = () => {
            void mutate(actionId, fn).then(ok => { if (ok) window.location.reload() })
          }
        }
        setError(described)
        return false
      } finally {
        lockRef.current = false
        setPending(null)
      }
    },
    [onSessionExpired],
  )

  const value = useMemo<PortalContextValue>(
    () => ({
      session,
      pending,
      error,
      mutate,
      clearError: () => setError(null),
      isMe: (ref) => isOwnRef(session.user, ref),
    }),
    [error, mutate, pending, session],
  )

  async function logout() {
    if (pageLeaveGuard.current && !pageLeaveGuard.current()) return
    if (!canEndConsoleSession()) return
    const ok = await mutate('logout', async (key) => {
      await client.logout(key)
    })
    if (ok) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      onLoggedOut()
    }
  }

  return (
    <PortalContext.Provider value={value}>
      <div className="app-frame social-layout">
        {site?.demo_accounts_enabled && <DemoBanner />}
        <a className="skip" href="#main-content" onClick={event => { event.preventDefault(); mainContent.current?.focus(); }}>
          跳到主要內容
        </a>
        <div className="shell">
          <header className="community-header">
          <aside className="sidebar" onKeyDown={event => { if (event.key === 'Escape' && mobileOpen) { setMobileOpen(false); menuToggle.current?.focus(); } }}>
            <div className="sidebar-heading"><div className="brand">
              <img className="sidebar-brand-art" src="/brand/freedom-workshop.webp" alt="" width="1280" height="720"/>
              <div>
                <p className="eyebrow">FREEDOM WORKSHOP</p>
                <strong>自由工坊</strong>
              </div>
            </div>
            <button ref={menuToggle} type="button" className="btn btn-ghost mobile-menu-toggle" aria-label={t(mobileOpen?'nav.closeMenu':'nav.openMenu')} aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => setMobileOpen(value => !value)}>{t(mobileOpen?'nav.closeMenu':'nav.openMenu')}</button></div>
            <Navigation current={tab} onSelect={selectTab} canManageGuild={canManageGuild} guildLaunchpadEnabled={site?.guild_launchpad_enabled === true} communitySearchEnabled={site?.community_search_enabled === true} personalContentEnabled={site?.personal_content_enabled === true} mobileOpen={mobileOpen}/>
          </aside>
          <div className="topbar-actions community-account-tools"><NotificationBell client={client} onOpen={()=>{selectTab('messages');setMessageView(current=>({view:'notifications',request:current.request+1}))}} onNavigate={action=>{selectTab(action.tab);setNotificationTarget({...action,sequence:++notificationSequence.current})}}/><SettingsMenu current={tab} onSelect={selectTab} name={headerMember?.nickname??session.user.display_name} avatar={<MemberAvatar nickname={headerMember?.nickname??session.user.display_name} avatarUrl={headerMember?.avatar_url} className="topbar-avatar"/>} onLogout={() => void logout()} logoutDisabled={Boolean(pending)}/></div>
          </header>
          <section className="main workspace-main">
            <header ref={workspaceTopbar} className="topbar workspace-topbar">
              <div>
                {launchpadOpen ? null : <h1 id="workspace-page-title">{t(`nav.${tab}`)}</h1>}
              </div>
              <PageTools pageId={tab} client={client} compact/>
              <div className="topbar-actions"><ShareLauncher onChoose={chooseShare} disabled={Boolean(pending)} guided={site?.unified_sharing_enabled===true} onMyContent={site?.personal_content_enabled === true ? () => selectTab('my-content') : undefined}/></div>
            </header>
            <div className="workspace-content">
              <GuideHost pageId={tab} scopeKey={session.user.user_id}
                memberAccess={!error?.accessExpired && !mobileOpen && !pending && (tab !== 'guild-workspace' || canManageGuild) && (!['business', 'stores'].includes(tab) || site?.guild_launchpad_enabled === true)}/>
              <main ref={mainContent} className="workspace-page" id="main-content" tabIndex={-1} aria-labelledby="workspace-page-title">
            {(shareEntry||shareNotice)&&<p className="share-entry-status" role="status">{shareEntry?`正在開啟${SHARE_TARGETS[shareEntry.target].label}…`:shareNotice}</p>}
            {error && (
              <ErrorPanel
                error={error}
                onReload={() => window.location.reload()}
              />
            )}
            <PageLoadBoundary label={t(`nav.${tab}`)} resetKey={tab}>
            {tab === 'account' && <AccountPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'todos' && <MemberTasks client={client} onNavigate={selectTab} />}
            {tab === 'messages' && <MemberMessages registerLeave={registerPageLeave} messageImagesEnabled={site?.message_images_enabled===true} client={client} session={session} memberBlockingEnabled={site?.member_blocking_enabled===true} onNavigate={selectTab} onNotificationAction={action=>{selectTab('social');setNotificationTarget({...action,sequence:++notificationSequence.current})}} chatEntry={chatEntry} initialView={messageView} onNotificationPeer={notificationTarget?.tab==='messages'&&notificationTarget.resource_id?{id:notificationTarget.resource_id,sequence:notificationTarget.sequence}:undefined} />}
            {tab === 'friends' && <FriendsPanel client={client} session={session} memberBlockingEnabled={site?.member_blocking_enabled===true} onNavigate={selectTab} onMessage={id=>{selectTab('messages');setNotificationTarget({tab:'messages',resource_id:id,sequence:++notificationSequence.current});}} />}
            {tab === 'members' && <MembersPanel client={client} session={session} memberBlockingEnabled={site?.member_blocking_enabled===true} onNavigate={selectTab} onMessage={id=>{selectTab('messages');setNotificationTarget({tab:'messages',resource_id:id,sequence:++notificationSequence.current});}} focusRequest={notificationTarget?.tab==='members'&&notificationTarget.resource_id?{id:notificationTarget.resource_id,sequence:notificationTarget.sequence}:undefined} />}
            {tab === 'cocreation' && <CoCreationPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'community' && <CommunityPanel client={client} onNavigate={selectTab} />}
            {tab === 'community-search' && (site?.community_search_enabled === true ? <CommunitySearch key={`${session.user.user_id}:${client.sessionGeneration}`} client={client} authKey={`${session.user.user_id}:${client.sessionGeneration}`} relationsEnabled={site.community_relations_enabled === true}/> : <p>社群內容搜尋尚未開放。</p>)}
            {tab === 'my-content' && (site?.personal_content_enabled === true ? <MyContent key={`${session.user.user_id}:${client.sessionGeneration}`}/> : <p>我的內容尚未開放。</p>)}
            {tab === 'events' && <EventsPanel client={client} session={session} />}
            {tab === 'highlights' && <EventHighlights client={client} />}
            {tab === 'tasks' && <TaskBoardPanel client={client} onNavigate={selectTab} />}
            {tab === 'social' && <SocialZone client={client} viewer={{name: headerMember?.nickname??session.user.display_name, avatarUrl: headerMember?.avatar_url}} focusPost={notificationTarget?.tab==='social'&&notificationTarget.resource_id?{id:notificationTarget.resource_id,sequence:notificationTarget.sequence}:undefined}/>}
            {tab === 'services' && <MemberServices client={client} />}
            {tab === 'promotion' && <PromotionBoards client={client} />}
            {tab === 'skills' && <SkillsPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'squads' && <SquadsPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'workbench' && <WorkbenchPanel />}
            {tab === 'private-ai' && <PrivateWorkAI client={client} key={session.user.user_id}/>}
            {tab === 'showcase' && <ShowcasePanel />}
            {tab === 'engagement' && <EngagementPanel />}
            {tab === 'home' && <MemberHome client={client} session={session} onNavigate={selectTab} />}
            {tab === 'positioning' && <PositioningPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'guilds' && <GuildsPanel client={client} session={session} onNavigate={selectTab} site={site} locationHash={locationHash} registerPendingLeave={registerPageLeave} />}
            {tab === 'guild-workspace' && <MemberGuildWorkspace client={client}/>}
            {tab === 'reservations' && <HostedOrderPage key={`${session.user.user_id}:${client.sessionGeneration}`} client={client} locationHash={locationHash} registerLeave={registerPageLeave} replaceLocation={replaceBuyerLocation} />}
            {tab === 'stores' && <HostedStore client={client} photosEnabled={site?.hosted_store_photos_enabled===true} photoUploadsEnabled={site?.hosted_store_photo_uploads_enabled===true} enabled={site?.guild_launchpad_enabled === true} locationHash={locationHash} userId={session.user.user_id} registerLeave={registerPageLeave} />}
            {tab === 'business' && <TenantSettings client={client} session={session} enabled={site ? site.guild_launchpad_enabled === true : null} />}
            {tab === 'supplier' && <SupplierPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'retail' && <RetailPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'opensource' && <OpenSourcePanel key={session.user.user_id+':'+session.csrf_token} client={client} session={session} onNavigate={selectTab} />}
            {tab === 'marketing' && <MarketingPanel client={client} session={session} onNavigate={selectTab} />}
            </PageLoadBoundary>
              </main>
            </div>
          </section>
        </div>
      </div>
      {tab!=='messages'&&!mobileOpen&&!error?.accessExpired&&<FloatingMessages client={client} onOpen={()=>selectTab('messages')}/>}
    </PortalContext.Provider>
  )
}

function tabTitle(tab: TabId): string {
  return TAB_TITLES[tab]
}

function tabFromHash(launchpadEnabled: boolean): TabId {
  const value = window.location.hash.slice(1)
  if(value === 'reservations' || value.startsWith('reservations/'))return 'reservations'
  if(value.split('?')[0]==='community-search')return 'community-search'
  if(value==='my-content'||value.startsWith('my-content/'))return 'my-content'
  if(value.split('?')[0]==='opensource')return 'opensource'
  if(!value && window.location.pathname === '/device')return 'private-ai'
  if(value.startsWith('events/'))return 'events'
  if(value.startsWith('showcase/'))return 'showcase'
  if(launchpadEnabled && value.startsWith('guilds/'))return 'guilds'
  if(value === 'stores' || value.startsWith('stores/'))return 'stores'
  if(value === 'highlights' || value.startsWith('highlights/'))return 'highlights'
  if(!value&&eventIdFromLocation())return 'events'
  return Object.hasOwn(TAB_TITLES, value) ? value as TabId : 'home'
}
