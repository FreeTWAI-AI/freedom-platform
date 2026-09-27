import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react'
import type {PortalClient} from './api'
import {GameConsoleComposer} from './GameConsoleComposer'
import {readConsoleFeed,readWorldChatFeed} from './game-console-feed'
import {
  GAME_CONSOLE_CHANNEL_NAME,
  GAME_CONSOLE_CHANNELS,
  GAME_CONSOLE_EVENT_LIMIT,
  createConsoleEvent,
  defaultConsoleVisibility,
  isConsoleVisibility,
  isGameConsoleWireMessage,
  logConsoleEvent,
  mergeConsoleEvents,
  subscribeGameConsole,
  type GameConsoleChannel,
  type ConsoleVisibility,
  type GameConsoleEvent,
  type GameConsoleEventInput,
  type GameConsoleWireMessage,
} from './game-console-core'

type ConsoleContextValue = {
  events: GameConsoleEvent[]
  expanded: boolean
  activeChannel: GameConsoleChannel
  visibility: ConsoleVisibility
  toggleVisibility: (channel: Exclude<GameConsoleChannel,'all'>) => void
  log: (event: GameConsoleEventInput) => GameConsoleEvent
  setExpanded: (expanded: boolean) => void
  setActiveChannel: (channel: GameConsoleChannel) => void
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null)
const emptyUnread = (): Record<GameConsoleChannel, number> => Object.fromEntries(GAME_CONSOLE_CHANNELS.map(channel=>[channel.id,0])) as Record<GameConsoleChannel, number>
const eventLabel = (event: GameConsoleEvent) => event.channel === 'guide'
  ? '網頁導覽'
  : GAME_CONSOLE_CHANNELS.find(channel => channel.id === event.channel)?.shortLabel
const showEventSource = (event: GameConsoleEvent) => event.channel !== 'guide' || event.source !== '導覽'
const seedEvents = (): GameConsoleEvent[] => [
  createConsoleEvent({channel: 'system', kind: 'status', level: 'success', source: '系統', message: '訊息控制台已連線；跨頁訊息會在本次登入期間保留。'}),
  createConsoleEvent({channel: 'guide', kind: 'guide', source: '導覽', message: '按下 ~ 可展開或收合控制台。'}),
  createConsoleEvent({channel: 'ai', kind: 'guide', source: 'AI 指令', message: '此處顯示 AI 工作指令、執行狀態與摘要，不顯示隱藏推理。'}),
  createConsoleEvent({channel: 'guide', kind: 'broadcast', source: '自由工坊', message: '歡迎回到自由工坊。選擇頻道，開始今天的任務。'}),
]
function loadVisibility(userId?:string):ConsoleVisibility {
  if(!userId)return defaultConsoleVisibility()
  try {const value=JSON.parse(localStorage.getItem(`freedom-console-visibility/${userId}`)??'null') as unknown;return isConsoleVisibility(value)?value:defaultConsoleVisibility()}catch{return defaultConsoleVisibility()}
}

export function useGameConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext)
  if (!value) throw new Error('Game Console 尚未掛載。')
  return value
}

