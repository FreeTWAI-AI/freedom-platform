import { WorkshopIcon } from './WorkshopIcon'
import { ModuleBanner } from './modules/ModuleBanner'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, PortalClient, requireDashboard, requireItems } from './api'
import { MemberHome } from './modules/MemberHome'
import { Onboarding, type OnboardingView } from './modules/Onboarding'
import { AccountPanel, MembersPanel, type MemberCardData } from './modules/Membership'
import { MemberAvatar } from './modules/MemberAvatar'
import { SquadsPanel } from './modules/Squads'
import { CoCreationPanel } from './modules/CoCreationPanel'
import { AdminPanel } from './modules/AdminPanel'
import { GitHubCallback } from './modules/GitHubCallback'
import { GitHubSocialProvider } from './modules/GitHubSocial'
import {MemberGuildWorkspace} from './modules/GuildWorkspace'
import { DevelopmentContext } from './modules/DevelopmentContext'
import { BenefitObservations } from './modules/BenefitObservations'
import { BrandPoster, CommunityLinks, CommunityPanel, type SiteConfig } from './modules/Community'
import { PositioningPanel, GuildsPanel } from './modules/PositioningPanels'
import { SupplierPanel, RetailPanel } from './modules/CommercePanels'
import { OpenSourcePanel, MarketingPanel } from './modules/OpenSourcePanels'
import {
  claimStateLabel,
  engagementStateLabel,
  formatIsoLocal,
  formatMinor,
  hoursFromNowLocalInput,
  isPastIso,
  localInputToIso,
  looksLikeUrl,
  opportunityStateLabel,
  parseMajorToMinor,
  participationModeLabel,
  workStateLabel,
} from './format'
import type {
  Dashboard,
  Engagement,
  Opportunity,
  ReviewQueueItem,
  SessionPayload,
  Showcase,
  TabId,
  User,
  WorkClaim,
  WorkItem,
} from './types'

const client = new PortalClient()

const DEMO_ACCOUNTS = [
  { email: 'maker@local.test', label: '作者示範帳號' },
  { email: 'reviewer@local.test', label: '回饋示範帳號' },
  { email: 'client@local.test', label: '委託示範帳號' },
] as const
const DEMO_PASSWORD = 'freedom-local-demo'

type ActionError = {
  message: string
  network: boolean
  conflict: boolean
  retry?: () => void
}

type PortalContextValue = {
  session: SessionPayload
  pending: string | null
  error: ActionError | null
  mutate: (actionId: string, fn: (key: string) => Promise<void>) => Promise<boolean>
  clearError: () => void
  isMe: (ref: string | null | undefined) => boolean
}

const PortalContext = React.createContext<PortalContextValue | null>(null)

function usePortal(): PortalContextValue {
  const ctx = React.useContext(PortalContext)
  if (!ctx) throw new Error('工作區內容尚未就緒')
  return ctx
}

function isOwnRef(user: User, ref: string | null | undefined): boolean {
  if (!ref) return false
  return ref === user.user_id || ref === user.profession_membership_ref || ref === user.email
}

function describeError(err: unknown): ActionError {
  if (err instanceof ApiError) {
    return {
      message: err.message,
      network: err.network,
      conflict: err.conflict,
    }
  }
  if (err instanceof Error) {
    return { message: err.message, network: false, conflict: false }
  }
  return { message: '發生未預期的錯誤', network: false, conflict: false }
}

export function App() {
  if(window.location.pathname==='/github/callback')return <GitHubCallback/>
  return window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/') ? <><AdminPanel/><DevelopmentContext moduleId="admin"/></> : <MemberApp/>
}

