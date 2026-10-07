import { client, PortalContext, describeError, isOwnRef, type ActionError, type PortalContextValue } from './portal-session'
import { ErrorPanel } from './portal-feedback'
import { WorkbenchPanel } from './modules/WorkbenchPanel'
import { ShowcasePanel } from './modules/ShowcasePanel'
import { EngagementPanel } from './modules/EngagementPanel'
import { Navigation, TAB_TITLES } from './Navigation'
import { SkillsPanel } from './modules/SkillsPanel'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MEMBER_ACCESS_EXPIRED_MESSAGE } from './access-fetch'
import { ApiError } from './api'
import { MemberHome } from './modules/MemberHome'
import {EntryResources} from './modules/EntryResources'
import {CHAT_ENTRY_EVENT,isChatEntry,type ChatEntry} from './modules/chat-entry'
import {FriendsPanel} from './modules/FriendsPanel'
import {PublicMemberPage} from './modules/PublicMemberPage'
import { Onboarding, type OnboardingView } from './modules/Onboarding'
import { AccountPanel, MembersPanel, type MemberCardData } from './modules/Membership'
import { MemberAvatar } from './modules/MemberAvatar'
import { SquadsPanel } from './modules/Squads'
import { CoCreationPanel } from './modules/CoCreationPanel'
import { AdminPanel } from './modules/AdminPanel'
import { GitHubCallback } from './modules/GitHubCallback'
import { GitHubSocialProvider } from './modules/GitHubSocial'
import { AuthorClaimProvider } from './modules/AuthorClaim'
import { SettingsMenu } from './modules/SettingsMenu'
import {NotificationBell,type BellAction} from './modules/NotificationBell'
import { MemberTasks } from './modules/MemberTasks'
import { MemberMessages } from './modules/MemberMessages'
import { EventsPanel } from './modules/EventsPanel'
import { SocialZone } from './modules/SocialZone'
import { MemberServices } from './modules/MemberServices'
import { PromotionBoards } from './modules/PromotionBoards'
import { EventHighlights } from './modules/EventHighlights'
import {PublicEventPage} from './modules/PublicEventPage'
import { TaskBoardPanel } from './modules/TaskBoardPanel'
import { WelcomePreview } from './modules/WelcomePreview'
import {MemberGuildWorkspace} from './modules/GuildWorkspace'
import {TenantSettings} from './modules/TenantSettings'
import {DevelopmentAccessProvider} from './modules/DevelopmentAccess'
import { GameConsoleProvider, GameConsolePopout } from './GameConsole'
import {PageTools} from './PageTools'
import {GuideHost} from './modules/newcomer-guides/GuideHost'
import { logConsoleEvent } from './game-console-core'
import { consoleChannel } from './game-console-routing'
import { BrandPoster, CommunityLinks, CommunityPanel, type SiteConfig } from './modules/Community'
import { PositioningPanel, GuildsPanel } from './modules/PositioningPanels'
import { PublicGuildLaunchpad, guildKeyFromHash } from './modules/GuildLaunchpad'
import { SupplierPanel, RetailPanel } from './modules/CommercePanels'
import { OpenSourcePanel, MarketingPanel } from './modules/OpenSourcePanels'
import { PrivateWorkAI } from './modules/PrivateWorkAI'
import type { SessionPayload, TabId } from './types'

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
  business: '建立業務空間、切換工作區，並邀請仍在本社群的夥伴。',
  community: '查看自由工坊的社群入口和公開資訊。',
  todos: '查看會員待辦事項與可直接前往的操作。',
  messages: '查看收到的訊息與對話。',
  events: '查看社群活動、審核結果與報名狀態。',
  highlights: '活動結束後會自動出現在這裡。這一頁是公開的，參加過的夥伴可以補上照片、海報和影片連結。',
  tasks: '探索工坊工作、GitHub Issue／PR 歷史與已連結 GitHub 的會員排行，查看有來源的驗收紀錄。',
  social: '分享社群貼文連結。每次有人點開只顯示在社群推廣排行榜。',
  services: '列出社員的本業服務。用你的連結分享出去，點擊計入業務推廣排行榜。服務頁是公開的。',
  promotion: '查看六種分享的點擊排行。分數只供比較，不計入經驗或驗收。',
}