function instanceId(): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `console-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function popoutScope(): string {
  const value = new URLSearchParams(window.location.search).get('scope')
  return value && /^[A-Za-z0-9-]{20,160}$/.test(value) ? value : instanceId()
}

function keyTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

export function GameConsoleProvider({children, variant = 'dock', client, userId, feedEnabled = true, standalone = false}: {children?: ReactNode; variant?: 'dock' | 'popout'; client?: PortalClient; userId?: string; feedEnabled?: boolean; standalone?: boolean}) {
  const [events, setEvents] = useState<GameConsoleEvent[]>(variant === 'dock' ? seedEvents : [])
  const eventsRef = useRef(events); eventsRef.current = events
  const seen = useRef(new Set(events.map(event=>event.id)))
  const [ended,setEnded] = useState(false)
  const [expanded, setExpanded] = useState(variant === 'popout')
  const [activeChannel, setActiveChannel] = useState<GameConsoleChannel>('all')
  const [visibility,setVisibility]=useState<ConsoleVisibility>(()=>loadVisibility(userId))
  const visibilityRef=useRef(visibility);visibilityRef.current=visibility
  const [unread, setUnread] = useState<Record<GameConsoleChannel, number>>(emptyUnread)
  const activeRef = useRef(activeChannel); activeRef.current = activeChannel
  const expandedRef = useRef(expanded); expandedRef.current = expanded
  const id = useRef(instanceId())
  // A random, per-shell scope prevents another account in the same browser from
  // receiving events. Only the pop-out URL gets this opaque scope.
  const syncScope = useRef(variant === 'popout' ? popoutScope() : instanceId())
  const broadcast = useRef<BroadcastChannel | null>(null)

  const append = useCallback((event: GameConsoleEvent, announce = false) => {
    if(seen.current.has(event.id))return
    seen.current.add(event.id)
    setEvents(current => mergeConsoleEvents(current, [event]))
    if (visibilityRef.current[event.channel as Exclude<GameConsoleChannel,'all'>] && (!expandedRef.current || activeRef.current !== event.channel && activeRef.current !== 'all')) setUnread(current => ({...current, [event.channel]: current[event.channel] + 1,all:current.all+1}))
    if (announce) broadcast.current?.postMessage({type: 'event', sender: id.current, event} satisfies GameConsoleWireMessage)
  }, [])

  useEffect(() => subscribeGameConsole(event => append(event, true)), [append])
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined' || ended) return
    const channel = new BroadcastChannel(`${GAME_CONSOLE_CHANNEL_NAME}/${syncScope.current}`)
    broadcast.current = channel
    channel.onmessage = message => {
      if (!isGameConsoleWireMessage(message.data) || message.data.sender === id.current) return
      if (message.data.type === 'session-end' && variant === 'popout') { setEvents([]); setEnded(true); return }
      if (message.data.type === 'event') append(message.data.event)
      if (message.data.type === 'visibility') setVisibility(message.data.visibility)
      if (message.data.type === 'sync-request') channel.postMessage({type: 'snapshot', sender: id.current, target: message.data.sender, events: eventsRef.current,visibility:visibilityRef.current} satisfies GameConsoleWireMessage)
      if (message.data.type === 'snapshot' && message.data.target === id.current) {
        setVisibility(message.data.visibility)
        for(const event of message.data.events)seen.current.add(event.id)
        setEvents(current=>mergeConsoleEvents(current, message.data.events))
      }
    }
    if (variant === 'popout') channel.postMessage({type: 'sync-request', sender: id.current} satisfies GameConsoleWireMessage)
    return () => { channel.close(); broadcast.current = null }
  }, [append, variant, ended])

  useEffect(()=>{if(userId)try{localStorage.setItem(`freedom-console-visibility/${userId}`,JSON.stringify(visibility))}catch{/* Private browsing may disallow storage. */}},[userId,visibility])
  const toggleVisibility=useCallback((channel:Exclude<GameConsoleChannel,'all'>)=>{
    const next={...visibilityRef.current,[channel]:!visibilityRef.current[channel]};
    setVisibility(next);setUnread(current=>({...current,[channel]:0}));
    broadcast.current?.postMessage({type:'visibility',sender:id.current,visibility:next} satisfies GameConsoleWireMessage)
  },[])

  useEffect(()=>{
    if(variant!=='dock')return
    const finish=()=>broadcast.current?.postMessage({type:'session-end',sender:id.current} satisfies GameConsoleWireMessage)
    window.addEventListener('freedom-game-console-session-end',finish)
    return()=>window.removeEventListener('freedom-game-console-session-end',finish)
  },[variant])

  useEffect(()=>{
    if(!client||!userId||!feedEnabled)return
    let active=true,loading=false,cycle=0
    const refresh=async(forceWorld=false)=>{
      if(!active||loading||document.visibilityState==='hidden')return
      loading=true
      const includeWorld=forceWorld||cycle%4===0;cycle++
      try { for(const event of await readConsoleFeed(client,userId,includeWorld)) if(active)append(event,true) }
      catch { /* PortalClient sends the actionable API error to the system channel. */ }
      finally {loading=false}
    }
    void refresh()
    const timer=window.setInterval(()=>void refresh(),30000)
    const worldTimer=window.setInterval(()=>{if(active&&visibilityRef.current.world_chat&&document.visibilityState==='visible')void readWorldChatFeed(client).then(items=>{for(const event of items)if(active)append(event,true)}).catch(()=>{})},10000)
    const focus=()=>void refresh(true)
    const update=()=>void refresh()
    window.addEventListener('focus',focus)
    window.addEventListener('visibilitychange',focus)
    window.addEventListener('freedom-inbox-updated',update)
    window.addEventListener('freedom-profile-updated',focus)
    return()=>{active=false;window.clearInterval(timer);window.clearInterval(worldTimer);window.removeEventListener('focus',focus);window.removeEventListener('visibilitychange',focus);window.removeEventListener('freedom-inbox-updated',update);window.removeEventListener('freedom-profile-updated',focus)}
  },[client,userId,feedEnabled,append])

  useEffect(() => {
    const onError = (event: ErrorEvent) => {logConsoleEvent({channel: 'system', level: 'error', kind: 'status', source: '頁面錯誤', message: event.message || '頁面發生未預期錯誤。'});client?.reportError(`UI /${window.location.hash.replace(/[^a-zA-Z0-9#_-]/g,'').slice(0,60)}`,'page_error')}
    const onRejection = (event: PromiseRejectionEvent) => {logConsoleEvent({channel: 'system', level: 'error', kind: 'status', source: '背景錯誤', message: event.reason instanceof Error ? event.reason.message : '背景操作未完成。'});client?.reportError(`UI /${window.location.hash.replace(/[^a-zA-Z0-9#_-]/g,'').slice(0,60)}`,'unhandled_rejection')}
    const online = () => logConsoleEvent({channel: 'system', level: 'success', kind: 'status', source: '網路', message: '網路連線已恢復。'})
    const offline = () => logConsoleEvent({channel: 'system', level: 'warning', kind: 'status', source: '網路', message: '目前離線；尚未送出的操作請保留並稍後重試。'})
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [client])

  useEffect(() => {
    if (variant === 'popout') return
    const toggle = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || keyTarget(event.target)) return
      if (event.code !== 'Backquote' && event.key !== '~' && event.key !== '`') return
      event.preventDefault(); setExpanded(value => !value)
    }
    window.addEventListener('keydown', toggle)
    return () => window.removeEventListener('keydown', toggle)
  }, [variant])

  const selectChannel = useCallback((channel: GameConsoleChannel) => {
    setActiveChannel(channel); setUnread(current => ({...current, [channel]: 0}))
  }, [])
  useEffect(()=>{if(expanded)setUnread(current=>current[activeChannel]===0?current:{...current,[activeChannel]:0})},[expanded,activeChannel])
  const value = useMemo<ConsoleContextValue>(() => ({events, expanded, activeChannel, visibility, toggleVisibility,log: logConsoleEvent, setExpanded, setActiveChannel: selectChannel}), [events, expanded, activeChannel, visibility, toggleVisibility,selectChannel])
  if(ended)return <div className="game-console-ended" role="status">登入已結束，請關閉此視窗或重新登入。</div>
  return <ConsoleContext.Provider value={value}>
    {variant === 'dock' ? <div className={`game-console-page${standalone?' is-standalone':''}`}>{children}</div> : children}
    <GameConsole variant={variant} unread={unread} syncScope={syncScope.current} client={client} userId={userId} enabled={feedEnabled}/>
  </ConsoleContext.Provider>
}