function MemberApp() {
  const [phase, setPhase] = useState<'boot' | 'login' | 'ready'>('boot')
  const [session, setSession] = useState<SessionPayload | null>(null)
  const [bootError, setBootError] = useState<ActionError | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)
  const [site, setSite] = useState<SiteConfig | null>(null)
  const [onboarding, setOnboarding] = useState<OnboardingView | null>(null)
  const [gateError, setGateError] = useState('')
  const sessionGeneration = useRef(0)
  const loadOnboarding = useCallback(async () => {
    const generation = sessionGeneration.current
    setGateError('')
    try { const value=await client.get<OnboardingView>('/me/onboarding');if(generation===sessionGeneration.current)setOnboarding(value) }
    catch (error) { if(generation===sessionGeneration.current)setGateError(describeError(error).message) }
  }, [])
  useEffect(() => { void client.get<SiteConfig>('/site').then(setSite).catch(() => setSite(null)) }, [])
  useEffect(() => { if (session) void loadOnboarding(); else setOnboarding(null) }, [session, loadOnboarding])

  const applySession = useCallback((next: SessionPayload) => {
    sessionGeneration.current += 1
    client.csrfToken = next.csrf_token
    setOnboarding(null)
    setSession(next)
    setPhase('ready')
    setBootError(null)
    setLoginNotice(null)
  }, [])

  const toLogin = useCallback((notice?: string) => {
    sessionGeneration.current += 1
    client.csrfToken = null
    setOnboarding(null)
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
      if (err instanceof ApiError && err.unauthorized) {
        toLogin()
        return
      }
      setBootError(describeError(err))
      setPhase('login')
    }
  }, [applySession, toLogin])

  useEffect(() => {
    client.onUnauthorized = () => toLogin('登入已過期，請重新登入。')
    void bootstrap()
    return () => {
      client.onUnauthorized = null
    }
  }, [bootstrap, toLogin])

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

  if (phase !== 'ready' || !session) {
    return (
      <div className="app-frame">
        {site?.demo_accounts_enabled && <DemoBanner />}
        <LoginView
          site={site}
          notice={loginNotice}
          bootError={bootError}
          onRetrySession={() => void bootstrap()}
          onLoggedIn={applySession}
        />
      </div>
    )
  }

  if (!onboarding) return <div className="centered"><div className="card stack"><h1>自由工坊</h1>{gateError ? <><p role="alert">{gateError}</p><button className="btn btn-primary" onClick={() => void loadOnboarding()}>重新載入定位進度</button></> : <p role="status">正在確認你的定位旅程…</p>}</div></div>
  if (onboarding.required && !onboarding.completed) return <Onboarding client={client} initial={onboarding} onCompleted={() => { window.location.hash = 'home'; void loadOnboarding() }} onLogout={() => void client.logout(crypto.randomUUID()).then(() => toLogin()).catch(error => setGateError(describeError(error).message))}/>

  return (
    <GitHubSocialProvider client={client} session={session}>
    <Workspace
      site={site}
      session={session}
      onLoggedOut={() => toLogin()}
      onSessionExpired={() => toLogin('登入已過期，請重新登入。')}
    />
    </GitHubSocialProvider>
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
}: {
  site: SiteConfig | null
  notice: string | null
  bootError: ActionError | null
  onRetrySession: () => void
  onLoggedIn: (session: SessionPayload) => void
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ActionError | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const session = mode === 'register'
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

  return (
    <main className="login-layout">
      <section className="login-story"><BrandPoster/><div className="login-story-copy"><p className="eyebrow">BUILD WITHOUT LIMITS</p><h1>找到你的定位。<br/>和夥伴一起，把想法做出來。</h1><p>加入專業公會，領取技能書。從供貨、開店到開源創作，每種專長都能成為起點。</p><ol className="login-journey"><li><span>01 / DISCOVER</span>找到你的定位</li><li><span>02 / BELONG</span>加入你的公會</li><li><span>03 / CREATE</span>一起做出作品</li></ol></div></section>
      <div className="login-form-area"><header className="login-brand">
        <span className="mark" aria-hidden="true" />
        <div>
          <p className="eyebrow">FREEDOM WORKSHOP</p>
          <h2>自由工坊</h2>
        </div>
      </header>
      <section className="card login-card" aria-labelledby="login-heading">
        <div className="auth-switch"><button type="button" className={mode==='login'?'selected':''} onClick={()=>{setMode('login');setError(null)}}>會員登入</button>{site?.registration_enabled&&<button type="button" className={mode==='register'?'selected':''} onClick={()=>{setMode('register');setError(null)}}>建立帳號</button>}</div>
        <h2 id="login-heading">{mode==='register'?'加入自由工坊':'登入'}</h2>
        <p className="lede">{mode==='register'?'先認識你的專長，再找公會與夥伴。':'歡迎回來，繼續你的作品與合作。'}</p>
        {notice && (
          <p className="banner banner-info" role="status">
            {notice}
          </p>
        )}
        {bootError && (
          <ErrorPanel error={bootError} onReload={onRetrySession} reloadLabel="重新確認登入狀態" />
        )}
        {error && <ErrorPanel error={error} />}
        <form className="stack" onSubmit={(event) => void onSubmit(event)}>
          {mode==='register'&&<label className="field"><span className="field-label">喜歡的暱稱</span><input name="nickname" required minLength={1} maxLength={60} autoComplete="nickname" value={nickname} onChange={event=>setNickname(event.target.value)} disabled={pending}/></label>}
          <label className="field">
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
          </label>
          <label className="field">
            <span className="field-label">密碼</span>
            <input
              name="password"
              type="password"
              autoComplete={mode==='register'?'new-password':'current-password'}
              minLength={mode==='register'?12:undefined}
              maxLength={128}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
            />
          </label>
          {mode==='register'&&<><p className="field-hint">密碼至少 12 個字元。請妥善保存，目前無法用 E-mail 找回密碼。</p><p className="field-hint">Email 同時用於登入與聯絡，預設不公開。之後可在「我的名片」調整。</p></>}
          <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending}>
            {pending ? (mode==='register'?'建立帳號中…':'登入中…') : (mode==='register'?'註冊並開始定位':'登入')}
          </button>
        </form>
        {site?.demo_accounts_enabled&&mode==='login'&&<aside className="help-box" aria-label="示範帳號">
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
      <DevelopmentContext moduleId="registration"/>
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
  useEffect(()=>{let active=true;const refresh=()=>void client.get<{managed_guilds:unknown[];managed_books:unknown[];can_discuss:boolean}>('/guild-workspace').then(value=>{if(active)setCanManageGuild(Boolean(value.can_discuss||value.managed_guilds.length||value.managed_books.length))}).catch(()=>{if(active)setCanManageGuild(false)});refresh();window.addEventListener('focus',refresh);return()=>{active=false;window.removeEventListener('focus',refresh)}},[session.user.user_id])
  useEffect(()=>{let active=true,generation=0;const refresh=()=>{const current=++generation;void client.get<MemberCardData>(`/members/${session.user.user_id}`).then(value=>{if(active&&current===generation)setHeaderMember(value)}).catch(()=>{})};refresh();window.addEventListener('freedom-profile-updated',refresh);return()=>{active=false;generation++;window.removeEventListener('freedom-profile-updated',refresh)}},[session.user.user_id])
  const [tab, setTab] = useState<TabId>(() => tabFromHash())
  const selectTab = useCallback((next: TabId) => {
    setTab(next)
    window.location.hash = next
  }, [])
  useEffect(() => {
    const changed = () => setTab(tabFromHash())
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
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
        <a className="skip" href="#main-content">
          跳到主要內容
        </a>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <img className="sidebar-brand-art" src="/brand/freedom-workshop.webp" alt="" width="1280" height="720"/>
              <div>
                <p className="eyebrow">FREEDOM WORKSHOP</p>
                <strong>自由工坊</strong>
              </div>
            </div>
            <nav className="nav" aria-label="主要工作區">
              <TabButton current={tab} id="home" onSelect={selectTab}>會員首頁</TabButton>
              <TabButton current={tab} id="positioning" onSelect={selectTab}>我的定位</TabButton>
              <TabButton current={tab} id="guilds" onSelect={selectTab}>職業公會</TabButton>
              {canManageGuild&&<TabButton current={tab} id="guild-workspace" onSelect={selectTab}>公會與技能管理</TabButton>}
              <TabButton current={tab} id="squads" onSelect={selectTab}>小隊集合</TabButton>
              <span className="nav-group-label">參與平台</span>
              <TabButton current={tab} id="supplier" onSelect={selectTab}>供貨中心</TabButton>
              <TabButton current={tab} id="retail" onSelect={selectTab}>開店與銷售</TabButton>
              <TabButton current={tab} id="opensource" onSelect={selectTab}>開源作品</TabButton>
              <TabButton current={tab} id="cocreation" onSelect={selectTab}>一起開發</TabButton>
              <TabButton current={tab} id="marketing" onSelect={selectTab}>行銷工作室</TabButton>
              <span className="nav-group-label">我的協作</span>
              <TabButton current={tab} id="workbench" onSelect={selectTab}>我的工作</TabButton>
              <TabButton current={tab} id="showcase" onSelect={selectTab}>一般作品與需求</TabButton>
              <TabButton current={tab} id="engagement" onSelect={selectTab}>合作紀錄</TabButton>
              <TabButton current={tab} id="community" onSelect={selectTab}>自由工坊社群</TabButton>
              <a className="nav-item" href="/admin">平台管理 ↗</a>
            </nav>
            <p className="sidebar-note">不同專長，各自發展。<br />需要合作時，在這裡相遇。</p>
          </aside>
          <div className="main" id="main-content">
            <header className="topbar">
              <div>
                <p className="workspace-eyebrow">FREEDOM WORKSHOP / 共同創造，自由成長</p>
                <h1>{tabTitle(tab)}</h1>
                <p className="muted">
                  {headerMember?.nickname??session.user.display_name}{headerMember?.positioning_title?` · ${headerMember.positioning_title}`:' · 自由工坊會員'}{headerMember?.primary_guild?` · ${headerMember.primary_guild.name}`:''}
                </p>
              </div>
              <div className="topbar-actions"><button className="btn btn-ghost topbar-profile" aria-label="我的名片" type="button" onClick={()=>selectTab('account')}><MemberAvatar nickname={headerMember?.nickname??session.user.display_name} avatarUrl={headerMember?.avatar_url} className="topbar-avatar"/>我的名片</button><button className="btn btn-ghost" type="button" onClick={()=>selectTab('members')}>工坊夥伴</button><button className="btn btn-ghost" type="button" onClick={() => void logout()} disabled={Boolean(pending)}>
                登出
              </button></div>
            </header>
            {error && (
              <ErrorPanel
                error={error}
                onReload={() => window.location.reload()}
              />
            )}
            {tab === 'account' && <AccountPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'members' && <MembersPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'cocreation' && <CoCreationPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'community' && <CommunityPanel client={client} />}
            {tab === 'squads' && <SquadsPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'workbench' && <WorkbenchPanel />}
            {tab === 'showcase' && <ShowcasePanel />}
            {tab === 'engagement' && <EngagementPanel />}
            {tab === 'home' && <MemberHome client={client} session={session} onNavigate={selectTab} />}
            {tab === 'positioning' && <PositioningPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'guilds' && <GuildsPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'guild-workspace' && <MemberGuildWorkspace client={client}/>}
            {tab === 'supplier' && <SupplierPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'retail' && <RetailPanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'opensource' && <OpenSourcePanel client={client} session={session} onNavigate={selectTab} />}
            {tab === 'marketing' && <MarketingPanel client={client} session={session} onNavigate={selectTab} />}
            <DevelopmentContext moduleId={tab}/>
          </div>
        </div>
      </div>
    </PortalContext.Provider>
  )
}

function tabTitle(tab: TabId): string {
  return TAB_TITLES[tab]
}

const TAB_TITLES: Record<TabId, string> = {
  'guild-workspace':'公會與技能管理',
  cocreation:'一起開發', account:'我的名片', members:'工坊夥伴', community:'自由工坊社群', squads:'小隊集合',
  home: '會員首頁', positioning: '我的定位', guilds: '職業公會', supplier: '供貨中心', retail: '開店與銷售',
  opensource: '開源作品', marketing: '行銷工作室', workbench: '工作台', showcase: '一般作品與需求', engagement: '合作紀錄',
}
function tabFromHash(): TabId {
  const value = window.location.hash.slice(1)
  return Object.hasOwn(TAB_TITLES, value) ? value as TabId : 'home'
}

function TabButton({
  current,
  id,
  onSelect,
  children,
}: {
  current: TabId
  id: TabId
  onSelect: (id: TabId) => void
  children: React.ReactNode
}) {
  const selected = current === id
  return (
    <button
      type="button"
      className={selected ? 'nav-item is-active' : 'nav-item'}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(id)}
    >
      <WorkshopIcon name={id}/><span>{children}</span>
    </button>
  )
}

function WorkbenchPanel() {
  const { session, pending, mutate } = usePortal()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ActionError | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [items, setItems] = useState<WorkItem[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [dashPayload, itemsPayload] = await Promise.all([
        client.get<unknown>('/dashboard'),
        client.get<unknown>('/work-items'),
      ])
      setDashboard(requireDashboard<Dashboard>(dashPayload))
      setItems(requireItems<WorkItem>(itemsPayload, '工作列表'))
    } catch (err) {
      setDashboard(null)
      setItems(null)
      setLoadError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.user_id])

  if (loading && !dashboard) {
    return <p className="muted" role="status">載入工作台…</p>
  }
  if (loadError || !dashboard || !items) {
    return <ErrorPanel error={loadError ?? { message: '無法顯示工作台', network: false, conflict: false }} onReload={() => void load()} />
  }

  const seen = new Set([...dashboard.now, ...dashboard.next].map((item) => item.work_item_id))
  const catalog = items.filter((item) => !item.my_claim && !seen.has(item.work_item_id))

  return (
    <div className="panels">
      <ModuleBanner eyebrow="YOUR QUESTS / 協作任務" title="每一份貢獻，都有下一步" description="認領一件做得到的事，提交成果，留下當事人確認的合作紀錄。" art="/art/rpg/cooperation-forge.webp"/>
      <section className="summary-strip" aria-label="成果摘要">
        <div>
          <span className="summary-label">已接受成果</span>
          <strong>{dashboard.summary.accepted_count}</strong>
        </div>
        <p>成果由合作當事人確認，不代表官方認證。</p>
      </section>

      <Section title="現在進行" description="你正在處理的互助工作。">
        <WorkItemList
          items={dashboard.now}
          empty="目前沒有進行中的工作。可從下方認領，或發布一張自願互助卡。"
          pending={pending}
          mutate={mutate}
          onChanged={load}
        />
      </Section>

      <Section title="接下來" description="即將或建議接著處理的項目。">
        <WorkItemList items={dashboard.next} empty="接下來沒有待辦。開放中的工作會顯示在認領列表。" pending={pending} mutate={mutate} onChanged={load} />
      </Section>

      <Section title="其他社群工作" description="查看社群工作的進度；開放認領的工作列在上方。">
        <WorkItemList items={catalog} empty="目前沒有可認領的工作。你可以發布一張，或稍後再來看。" pending={pending} mutate={mutate} onChanged={load} />
      </Section>

      <Section title="待你回饋" description="只列出目前指派給你的項目。實際貢獻者不能審自己的提交。">
        {dashboard.review_queue.length === 0 ? (
          <EmptyState title="沒有待回饋項目" body="有指派給你的提交時會出現在這裡。沒有指派就不顯示回饋操作。" />
        ) : (
          <div className="card-grid">
            {dashboard.review_queue.map((entry) => (
              <ReviewCard key={entry.claim.claim_id} entry={entry} pending={pending} mutate={mutate} onChanged={load} />
            ))}
          </div>
        )}
      </Section>

      <Section title="已獲得的成果" description="當事人已接受的提交紀錄，非正式官方標示。">
        {dashboard.gained.length === 0 ? (
          <EmptyState title="還沒有已接受的成果" body="完成認領、提交並經對方接受後，會顯示在這裡。" />
        ) : (
          <div className="card-grid">
            {dashboard.gained.map((gain) => (
              <article key={gain.contribution_id} className="card">
                <h3>{gain.title}</h3>
                <p>{gain.summary}</p>
                <dl className="meta">
                  <div>
                    <dt>成果引用</dt>
                    <dd>
                      <code>{gain.artifact_ref}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>接受時間</dt>
                    <dd>{formatIsoLocal(gain.accepted_at)}</dd>
                  </div>
                </dl>
                <BenefitObservations client={client} workItemId={gain.work_item_id}/>
              </article>
            ))}
          </div>
        )}
      </Section>

      <CreateWorkForm pending={pending} mutate={mutate} onCreated={load} />
    </div>
  )
}