export function App() {
  if(new URLSearchParams(window.location.search).get('game-console')==='popout')return <GameConsolePopout client={client}/>
  if(window.location.pathname==='/github/callback')return <GitHubCallback/>
  return window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/') ? <AdminConsoleShell/> : <MemberApp/>
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
  const [phase, setPhase] = useState<'boot' | 'login' | 'ready'>('boot')
  const [session, setSession] = useState<SessionPayload | null>(null)
  const [bootError, setBootError] = useState<ActionError | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)
  const [site, setSite] = useState<SiteConfig | null>(null)
  const [onboarding, setOnboarding] = useState<OnboardingView | null>(null)
  const [gateError, setGateError] = useState('')
  const [exploring,setExploring]=useState(true)
  const [resetToken,setResetToken]=useState(resetTokenFromHash)
  const [publicEventId,setPublicEventId]=useState(eventIdFromLocation)
  const [eventLoginRequested,setEventLoginRequested]=useState(false)
  const [locationHash,setLocationHash]=useState(() => window.location.hash)
  const [siteLoaded,setSiteLoaded]=useState(false)
  const [launchpadLoginRequested,setLaunchpadLoginRequested]=useState(false)
  const [sharedCardToken,setSharedCardToken]=useState(memberCardFromLocation)
  const [memberLoginRequested,setMemberLoginRequested]=useState(false)
  const returnToWorkshop=()=>{window.history.replaceState(null,'','/#home');setSharedCardToken(null);setMemberLoginRequested(false);window.dispatchEvent(new HashChangeEvent('hashchange'));}
  const editOwnCard=()=>{window.history.replaceState(null,'','/#account');setSharedCardToken(null);setMemberLoginRequested(false);window.dispatchEvent(new HashChangeEvent('hashchange'));}
  useEffect(()=>{const changed=()=>{setSharedCardToken(memberCardFromLocation());setMemberLoginRequested(false)};window.addEventListener('popstate',changed);return()=>window.removeEventListener('popstate',changed)},[])
  useEffect(()=>{const changed=()=>setResetToken(resetTokenFromHash());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed)},[])
  useEffect(()=>{const changed=()=>{setLocationHash(window.location.hash);setPublicEventId(eventIdFromLocation());setEventLoginRequested(false);setLaunchpadLoginRequested(false)};window.addEventListener('hashchange',changed);window.addEventListener('popstate',changed);return()=>{window.removeEventListener('hashchange',changed);window.removeEventListener('popstate',changed)}},[])
  const sessionGeneration = useRef(0)
  const loadOnboarding = useCallback(async () => {
    const generation = sessionGeneration.current
    setGateError('')
    try { const value=await client.get<OnboardingView>('/me/onboarding');if(generation===sessionGeneration.current)setOnboarding(value) }
    catch (error) { if(generation===sessionGeneration.current)setGateError(describeError(error).message) }
  }, [])
  useEffect(() => { void client.get<SiteConfig>('/site').then(value => { setSite(value); setSiteLoaded(true) }).catch(() => { setSite(null); setSiteLoaded(true) }) }, [])
  useEffect(() => { if (session) void loadOnboarding(); else setOnboarding(null) }, [session, loadOnboarding])

  const applySession = useCallback((next: SessionPayload) => {
    sessionGeneration.current += 1
    client.csrfToken = next.csrf_token
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
    if(!resetToken&&publicEventId&&!eventLoginRequested)return <PublicEventPage client={client} id={publicEventId} onLogin={()=>setEventLoginRequested(true)}/>;
    const launchpadKey=guildKeyFromHash(locationHash);
    if(!resetToken&&launchpadKey&&site?.guild_launchpad_enabled===true&&!launchpadLoginRequested)return <PublicGuildLaunchpad key={launchpadKey} client={client} guildKey={launchpadKey} onLogin={()=>setLaunchpadLoginRequested(true)}/>;
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
          onLoggedIn={applySession}
          resetToken={resetToken}
          onCancelReset={()=>{clearResetHash();setResetToken(null)}}
          onPasswordReset={()=>{clearResetHash();setResetToken(null);toLogin('密碼已重設，請用新密碼登入。')}}
        />
      </div>
    )
  }

  return (
    <GameConsoleProvider key={session.user.user_id} client={client} userId={session.user.user_id} session={session} feedEnabled={Boolean(onboarding&&(!onboarding.required||onboarding.completed))} standalone={!onboarding||onboarding.required&&!onboarding.completed}>
    {!onboarding ? <div className="centered"><div className="card stack"><h1>自由工坊</h1>{gateError ? <><p role="alert">{gateError}</p><button className="btn btn-primary" onClick={() => void loadOnboarding()}>重新載入定位進度</button></> : <p role="status">正在確認你的定位旅程…</p>}</div></div>
    : onboarding.required && !onboarding.completed ? exploring&&!onboardingStarted(session.user.user_id)
      ? <WelcomePreview client={client} name={session.user.display_name} onCompleted={()=>{rememberOnboarding(session.user.user_id,false);void loadOnboarding()}} onStart={()=>{rememberOnboarding(session.user.user_id,true);setExploring(false)}} onLogout={() => void client.logout(crypto.randomUUID()).then(() => leaveCurrentSession()).catch(error => setGateError(describeError(error).message))}/>
      : <Onboarding client={client} initial={onboarding} profileName={session.user.display_name} onExplore={()=>{rememberOnboarding(session.user.user_id,false);setExploring(true)}} onCompleted={() => { rememberOnboarding(session.user.user_id,false);window.location.hash = 'home'; void loadOnboarding() }} onLogout={() => void client.logout(crypto.randomUUID()).then(() => leaveCurrentSession()).catch(error => setGateError(describeError(error).message))}/>
    : sharedCardToken ? <PublicMemberPage client={client} token={sharedCardToken} session={session} onLogin={()=>{}} onReturn={returnToWorkshop} onEdit={editOwnCard}/> : <>
    <GitHubSocialProvider client={client} session={session}><AuthorClaimProvider client={client}><DevelopmentAccessProvider client={client} session={session}>
    <Workspace
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
  return (
    <div className="demo-banner" role="status">
      這是內部示範工作區。紀錄保存在示範資料庫，沒有實際轉帳或銀行核對。示範帳號為虛構身分，不是真實人士。
    </div>
  )
}

function LoginView({
  site,
  notice,
  bootError,
  onRetrySession,
  onLoggedIn,
  resetToken,
  onCancelReset,
  onPasswordReset,
}: {
  site: SiteConfig | null
  notice: string | null
  bootError: ActionError | null
  onRetrySession: () => void
  onLoggedIn: (session: SessionPayload) => void
  resetToken:string|null
  onCancelReset:()=>void
  onPasswordReset:()=>void
}) {
  const [mode, setMode] = useState<'login' | 'register' | 'request-reset'>('login')
  const activeMode=resetToken?'confirm-reset':mode
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword,setConfirmPassword]=useState('')
  const [resetNotice,setResetNotice]=useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ActionError | null>(null)

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
        await client.post('/auth/reset/confirm',{token:resetToken,password},{skipAuthHandler:true})
        onPasswordReset()
        return
      }
      const session = activeMode === 'register'
        ? await client.register({email:email.trim(),password,nickname:nickname.trim()})
        : await client.login(email.trim(), password)
      if (!session?.user || !session.csrf_token) {
        throw new Error('登入回應不完整')
      }
      onLoggedIn(session)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setPending(false)
    }
  }

  const accessExpired = Boolean(bootError?.accessExpired || error?.accessExpired)
  return (
    <main className="login-layout">
      <section className="login-story"><BrandPoster/><div className="login-story-copy"><h1>加入公會、領取 Repo 技能書，和夥伴一起供貨、開店與做開源作品。</h1><EntryResources client={client}/></div></section>
      <div className="login-form-area">
      <section className="card login-card" aria-labelledby="login-heading">
        <div className="login-page-tools"><PageTools pageId="registration"/></div>
        {!accessExpired && activeMode!=='confirm-reset'&&<div className="auth-switch" role="group" aria-label="登入或建立帳號"><button type="button" className={activeMode==='login'?'selected':''} aria-pressed={activeMode==='login'} onClick={()=>{setMode('login');setError(null);setResetNotice('')}}>會員登入</button>{site?.registration_enabled&&<button type="button" className={activeMode==='register'?'selected':''} aria-pressed={activeMode==='register'} onClick={()=>{setMode('register');setError(null);setResetNotice('')}}>建立帳號</button>}</div>}
        <h2 id="login-heading">{accessExpired ? '網站登入已過期' : activeMode==='register'?'加入自由工坊':activeMode==='request-reset'?'忘記密碼':activeMode==='confirm-reset'?'設定新密碼':'登入'}</h2>
        {notice && !accessExpired && (
          <p className="banner banner-info" role="status">
            {notice}
          </p>
        )}
        {bootError && (
          <ErrorPanel error={bootError} onReload={onRetrySession} reloadLabel="重新確認登入狀態" />
        )}
        {error && <ErrorPanel error={error} />}
        {resetNotice&&<p className="banner banner-info" role="status">{resetNotice}</p>}
        {!accessExpired && <form className="stack" onSubmit={(event) => void onSubmit(event)}>
          {activeMode==='register'&&<p className="registration-progress">1 · 建立帳號　2 · 選公會　3 · 開始參與</p>}
          {activeMode!=='confirm-reset'&&<label className="field">
            <span className="field-label">電子郵件</span>
            <input
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
            <span className="field-label">{activeMode==='confirm-reset'?'新密碼':'密碼'}</span>
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
          {activeMode==='confirm-reset'&&<label className="field">再次輸入新密碼<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)} disabled={pending}/></label>}
          {activeMode==='register'&&<><label className="field"><span className="field-label" id="register-nickname-label">社群顯示名稱</span><input name="nickname" maxLength={60} autoComplete="nickname" aria-labelledby="register-nickname-label" aria-describedby="register-nickname-hint" placeholder="選填，可以稍後再改" value={nickname} onChange={event=>setNickname(event.target.value)} disabled={pending}/><span className="field-hint" id="register-nickname-hint">選填；留白會先使用隨機暱稱，不會公開你的 Email。</span></label><p className="field-hint">只需 Email 和密碼。密碼至少 12 個字元，建議使用密碼管理員。{site?.password_recovery_enabled?'忘記密碼可從登入頁重設。':'請保存密碼，目前未開放信箱找回。'}</p></>}
          {activeMode==='request-reset'&&<p className="field-hint">輸入註冊信箱；若帳號存在，重設連結會寄到信箱，30 分鐘內有效。</p>}
          <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending}>
            {pending ? '處理中…' : activeMode==='register'?'建立帳號，先逛工坊':activeMode==='request-reset'?'寄送重設連結':activeMode==='confirm-reset'?'儲存新密碼':'登入'}
          </button>
        </form>}
        {!accessExpired&&site?.password_recovery_enabled&&activeMode==='login'&&<button type="button" className="btn btn-ghost" onClick={()=>{setMode('request-reset');setError(null);setResetNotice('')}}>忘記密碼？</button>}
        {!accessExpired&&activeMode==='request-reset'&&<button type="button" className="btn btn-ghost" onClick={()=>{setMode('login');setError(null);setResetNotice('')}}>返回登入</button>}
        {!accessExpired&&activeMode==='confirm-reset'&&<button type="button" className="btn btn-ghost" onClick={onCancelReset}>返回登入</button>}
        {!accessExpired && site?.demo_accounts_enabled&&activeMode==='login'&&<aside className="help-box" aria-label="示範帳號">
          <p>
            示範帳號（虛構身分，不是真實人士）。密碼皆為 <code>{DEMO_PASSWORD}</code>。
          </p>
          <div className="chip-row">
            {DEMO_ACCOUNTS.map((account) => (
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
                {account.label}
                <span className="chip-email">{account.email}</span>
              </button>
            ))}
          </div>
        </aside>}
      </section></div>
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
  const [mobileOpen, setMobileOpen] = useState(false)
  const [notificationTarget,setNotificationTarget]=useState<(BellAction&{sequence:number})|null>(null)
  const menuToggle = useRef<HTMLButtonElement>(null)
  const mainContent = useRef<HTMLElement>(null)
  const workspaceTopbar = useRef<HTMLElement>(null)
  const previousTab = useRef(tab)
  useEffect(() => {
    if (previousTab.current === tab) return
    previousTab.current = tab
    logConsoleEvent({channel:consoleChannel('guide_navigation'),kind:'guide',source:'導覽',message:`已進入「${tabTitle(tab)}」。${TAB_GUIDANCE[tab]}`})
    setMobileOpen(false)
    mainContent.current?.focus({ preventScroll: true })
    workspaceTopbar.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [tab])
  const selectTab = useCallback((next: TabId) => {
    setMobileOpen(false)
    mainContent.current?.focus({ preventScroll: true })
    setTab(next)
    if(/^\/events\/[0-9a-f-]{36}\/?$/.test(window.location.pathname)){
      window.history.replaceState(null,'',`/#${next}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
    else window.location.hash = next
  }, [])
  const [chatEntry,setChatEntry]=useState<ChatEntry|null>(null)
  useEffect(()=>{
    const open=(event:Event)=>{const value=(event as CustomEvent).detail;if(!isChatEntry(value))return;setChatEntry(current=>({...value,request:(current?.request??0)+1}));selectTab('messages')}
    window.addEventListener(CHAT_ENTRY_EVENT,open);return()=>window.removeEventListener(CHAT_ENTRY_EVENT,open)
  },[selectTab])
  const launchpadEnabled = site?.guild_launchpad_enabled === true
  useEffect(() => {
    setLocationHash(window.location.hash)
    setTab(tabFromHash(launchpadEnabled))
  }, [launchpadEnabled])
  useEffect(() => {
    const changed = () => { setLocationHash(window.location.hash); setTab(tabFromHash(launchpadEnabled)) }
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
      <div className="app-frame">
        {site?.demo_accounts_enabled && <DemoBanner />}
        <a className="skip" href="#main-content" onClick={event => { event.preventDefault(); mainContent.current?.focus(); }}>
          跳到主要內容
        </a>
        <div className="shell">
          <aside className="sidebar" onKeyDown={event => { if (event.key === 'Escape' && mobileOpen) { setMobileOpen(false); menuToggle.current?.focus(); } }}>
            <div className="sidebar-heading"><div className="brand">
              <img className="sidebar-brand-art" src="/brand/freedom-workshop.webp" alt="" width="1280" height="720"/>
              <div>
                <p className="eyebrow">FREEDOM WORKSHOP</p>
                <strong>自由工坊</strong>
              </div>
            </div>
            <button ref={menuToggle} type="button" className="btn btn-ghost mobile-menu-toggle" aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => setMobileOpen(value => !value)}>{mobileOpen ? '關閉選單' : '開啟選單'}</button></div>
            <Navigation current={tab} onSelect={selectTab} canManageGuild={canManageGuild} guildLaunchpadEnabled={site?.guild_launchpad_enabled === true} mobileOpen={mobileOpen}/>
          </aside>
          <section className="main workspace-main">
            <header ref={workspaceTopbar} className="topbar workspace-topbar">
              <div>
                {launchpadOpen ? null : <h1 id="workspace-page-title">{tabTitle(tab)}</h1>}
              </div>
              <PageTools pageId={tab} client={client}/>
              <div className="topbar-actions"><NotificationBell client={client} onOpen={()=>selectTab('messages')} onNavigate={action=>{setNotificationTarget(current=>({...action,sequence:(current?.sequence??0)+1}));selectTab(action.tab)}}/><SettingsMenu current={tab} onSelect={selectTab} name={headerMember?.nickname??session.user.display_name} avatar={<MemberAvatar nickname={headerMember?.nickname??session.user.display_name} avatarUrl={headerMember?.avatar_url} className="topbar-avatar"/>} onLogout={() => void logout()} logoutDisabled={Boolean(pending)}/></div>
            </header>
            <div className="workspace-content">
              <GuideHost pageId={tab} scopeKey={session.user.user_id}
                memberAccess={!error?.accessExpired && !mobileOpen && !pending && (tab !== 'guild-workspace' || canManageGuild) && (tab !== 'business' || site?.guild_launchpad_enabled === true)}/>
              <main ref={mainContent} className="workspace-page" id="main-content" tabIndex={-1} aria-labelledby="workspace-page-title">
            {error && (
              <ErrorPanel
                error={error}
                onReload={() => window.location.reload()}
              />
            )}
            {tab === 'account' && <AccountPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'todos' && <MemberTasks client={client} onNavigate={selectTab} />}
            {tab === 'messages' && <MemberMessages client={client} session={session} onNavigate={selectTab} chatEntry={chatEntry} onNotificationPeer={notificationTarget?.tab==='messages'&&notificationTarget.resource_id?{id:notificationTarget.resource_id,sequence:notificationTarget.sequence}:undefined} />}
            {tab === 'friends' && <FriendsPanel client={client} session={session} onNavigate={selectTab} onMessage={id=>{setNotificationTarget(current=>({tab:'messages',resource_id:id,sequence:(current?.sequence??0)+1}));selectTab('messages');}} />}
            {tab === 'members' && <MembersPanel client={client} session={session} onNavigate={selectTab} onMessage={id=>{setNotificationTarget(current=>({tab:'messages',resource_id:id,sequence:(current?.sequence??0)+1}));selectTab('messages');}} focusRequest={notificationTarget?.tab==='members'&&notificationTarget.resource_id?{id:notificationTarget.resource_id,sequence:notificationTarget.sequence}:undefined} />}
            {tab === 'cocreation' && <CoCreationPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'community' && <CommunityPanel client={client} onNavigate={selectTab} />}
            {tab === 'events' && <EventsPanel client={client} session={session} />}
            {tab === 'highlights' && <EventHighlights client={client} />}
            {tab === 'tasks' && <TaskBoardPanel client={client} onNavigate={selectTab} />}
            {tab === 'social' && <SocialZone client={client} />}
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
            {tab === 'guilds' && <GuildsPanel client={client} session={session} onNavigate={selectTab} site={site} />}
            {tab === 'guild-workspace' && <MemberGuildWorkspace client={client}/>}
            {tab === 'business' && <TenantSettings client={client} session={session} enabled={site ? site.guild_launchpad_enabled === true : null} />}
            {tab === 'supplier' && <SupplierPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'retail' && <RetailPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'opensource' && <OpenSourcePanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'marketing' && <MarketingPanel client={client} session={session} onNavigate={selectTab} />}
              </main>
            </div>
          </section>
        </div>
      </div>
    </PortalContext.Provider>
  )
}

function tabTitle(tab: TabId): string {
  return TAB_TITLES[tab]
}

function tabFromHash(launchpadEnabled: boolean): TabId {
  const value = window.location.hash.slice(1)
  if(!value && window.location.pathname === '/device')return 'private-ai'
  if(value.startsWith('events/'))return 'events'
  if(launchpadEnabled && value.startsWith('guilds/'))return 'guilds'
  if(value === 'highlights' || value.startsWith('highlights/'))return 'highlights'
  if(!value&&eventIdFromLocation())return 'events'
  return Object.hasOwn(TAB_TITLES, value) ? value as TabId : 'home'
}