export function GameConsolePopout({client}:{client:PortalClient}) {
  const [authorized,setAuthorized]=useState<boolean|null>(null)
  const account=useRef<string|null>(null)
  useEffect(()=>{
    let active=true
    const check=async()=>{
      try {
        const session=await client.getSession()
        if(!active)return
        if(account.current && account.current!==session.user.user_id){setAuthorized(false);return}
        account.current=session.user.user_id
        client.csrfToken=session.csrf_token
        setAuthorized(true)
      } catch {if(active)setAuthorized(false)}
    }
    void check()
    window.addEventListener('focus',check)
    return()=>{active=false;window.removeEventListener('focus',check)}
  },[client])
  useEffect(()=>{
    client.onUnauthorized=()=>{client.csrfToken=null;setAuthorized(false)}
    return()=>{client.onUnauthorized=null}
  },[client])
  if(authorized===null)return <div className="game-console-ended" role="status">正在確認登入狀態…</div>
  if(!authorized)return <div className="game-console-ended" role="status">登入已結束。<a href="/">返回自由工坊</a></div>
  return <GameConsoleProvider variant="popout" client={client} userId={account.current??undefined}/>
}

function GameConsole({variant, unread, syncScope,client,userId,enabled}: {variant: 'dock' | 'popout'; unread: Record<GameConsoleChannel, number>; syncScope: string;client?:PortalClient;userId?:string;enabled:boolean}) {
  const {events, expanded, activeChannel, visibility, toggleVisibility,log, setExpanded, setActiveChannel} = useGameConsole()
  const history = useRef<HTMLDivElement>(null)
  const availableChannels=GAME_CONSOLE_CHANNELS.filter(channel=>channel.id==='all'||visibility[channel.id])
  const visibleEvents=events.filter(event=>visibility[event.channel as Exclude<GameConsoleChannel,'all'>])
  const filtered = activeChannel==='all'?visibleEvents:visibleEvents.filter(event => event.channel === activeChannel)
  const latest = visibleEvents.slice(-2)
  useEffect(()=>{if(activeChannel!=='all'&&!visibility[activeChannel])setActiveChannel('all')},[activeChannel,visibility,setActiveChannel])

  useEffect(() => { if (expanded) history.current?.scrollTo({top: history.current.scrollHeight, behavior: 'smooth'}) }, [expanded, activeChannel, filtered.length])
  useEffect(() => {
    if (variant !== 'dock' || !expanded) return
    const frame = window.requestAnimationFrame(() => document.getElementById(`game-console-tab-${activeChannel}`)?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [expanded, variant, activeChannel])
  useEffect(() => { if (variant === 'popout') document.title = '訊息控制台 · 自由工坊' }, [variant])

  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    const index = availableChannels.findIndex(channel => channel.id === activeChannel)
    const next = event.key === 'ArrowRight' ? (index + 1) % availableChannels.length
      : event.key === 'ArrowLeft' ? (index - 1 + availableChannels.length) % availableChannels.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? availableChannels.length - 1 : -1
    if (next < 0) return
    event.preventDefault(); setActiveChannel(availableChannels[next].id)
    document.getElementById(`game-console-tab-${availableChannels[next].id}`)?.focus()
  }

  function popOut() {
    const url = new URL(window.location.origin)
    url.searchParams.set('game-console', 'popout')
    url.searchParams.set('scope', syncScope)
    const opened = window.open(url, `freedom-game-console-${syncScope}`, 'popup=yes,width=880,height=620,resizable=yes,scrollbars=yes')
    if (opened) opened.opener = null
    else log({channel: 'system', level: 'warning', kind: 'guide', source: '導覽', message: '瀏覽器阻擋了彈出視窗；請允許此網站開啟視窗後重試。'})
  }

  function collapse() {
    setExpanded(false)
    window.requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.game-console-ticker-open')?.focus())
  }

  return <>{variant === 'dock' && !expanded && <aside className="game-console game-console-ticker" aria-label="訊息控制台快訊">
    <button type="button" className="game-console-ticker-open" aria-label="展開訊息控制台" onClick={() => setExpanded(true)}>
      <span className="game-console-signal" aria-hidden="true"/><strong>訊息</strong>
      <span className="game-console-ticker-lines" key={latest.at(-1)?.id} aria-live="polite">
        {latest.map(event => <span key={event.id} data-channel={event.channel} data-level={event.level} data-kind={event.kind} data-next-step={event.action ? 'true' : undefined}><b>{eventLabel(event)}</b> {event.channel === 'guide' && event.source === '下一步' && <b>下一步</b>} {event.message}</span>)}
      </span>
      <kbd>~</kbd><span aria-hidden="true">⌃</span>
    </button>
  </aside>}

  <aside hidden={variant==='dock'&&!expanded} className={`game-console game-console-expanded${variant === 'popout' ? ' is-popout' : ''}`} aria-label="訊息控制台" onKeyDown={event=>{if(variant==='dock'&&event.key==='Escape'){event.stopPropagation();collapse()}}}>
    <header className="game-console-header">
      <div className="game-console-title"><span className="game-console-title-mark" aria-hidden="true">▣</span><div><p className="game-console-eyebrow">自由工坊 · 即時訊息</p>{variant === 'popout' ? <h1>訊息控制台</h1> : <h2>訊息控制台</h2>}</div></div>
      <div className="game-console-header-actions">
        <details className="game-console-visibility"><summary>頻道顯示</summary><div>{GAME_CONSOLE_CHANNELS.filter(channel=>channel.id!=='all').map(channel=><label key={channel.id}><input type="checkbox" checked={visibility[channel.id as Exclude<GameConsoleChannel,'all'>]} onChange={()=>toggleVisibility(channel.id as Exclude<GameConsoleChannel,'all'>)}/>{channel.label}</label>)}</div></details>
        {variant === 'dock' && <button type="button" className="game-console-icon-button game-console-popout" onClick={popOut} aria-label="在獨立視窗開啟訊息控制台" title="獨立視窗">↗</button>}
        {variant === 'dock' && <button type="button" className="game-console-icon-button" onClick={collapse} aria-label="收合訊息控制台" title="收合（~）">⌄</button>}
        {variant === 'popout' && <button type="button" className="game-console-icon-button" onClick={() => window.close()} aria-label="關閉訊息控制台視窗">×</button>}
      </div>
    </header>
    <div className="game-console-tabs" role="tablist" aria-label="訊息頻道" onKeyDown={tabKeys}>
      {availableChannels.map(channel => <button type="button" role="tab" id={`game-console-tab-${channel.id}`} key={channel.id} data-channel={channel.id}
        aria-selected={activeChannel === channel.id} aria-controls="game-console-history" tabIndex={activeChannel === channel.id ? 0 : -1}
        onClick={() => setActiveChannel(channel.id)}>{channel.label}{unread[channel.id] > 0 && <span className="game-console-unread" aria-label={`${unread[channel.id]} 則新訊息`}>{unread[channel.id]}</span>}</button>)}
    </div>
    <div ref={history} id="game-console-history" className="game-console-history" role="log" aria-live="polite" aria-label={`${GAME_CONSOLE_CHANNELS.find(channel => channel.id === activeChannel)?.label} 歷史紀錄`}>
      {filtered.length ? filtered.map(event => <article key={event.id} className={`game-console-entry is-${event.level}${showEventSource(event) ? ' has-source' : ''}`} data-channel={event.channel} data-kind={event.kind} data-next-step={event.action ? 'true' : undefined}>
        <span className="game-console-channel-tag">{eventLabel(event)}</span>
        {showEventSource(event) && <strong title={event.source}>{event.source}</strong>}
        <div className="game-console-content"><p>{event.message}{event.action && <> <a className="game-console-next-link" href={`/#${event.action}`} target={variant === 'popout' ? '_blank' : undefined} rel={variant === 'popout' ? 'noopener' : undefined}>帶我到下一步</a></>}{event.id.startsWith('github:')&&event.detail?.startsWith('https://github.com/FreeTWAI-AI/freedom-platform/')&&<> <a className="game-console-next-link" href={event.detail} target="_blank" rel="noopener noreferrer">查看 GitHub ↗</a></>}</p>{event.detail&&!event.id.startsWith('github:') && <details className="game-console-detail"><summary>查看內容</summary><pre>{event.detail}</pre></details>}</div>
        <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString('zh-TW', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false})}</time>
      </article>) : <p className="game-console-empty">此頻道尚無訊息。</p>}
    </div>
    <GameConsoleComposer client={client} userId={userId} enabled={enabled} channel={activeChannel} visibility={visibility}/>
    <footer className="game-console-footer"><span>本次登入訊息 {events.length}/{GAME_CONSOLE_EVENT_LIMIT}</span><span>{typeof BroadcastChannel === 'undefined' ? '僅此視窗' : '視窗同步中'}</span></footer>
  </aside></>
}