function WorkItemList({
  items,
  empty,
  pending,
  mutate,
  onChanged,
}: {
  items: WorkItem[]
  empty: string
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  if (items.length === 0) return <EmptyState title="目前沒有項目" body={empty} />
  return (
    <div className="card-grid">
      {items.map((item) => (
        <WorkItemCard key={item.work_item_id} item={item} pending={pending} mutate={mutate} onChanged={onChanged} />
      ))}
    </div>
  )
}

function WorkItemCard({
  item,
  pending,
  mutate,
  onChanged,
}: {
  item: WorkItem
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { session } = usePortal()
  const claim = item.my_claim
  const busy = Boolean(pending)
  const claimExpired = isPastIso(item.claim_window_expires_at)
  const [summary, setSummary] = useState('')
  const [artifactRef, setArtifactRef] = useState('artifact:template-v1')
  const [formError, setFormError] = useState<string | null>(null)

  async function claimItem() {
    if (!session.user.profession_membership_ref) return
    const ok = await mutate(`claim:${item.work_item_id}`, async (key) => {
      await client.post<WorkClaim>(
        `/work-items/${item.work_item_id}:claim`,
        {
          claimant_type: 'user',
          acting_profession_membership_ref: session.user.profession_membership_ref,
          expected_aggregate_version: item.aggregate_version,
          terms_status: 'declared',
          participation_terms_revision: item.participation_terms_revision,
          participation_terms_sha256: item.participation_terms_sha256,
        },
        { idempotencyKey: key, ifMatch: item.aggregate_version },
      )
    })
    if (ok) await onChanged()
  }

  async function startClaim() {
    if (!claim) return
    const ok = await mutate(`start:${claim.claim_id}`, async (key) => {
      await client.post(`/work-claims/${claim.claim_id}:start`, {}, { idempotencyKey: key, ifMatch: claim.aggregate_version })
    })
    if (ok) await onChanged()
  }

  async function submitClaim(event: React.FormEvent) {
    event.preventDefault()
    if (!claim) return
    setFormError(null)
    const artifact = artifactRef.trim()
    if (!artifact || looksLikeUrl(artifact)) {
      setFormError('成果引用須為不透明代號，例如 artifact:template-v1，不可填網址或私人資料')
      return
    }
    const ok = await mutate(`submit:${claim.claim_id}`, async (key) => {
      await client.post(
        `/work-claims/${claim.claim_id}:submit`,
        { summary: summary.trim(), artifact_ref: artifact },
        { idempotencyKey: key, ifMatch: claim.aggregate_version },
      )
    })
    if (ok) {
      setSummary('')
      await onChanged()
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3>{item.title}</h3>
        <div className="pill-row">
          <span className="pill">{workStateLabel(item.state)}</span>
          {claim && <span className="pill pill-green">{claimStateLabel(claim.state)}</span>}
          {item.review_capacity === 'waiting_reviewer_capacity' && <span className="pill">尚無回饋容量</span>}
        </div>
      </div>
      <p>{item.objective}</p>
      <dl className="meta">
        <div>
          <dt>完成條件</dt>
          <dd>{item.acceptance_criteria}</dd>
        </div>
        <div>
          <dt>幫助者當次收益</dt>
          <dd>{item.gain}</dd>
        </div>
        <div>
          <dt>認領期限</dt>
          <dd>{formatIsoLocal(item.claim_window_expires_at)}</dd>
        </div>
        <div>
          <dt>完成期限</dt>
          <dd>{formatIsoLocal(item.due_at)}</dd>
        </div>
        {item.participation_terms?.participation_mode && (
          <div>
            <dt>參與方式</dt>
            <dd>{participationModeLabel(item.participation_terms.participation_mode)}</dd>
          </div>
        )}
      </dl>
      {item.participation_terms?.reuse?.consent_required && <p className="hint">{!item.participation_terms.reuse.artifact_license_ref||item.participation_terms.reuse.artifact_license_ref==='local-demo-author-consent'?'成果重用前仍需取得權利人同意；目前未記錄明確授權。':'成果重用前請確認記錄的授權與權利人同意。'}</p>}
      {item.review_capacity === 'waiting_reviewer_capacity' && (
        <p className="hint">目前沒有回饋容量，仍可認領與提交，但不保證有人回饋，也不表示官方品管。</p>
      )}
      {claim?.feedback && (
        <p className="feedback">
          <strong>回饋：</strong>
          {claim.feedback}
        </p>
      )}
      {claim?.latest_submission && (
        <p className="hint">
          最近提交：{claim.latest_submission.summary}（<code>{claim.latest_submission.artifact_ref}</code>）
        </p>
      )}
      {!claim && item.state === 'open' && item.owner_ref !== session.user.user_id && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || claimExpired || !session.user.profession_membership_ref}
            onClick={() => void claimItem()}
          >
            認領這張工作
          </button>
          {claimExpired && <p className="hint">認領期限已過。</p>}
        </div>
      )}
      {claim?.state === 'claimed' && (
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void startClaim()}>
            開始進行
          </button>
        </div>
      )}
      {claim && (claim.state === 'in_progress' || claim.state === 'changes_requested') && (
        <form className="stack" onSubmit={(event) => void submitClaim(event)}>
          {formError && (
            <p className="banner banner-error" role="alert">
              {formError}
            </p>
          )}
          <label className="field">
            <span className="field-label">提交摘要</span>
            <textarea required rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">成果引用（例如 artifact:template-v1）</span>
            <input
              required
              value={artifactRef}
              onChange={(event) => setArtifactRef(event.target.value)}
              disabled={busy}
              placeholder="artifact:template-v1"
            />
            <span className="field-hint">填成果代號，例如 artifact:logo-v1。檔案另行分享，別貼含登入權限的連結或私人資料。</span>
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            提交成果
          </button>
        </form>
      )}
      {claim?.state === 'submitted' && <p className="hint">已提交，等待回饋。</p>}
      {claim?.state === 'in_review' && <p className="hint">回饋進行中。</p>}
      {claim?.state === 'accepted' && <p className="hint">這次提交已被接受，非正式官方品管。</p>}
      {(isOwnRef(session.user,item.owner_ref)||(claim&&claim.state!=='claimed'))&&<BenefitObservations client={client} workItemId={item.work_item_id}/>}
    </article>
  )
}

function ReviewCard({
  entry,
  pending,
  mutate,
  onChanged,
}: {
  entry: ReviewQueueItem
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { isMe } = usePortal()
  const [decision, setDecision] = useState<'accept' | 'changes_requested'>('accept')
  const [feedback, setFeedback] = useState('')
  const busy = Boolean(pending)
  const self = isMe(entry.claim.claimant_ref)

  if (self) {
    return (
      <article className="card">
        <h3>{entry.work_item.title}</h3>
        <p className="hint">實際貢獻者不能回饋自己的提交。</p>
      </article>
    )
  }

  async function beginReview() {
    const ok = await mutate(`begin-review:${entry.claim.claim_id}`, async (key) => {
      await client.post(`/work-claims/${entry.claim.claim_id}:begin-review`, {}, {
        idempotencyKey: key,
        ifMatch: entry.claim.aggregate_version,
      })
    })
    if (ok) await onChanged()
  }

  async function decide(event: React.FormEvent) {
    event.preventDefault()
    const sha = entry.claim.latest_submission?.sha256
    if (!sha) return
    if (decision === 'changes_requested' && !feedback.trim()) return
    const ok = await mutate(`decide:${entry.claim.claim_id}`, async (key) => {
      await client.post(
        `/work-claims/${entry.claim.claim_id}:decide`,
        {
          decision,
          feedback: feedback.trim(),
          submission_sha256: sha,
        },
        { idempotencyKey: key, ifMatch: entry.claim.aggregate_version },
      )
    })
    if (ok) await onChanged()
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3>{entry.work_item.title}</h3>
        <span className="pill pill-green">{claimStateLabel(entry.claim.state)}</span>
      </div>
      <p>提交者：{entry.claimant_name}</p>
      {entry.claim.latest_submission ? (
        <p>
          提交摘要：{entry.claim.latest_submission.summary}（<code>{entry.claim.latest_submission.artifact_ref}</code>）
        </p>
      ) : (
        <p className="hint">尚無提交成果，無法作成決定。</p>
      )}
      {entry.claim.state === 'submitted' && (
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void beginReview()}>
            開始回饋
          </button>
        </div>
      )}
      {entry.claim.state === 'in_review' && entry.claim.latest_submission && (
        <form className="stack" onSubmit={(event) => void decide(event)}>
          <fieldset className="fieldset">
            <legend>決定</legend>
            <label className="choice">
              <input
                type="radio"
                name={`decision-${entry.claim.claim_id}`}
                checked={decision === 'accept'}
                onChange={() => setDecision('accept')}
                disabled={busy}
              />
              接受這次提交
            </label>
            <label className="choice">
              <input
                type="radio"
                name={`decision-${entry.claim.claim_id}`}
                checked={decision === 'changes_requested'}
                onChange={() => setDecision('changes_requested')}
                disabled={busy}
              />
              請對方調整
            </label>
          </fieldset>
          <label className="field">
            <span className="field-label">回饋說明</span>
            <textarea
              rows={3}
              required
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            送出決定
          </button>
        </form>
      )}
    </article>
  )
}

function CreateWorkForm({
  pending,
  mutate,
  onCreated,
}: {
  pending: string | null
  mutate: PortalContextValue['mutate']
  onCreated: () => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [gain, setGain] = useState('')
  const [estimated, setEstimated] = useState('60')
  const [maximum, setMaximum] = useState('90')
  const [claimBy, setClaimBy] = useState(() => hoursFromNowLocalInput(24 * 7))
  const [finishBy, setFinishBy] = useState(() => hoursFromNowLocalInput(24 * 14))
  const [willReview, setWillReview] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const busy = Boolean(pending)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      if (!/^\d+$/.test(estimated.trim()) || !/^\d+$/.test(maximum.trim())) {
        throw new Error('分鐘須為正整數，不會四捨五入')
      }
      const estimatedMinutes = Number(estimated)
      const maximumMinutes = Number(maximum)
      if (!Number.isInteger(estimatedMinutes) || estimatedMinutes <= 0) throw new Error('預估分鐘須為正整數')
      if (!Number.isInteger(maximumMinutes) || maximumMinutes < estimatedMinutes) {
        throw new Error('上限分鐘須為整數，且不可小於預估分鐘')
      }
      const ok = await mutate('create-work-item', async (key) => {
        await client.post(
          '/work-items',
          {
            title: title.trim(),
            objective: objective.trim(),
            acceptance_criteria: acceptance.trim(),
            gain: gain.trim(),
            estimated_minutes: estimatedMinutes,
            maximum_minutes: maximumMinutes,
            claim_by: localInputToIso(claimBy),
            finish_by: localInputToIso(finishBy),
            will_review: willReview,
          },
          { idempotencyKey: key },
        )
      })
      if (ok) {
        setTitle('')
        setObjective('')
        setAcceptance('')
        setGain('')
        setWillReview(false)
        await onCreated()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查表單')
    }
  }

  return (
    <section className="card">
      <h2>發布自願互助工作</h2>
      <p className="lede">說清楚需要什麼幫忙、花多少時間，以及怎樣算完成。由夥伴自願認領，平台不會自動派人。</p>
      {formError && (
        <p className="banner banner-error" role="alert">
          {formError}
        </p>
      )}
      <form className="stack" onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          <span className="field-label">標題</span>
          <input required value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">要解決的問題</span>
          <textarea required maxLength={1000} rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">完成條件</span>
          <textarea required rows={3} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">幫助者當次可得到什麼</span>
          <textarea required rows={2} value={gain} onChange={(event) => setGain(event.target.value)} disabled={busy} />
        </label>
        <div className="two-col">
          <label className="field">
            <span className="field-label">預估分鐘</span>
            <input required inputMode="numeric" value={estimated} onChange={(event) => setEstimated(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">上限分鐘</span>
            <input required inputMode="numeric" value={maximum} onChange={(event) => setMaximum(event.target.value)} disabled={busy} />
          </label>
        </div>
        <div className="two-col">
          <label className="field">
            <span className="field-label">認領期限</span>
            <input required type="datetime-local" value={claimBy} onChange={(event) => setClaimBy(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">完成期限</span>
            <input required type="datetime-local" value={finishBy} onChange={(event) => setFinishBy(event.target.value)} disabled={busy} />
          </label>
        </div>
        <label className="choice">
          <input type="checkbox" checked={willReview} onChange={(event) => setWillReview(event.target.checked)} disabled={busy} />
          我願意驗收這件工作的提交（不承諾即時回饋，也不是官方品管）
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          發布工作卡
        </button>
      </form>
    </section>
  )
}

function ShowcasePanel() {
  const { session, pending, mutate, isMe } = usePortal()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ActionError | null>(null)
  const [showcases, setShowcases] = useState<Showcase[] | null>(null)
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [showcasePayload, opportunityPayload] = await Promise.all([
        client.get<unknown>('/showcases'),
        client.get<unknown>('/opportunities'),
      ])
      setShowcases(requireItems<Showcase>(showcasePayload, '作品'))
      setOpportunities(requireItems<Opportunity>(opportunityPayload, '商機'))
    } catch (err) {
      setShowcases(null)
      setOpportunities(null)
      setLoadError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.user_id])

  if (loading && !showcases) return <p className="muted" role="status">載入作品與商機…</p>
  if (loadError || !showcases || !opportunities) {
    return <ErrorPanel error={loadError ?? { message: '無法顯示作品與商機', network: false, conflict: false }} onReload={() => void load()} />
  }

  return (
    <div className="panels">
      <ModuleBanner eyebrow="SHOWCASE / 讓能力與機會相遇" title="把完成的事，帶到下一次合作" description="分享你的作品，也可以提出具體需求，讓適合的夥伴主動聯絡。" art="/art/rpg/cooperation-forge.webp"/>
      <FlowLegend />
      <CreateShowcaseForm pending={pending} mutate={mutate} onCreated={load} />
      <Section title="社群作品" description="經本人同意分享的作品。可向其他作者提出商機。">
        {showcases.length === 0 ? (
          <EmptyState title="還沒有作品曝光" body="分享作品後，其他成員才看得到並提出商機。" />
        ) : (
          <div className="card-grid">
            {showcases.map((showcase) => (
              <ShowcaseCard
                key={showcase.showcase_id}
                showcase={showcase}
                mine={isMe(showcase.owner_ref)}
                pending={pending}
                mutate={mutate}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </Section>
      <Section title="與你相關的商機" description="只顯示你是提出者或作品作者的商機。">
        {opportunities.length === 0 ? (
          <EmptyState title="還沒有商機" body="從其他人的作品提出需求後，雙方才會在這裡看到。" />
        ) : (
          <div className="card-grid">
            {opportunities.map((opportunity) => (
              <OpportunityCard
                key={opportunity.opportunity_id}
                opportunity={opportunity}
                pending={pending}
                mutate={mutate}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function CreateShowcaseForm({
  pending,
  mutate,
  onCreated,
}: {
  pending: string | null
  mutate: PortalContextValue['mutate']
  onCreated: () => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [artifactRef, setArtifactRef] = useState('artifact:template-v1')
  const [consent, setConsent] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const busy = Boolean(pending)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const artifact = artifactRef.trim()
      if (!consent) throw new Error('分享前須由本人勾選同意')
      if (!artifact || looksLikeUrl(artifact)) throw new Error('成果引用須為不透明代號')
      const ok = await mutate('create-showcase', async (key) => {
        await client.post(
          '/showcases',
          {
            title: title.trim(),
            description: description.trim(),
            artifact_ref: artifact,
            consent_to_share: true,
          },
          { idempotencyKey: key },
        )
      })
      if (ok) {
        setTitle('')
        setDescription('')
        setConsent(false)
        await onCreated()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查表單')
    }
  }

  return (
    <section className="card">
      <h2>分享作品</h2>
      <p className="lede">把你的作品分享給社群，讓有需求的人找到你。</p>
      {formError && (
        <p className="banner banner-error" role="alert">
          {formError}
        </p>
      )}
      <form className="stack" onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          <span className="field-label">作品標題</span>
          <input required value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">說明</span>
          <textarea required rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">成果引用（例如 artifact:template-v1）</span>
          <input required value={artifactRef} onChange={(event) => setArtifactRef(event.target.value)} disabled={busy} />
        </label>
        <label className="choice">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} />
          我同意以社群可見方式分享這件作品
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || !consent}>
          發布作品
        </button>
      </form>
    </section>
  )
}

function ShowcaseCard({
  showcase,
  mine,
  pending,
  mutate,
  onChanged,
}: {
  showcase: Showcase
  mine: boolean
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const [need, setNeed] = useState('')
  const [open, setOpen] = useState(false)
  const busy = Boolean(pending)

  async function propose(event: React.FormEvent) {
    event.preventDefault()
    const ok = await mutate(`opportunity:${showcase.showcase_id}`, async (key) => {
      await client.post('/opportunities', { showcase_id: showcase.showcase_id, need: need.trim() }, { idempotencyKey: key })
    })
    if (ok) {
      setNeed('')
      setOpen(false)
      await onChanged()
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3>{showcase.title}</h3>
        <span className="pill">社群可見</span>
      </div>
      <p>{showcase.description}</p>
      <dl className="meta">
        <div>
          <dt>作者</dt>
          <dd>{showcase.owner_name}</dd>
        </div>
        <div>
          <dt>成果引用</dt>
          <dd>
            <code>{showcase.artifact_ref}</code>
          </dd>
        </div>
      </dl>
      {mine ? (
        <p className="hint">這是你的作品。其他人提出商機後，你會在下方看到。</p>
      ) : (
        <div className="actions">
          {!open ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setOpen(true)}>
              提出商機
            </button>
          ) : (
            <form className="stack" onSubmit={(event) => void propose(event)}>
              <label className="field">
                <span className="field-label">你的需求</span>
                <textarea required rows={3} value={need} onChange={(event) => setNeed(event.target.value)} disabled={busy} />
              </label>
              <div className="actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  送出商機
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
                  取消
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  )
}

function OpportunityCard({
  opportunity,
  pending,
  mutate,
  onChanged,
}: {
  opportunity: Opportunity
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { isMe } = usePortal()
  const [scope, setScope] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [amount, setAmount] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const busy = Boolean(pending)
  const provider = isMe(opportunity.provider_ref)

  async function proposeEngagement(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const amountMinor = parseMajorToMinor(amount)
      const ok = await mutate(`engagement:${opportunity.opportunity_id}`, async (key) => {
        await client.post(
          `/opportunities/${opportunity.opportunity_id}/engagements`,
          {
            scope: scope.trim(),
            acceptance_criteria: acceptance.trim(),
            amount_minor: amountMinor,
            currency: 'TWD',
          },
          { idempotencyKey: key, ifMatch: opportunity.aggregate_version },
        )
      })
      if (ok) {
        setOpen(false)
        await onChanged()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查金額與內容')
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3>{opportunity.showcase_title}</h3>
        <span className="pill">{opportunityStateLabel(opportunity.state)}</span>
      </div>
      <p>{opportunity.need}</p>
      <dl className="meta">
        <div>
          <dt>提出者</dt>
          <dd>{opportunity.client_name}</dd>
        </div>
        <div>
          <dt>作品作者</dt>
          <dd>{opportunity.provider_name}</dd>
        </div>
      </dl>
      {provider && opportunity.state === 'proposed' && (
        <p className="hint">已提出合作，請到「合作紀錄」繼續同意、交付與收款回報。</p>
      )}
      {provider && opportunity.state === 'open' && (
        <div className="actions">
          {!open ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setOpen(true)}>
              提出合作
            </button>
          ) : (
            <form className="stack" onSubmit={(event) => void proposeEngagement(event)}>
              {formError && (
                <p className="banner banner-error" role="alert">
                  {formError}
                </p>
              )}
              <label className="field">
                <span className="field-label">合作範圍</span>
                <textarea required rows={3} value={scope} onChange={(event) => setScope(event.target.value)} disabled={busy} />
              </label>
              <label className="field">
                <span className="field-label">完成條件</span>
                <textarea required rows={3} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} disabled={busy} />
              </label>
              <label className="field">
                <span className="field-label">約定價格（新台幣，最多兩位小數）</span>
                <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} />
                <span className="field-hint">這是雙方約定價格，不是已收款。超過兩位小數會被拒絕，不會四捨五入。</span>
              </label>
              <div className="actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  送出合作提案
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
                  取消
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  )
}

function EngagementPanel() {
  const { session, pending, mutate } = usePortal()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ActionError | null>(null)
  const [engagements, setEngagements] = useState<Engagement[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const payload = await client.get<unknown>('/engagements')
      setEngagements(requireItems<Engagement>(payload, '合作紀錄'))
    } catch (err) {
      setEngagements(null)
      setLoadError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.user_id])

  if (loading && !engagements) return <p className="muted" role="status">載入合作紀錄…</p>
  if (loadError || !engagements) {
    return <ErrorPanel error={loadError ?? { message: '無法顯示合作紀錄', network: false, conflict: false }} onReload={() => void load()} />
  }

  return (
    <div className="panels">
      <ModuleBanner eyebrow="JOURNAL / 一起完成的旅程" title="合作的每一步，都能回來查看" description="從約定、交付到雙方確認，保留清楚的紀錄。"/>
      <FlowLegend />
      <p className="lede">
        付款由雙方自行處理，平台只記錄約定與收款回報，不代收款，也不核實銀行入帳。
      </p>
      {engagements.length === 0 ? (
        <EmptyState title="還沒有合作紀錄" body="先到「一般作品與需求」分享作品或提出需求；雙方建立合作後，紀錄會出現在這裡。" />
      ) : (
        <div className="card-grid">
          {engagements.map((engagement) => (
            <EngagementCard
              key={engagement.engagement_id}
              engagement={engagement}
              pending={pending}
              mutate={mutate}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EngagementCard({
  engagement,
  pending,
  mutate,
  onChanged,
}: {
  engagement: Engagement
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { isMe } = usePortal()
  const [artifactRef, setArtifactRef] = useState('artifact:template-v1')
  const [amount, setAmount] = useState('')
  const [evidenceRef, setEvidenceRef] = useState('receipt:external-bank-001')
  const [receivedAt, setReceivedAt] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const busy = Boolean(pending)
  const clientSide = isMe(engagement.client_ref)
  const provider = isMe(engagement.provider_ref)

  async function run(actionId: string, path: string, body: unknown) {
    const ok = await mutate(actionId, async (key) => {
      await client.post(path, body, { idempotencyKey: key, ifMatch: engagement.aggregate_version })
    })
    if (ok) await onChanged()
  }

  async function deliver(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const artifact = artifactRef.trim()
      if (!artifact || looksLikeUrl(artifact)) throw new Error('成果引用須為不透明代號')
      await run(`deliver:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:deliver`, {
        artifact_ref: artifact,
      })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查交付內容')
    }
  }

  async function reportReceipt(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const amountMinor = parseMajorToMinor(amount)
      if (!evidenceRef.trim() || looksLikeUrl(evidenceRef)) throw new Error('請填寫不透明的回報引用')
      await run(`receipt:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}/receipts`, {
        amount_minor: amountMinor,
        currency: engagement.currency,
        evidence_ref: evidenceRef.trim(),
        received_at: receivedAt ? localInputToIso(receivedAt) : new Date().toISOString(),
      })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查收款回報')
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3>{engagement.scope}</h3>
        <span className="pill pill-green">{engagementStateLabel(engagement.state)}</span>
      </div>
      <p>{engagement.acceptance_criteria}</p>
      <dl className="meta">
        <div>
          <dt>提供者</dt>
          <dd>{engagement.provider_name}</dd>
        </div>
        <div>
          <dt>委託人</dt>
          <dd>{engagement.client_name}</dd>
        </div>
        <div>
          <dt>約定價格</dt>
          <dd>{formatMinor(engagement.amount_minor, engagement.currency)}（非已收款）</dd>
        </div>
        {engagement.delivery_ref && (
          <div>
            <dt>交付引用</dt>
            <dd>
              <code>{engagement.delivery_ref}</code>
            </dd>
          </div>
        )}
      </dl>
      <ReceiptStatus receipt={engagement.receipt} />
      {formError && (
        <p className="banner banner-error" role="alert">
          {formError}
        </p>
      )}
      {clientSide && engagement.state === 'proposed' && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !engagement.terms_sha256}
            onClick={() => void run(`agree:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:agree`, {
              terms_sha256: engagement.terms_sha256,
            })}
          >
            同意這份合作
          </button>
        </div>
      )}
      {provider && engagement.state === 'agreed' && (
        <form className="stack" onSubmit={(event) => void deliver(event)}>
          <label className="field">
            <span className="field-label">成果引用（例如 artifact:template-v1）</span>
            <input required value={artifactRef} onChange={(event) => setArtifactRef(event.target.value)} disabled={busy} />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            標記已交付
          </button>
        </form>
      )}
      {clientSide && engagement.state === 'delivered' && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !engagement.terms_sha256}
            onClick={() => void run(`accept:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:accept`, {
              terms_sha256: engagement.terms_sha256,
            })}
          >
            接受交付
          </button>
        </div>
      )}
      {provider && engagement.state === 'accepted' && !engagement.receipt && (
        <form className="stack" onSubmit={(event) => void reportReceipt(event)}>
          <p className="hint">這是自行回報收到款項，不是銀行核對或平台代收。</p>
          <label className="field">
            <span className="field-label">回報金額（新台幣，最多兩位小數）</span>
            <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">回報引用</span>
            <input required value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} disabled={busy} />
            <span className="field-hint">例如 receipt:external-bank-001，不要貼對帳單或簽章網址。</span>
          </label>
          <label className="field">
            <span className="field-label">回報時間</span>
            <input type="datetime-local" step="0.001" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} disabled={busy} />
            <span className="field-hint">留空採送出時刻；回報不代表銀行已核實。</span>
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            送出收款回報
          </button>
        </form>
      )}
      {clientSide && engagement.receipt?.verification_status === 'self_reported' && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void run(`confirm-receipt:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:confirm-receipt`, {})}
          >
            確認對方的收款回報
          </button>
        </div>
      )}
    </article>
  )
}

function ReceiptStatus({ receipt }: { receipt: Engagement['receipt'] }) {
  if (!receipt) return <p className="hint">尚未有收款回報。</p>
  const amount = formatMinor(receipt.amount_minor, receipt.currency)
  if (receipt.verification_status === 'counterparty_confirmed') {
    return (
      <p className="status-note">
        雙方確認（未核對銀行）· {amount} · {formatIsoLocal(receipt.received_at)} · <code>{receipt.evidence_ref}</code>
      </p>
    )
  }
  return (
    <p className="status-note">
      收款回報／待對方確認 · {amount} · {formatIsoLocal(receipt.received_at)} · <code>{receipt.evidence_ref}</code>
    </p>
  )
}

function FlowLegend() {
  return (
    <ol className="flow" aria-label="合作流程">
      <li>作品曝光</li>
      <li>商機</li>
      <li>合作</li>
      <li>交付</li>
      <li>實收回報</li>
    </ol>
  )
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

function ErrorPanel({
  error,
  onReload,
  reloadLabel = '重新載入',
}: {
  error: ActionError
  onReload?: () => void
  reloadLabel?: string
}) {
  return (
    <div className="banner banner-error" role="alert">
      <p>{error.message}</p>
      {error.conflict && <p>資料可能已被其他人更新。請重新載入後再操作，不要重複送出同一筆動作。</p>}
      {error.network && <p>連線中斷時不會自動重送。若要重試同一筆動作，請使用「再試一次」。</p>}
      <div className="actions">
        {error.network && error.retry && (
          <button type="button" className="btn btn-primary" onClick={error.retry}>
            再試一次
          </button>
        )}
        {(error.conflict || onReload) && onReload && (
          <button type="button" className="btn btn-ghost" onClick={onReload}>
            {reloadLabel}
          </button>
        )}
      </div>
    </div>
  )
}
