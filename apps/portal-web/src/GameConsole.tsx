import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode} from 'react'
import {
  GAME_CONSOLE_CHANNEL_NAME,
  GAME_CONSOLE_CHANNELS,
  GAME_CONSOLE_EVENT_LIMIT,
  createConsoleEvent,
  isGameConsoleWireMessage,
  logConsoleEvent,
  mergeConsoleEvents,
  subscribeGameConsole,
  type GameConsoleChannel,
  type GameConsoleEvent,
  type GameConsoleEventInput,
  type GameConsoleWireMessage,
} from './game-console-core'

type ConsoleContextValue = {
  events: GameConsoleEvent[]
  expanded: boolean
  activeChannel: GameConsoleChannel
  log: (event: GameConsoleEventInput) => GameConsoleEvent
  setExpanded: (expanded: boolean) => void
  setActiveChannel: (channel: GameConsoleChannel) => void
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null)
const emptyUnread = (): Record<GameConsoleChannel, number> => ({system: 0, ai: 0, social: 0, world: 0})
const seedEvents = (): GameConsoleEvent[] => [
  createConsoleEvent({channel: 'system', kind: 'guide', level: 'success', source: 'SYSTEM', message: 'Game Console 已連線；跨頁訊息將在本次登入期間持續累積。'}),
  createConsoleEvent({channel: 'system', kind: 'guide', source: 'GUIDE', message: '按下 ~ 可展開或收合控制台。'}),
  createConsoleEvent({channel: 'ai', kind: 'guide', source: 'TRACE POLICY', message: 'AI Trace 只顯示 Prompt、執行狀態與摘要，不顯示隱藏推理。'}),
  createConsoleEvent({channel: 'world', kind: 'broadcast', source: 'FREEDOM', message: '歡迎回到自由工坊。選擇頻道，開始今天的任務。'}),
]

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

export function GameConsoleProvider({children, variant = 'dock'}: {children?: ReactNode; variant?: 'dock' | 'popout'}) {
  const [events, setEvents] = useState<GameConsoleEvent[]>(variant === 'dock' ? seedEvents : [])
  const eventsRef = useRef(events); eventsRef.current = events
  const [expanded, setExpanded] = useState(variant === 'popout')
  const [activeChannel, setActiveChannel] = useState<GameConsoleChannel>('system')
  const [unread, setUnread] = useState<Record<GameConsoleChannel, number>>(emptyUnread)
  const activeRef = useRef(activeChannel); activeRef.current = activeChannel
  const expandedRef = useRef(expanded); expandedRef.current = expanded
  const id = useRef(instanceId())
  // A random, per-shell scope prevents another account in the same browser from
  // receiving events. Only the pop-out URL gets this opaque scope.
  const syncScope = useRef(variant === 'popout' ? popoutScope() : instanceId())
  const broadcast = useRef<BroadcastChannel | null>(null)

  const append = useCallback((event: GameConsoleEvent, announce = false) => {
    setEvents(current => mergeConsoleEvents(current, [event]))
    if (!expandedRef.current || activeRef.current !== event.channel) setUnread(current => ({...current, [event.channel]: current[event.channel] + 1}))
    if (announce) broadcast.current?.postMessage({type: 'event', sender: id.current, event} satisfies GameConsoleWireMessage)
  }, [])

  useEffect(() => subscribeGameConsole(event => append(event, true)), [append])
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(`${GAME_CONSOLE_CHANNEL_NAME}/${syncScope.current}`)
    broadcast.current = channel
    channel.onmessage = message => {
      if (!isGameConsoleWireMessage(message.data) || message.data.sender === id.current) return
      if (message.data.type === 'event') append(message.data.event)
      if (message.data.type === 'sync-request') channel.postMessage({type: 'snapshot', sender: id.current, target: message.data.sender, events: eventsRef.current} satisfies GameConsoleWireMessage)
      if (message.data.type === 'snapshot' && message.data.target === id.current) setEvents(mergeConsoleEvents([], message.data.events))
    }
    if (variant === 'popout') channel.postMessage({type: 'sync-request', sender: id.current} satisfies GameConsoleWireMessage)
    return () => { channel.close(); broadcast.current = null }
  }, [append, variant])

  useEffect(() => {
    const onError = (event: ErrorEvent) => logConsoleEvent({channel: 'system', level: 'error', kind: 'status', source: 'PAGE ERROR', message: event.message || '頁面發生未預期錯誤。'})
    const onRejection = (event: PromiseRejectionEvent) => logConsoleEvent({channel: 'system', level: 'error', kind: 'status', source: 'ASYNC ERROR', message: event.reason instanceof Error ? event.reason.message : '背景操作未完成。'})
    const online = () => logConsoleEvent({channel: 'system', level: 'success', kind: 'status', source: 'NETWORK', message: '網路連線已恢復。'})
    const offline = () => logConsoleEvent({channel: 'system', level: 'warning', kind: 'status', source: 'NETWORK', message: '目前離線；尚未送出的操作請保留並稍後重試。'})
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [])

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
  const value = useMemo<ConsoleContextValue>(() => ({events, expanded, activeChannel, log: logConsoleEvent, setExpanded, setActiveChannel: selectChannel}), [events, expanded, activeChannel, selectChannel])
  return <ConsoleContext.Provider value={value}>
    {variant === 'dock' ? <div className="game-console-page">{children}</div> : children}
    <GameConsole variant={variant} unread={unread} syncScope={syncScope.current}/>
  </ConsoleContext.Provider>
}

function GameConsole({variant, unread, syncScope}: {variant: 'dock' | 'popout'; unread: Record<GameConsoleChannel, number>; syncScope: string}) {
  const {events, expanded, activeChannel, log, setExpanded, setActiveChannel} = useGameConsole()
  const [draft, setDraft] = useState('')
  const history = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const collapseButton = useRef<HTMLButtonElement>(null)
  const filtered = events.filter(event => event.channel === activeChannel)
  const latest = events.slice(-2)

  useEffect(() => { if (expanded) history.current?.scrollTo({top: history.current.scrollHeight, behavior: 'smooth'}) }, [expanded, activeChannel, filtered.length])
  useEffect(() => { if (variant === 'popout') document.title = 'Game Console · 自由工坊' }, [variant])

  function submit(event: FormEvent) {
    event.preventDefault()
    const message = draft.trim()
    if (!message) return
    const meta = GAME_CONSOLE_CHANNELS.find(channel => channel.id === activeChannel)!
    log({
      channel: activeChannel,
      level: 'info',
      kind: activeChannel === 'ai' ? 'prompt' : activeChannel === 'social' ? 'chat' : activeChannel === 'world' ? 'broadcast' : 'guide',
      source: activeChannel === 'world' ? 'LOCAL PREVIEW' : activeChannel === 'social' ? 'LOCAL NOTE' : activeChannel === 'ai' ? 'USER PROMPT' : meta.shortLabel,
      message,
    })
    setDraft('')
  }

  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    const index = GAME_CONSOLE_CHANNELS.findIndex(channel => channel.id === activeChannel)
    const next = event.key === 'ArrowRight' ? (index + 1) % GAME_CONSOLE_CHANNELS.length
      : event.key === 'ArrowLeft' ? (index - 1 + GAME_CONSOLE_CHANNELS.length) % GAME_CONSOLE_CHANNELS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? GAME_CONSOLE_CHANNELS.length - 1 : -1
    if (next < 0) return
    event.preventDefault(); setActiveChannel(GAME_CONSOLE_CHANNELS[next].id)
    document.getElementById(`game-console-tab-${GAME_CONSOLE_CHANNELS[next].id}`)?.focus()
  }

  function popOut() {
    const url = new URL(window.location.origin)
    url.searchParams.set('game-console', 'popout')
    url.searchParams.set('scope', syncScope)
    const opened = window.open(url, `freedom-game-console-${syncScope}`, 'popup=yes,width=880,height=620,resizable=yes,scrollbars=yes')
    if (opened) opened.opener = null
    else log({channel: 'system', level: 'warning', kind: 'guide', source: 'GUIDE', message: '瀏覽器阻擋了彈出視窗；請允許此網站開啟視窗後重試。'})
  }

  if (variant === 'dock' && !expanded) return <aside className="game-console game-console-ticker" aria-label="Game Console 快訊">
    <button type="button" className="game-console-ticker-open" aria-label="展開 Game Console" onClick={() => setExpanded(true)}>
      <span className="game-console-signal" aria-hidden="true"/><strong>CONSOLE</strong>
      <span className="game-console-ticker-lines" key={latest.at(-1)?.id} aria-live="polite">
        {latest.map(event => <span key={event.id}><b>{GAME_CONSOLE_CHANNELS.find(channel => channel.id === event.channel)?.shortLabel}</b> {event.message}</span>)}
      </span>
      <kbd>~</kbd><span aria-hidden="true">⌃</span>
    </button>
  </aside>

  return <aside className={`game-console game-console-expanded${variant === 'popout' ? ' is-popout' : ''}`} aria-label="Game Console">
    <header className="game-console-header">
      <div><p className="game-console-eyebrow">FREEDOM NETWORK // LIVE</p>{variant === 'popout' ? <h1>Game Console</h1> : <h2>Game Console</h2>}</div>
      <div className="game-console-header-actions">
        {variant === 'dock' && <button type="button" className="game-console-icon-button" onClick={popOut} aria-label="在獨立視窗開啟 Game Console" title="獨立視窗">↗</button>}
        {variant === 'dock' && <button ref={collapseButton} type="button" className="game-console-icon-button" onClick={() => setExpanded(false)} aria-label="收合 Game Console" title="收合（~）">⌄</button>}
        {variant === 'popout' && <button type="button" className="game-console-icon-button" onClick={() => window.close()} aria-label="關閉 Game Console 視窗">×</button>}
      </div>
    </header>
    <div className="game-console-tabs" role="tablist" aria-label="Console 頻道" onKeyDown={tabKeys}>
      {GAME_CONSOLE_CHANNELS.map(channel => <button type="button" role="tab" id={`game-console-tab-${channel.id}`} key={channel.id}
        aria-selected={activeChannel === channel.id} aria-controls="game-console-history" tabIndex={activeChannel === channel.id ? 0 : -1}
        onClick={() => setActiveChannel(channel.id)}>{channel.label}{unread[channel.id] > 0 && <span className="game-console-unread" aria-label={`${unread[channel.id]} 則新訊息`}>{unread[channel.id]}</span>}</button>)}
    </div>
    <div ref={history} id="game-console-history" className="game-console-history" role="log" aria-live="polite" aria-label={`${GAME_CONSOLE_CHANNELS.find(channel => channel.id === activeChannel)?.label} 歷史紀錄`}>
      {filtered.length ? filtered.map(event => <article key={event.id} className={`game-console-entry is-${event.level}`}>
        <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString('zh-TW', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false})}</time>
        <strong>{event.source}</strong><p>{event.message}</p>{event.detail && <small>{event.detail}</small>}
      </article>) : <p className="game-console-empty">此頻道尚無訊息。</p>}
    </div>
    <form className="game-console-input" onSubmit={submit}>
      <span aria-hidden="true">›</span>
      <label className="sr-only" htmlFor="game-console-command">輸入 Console 訊息</label>
      <input ref={input} id="game-console-command" value={draft} maxLength={800} autoComplete="off"
        placeholder={activeChannel === 'ai' ? '記錄送給 AI 的 Prompt…' : activeChannel === 'social' ? '加入本機聊天註記（正式訊息請到「我的訊息」）…' : activeChannel === 'world' ? '建立本機公告預覽…' : '輸入操作提示或備忘…'}
        onChange={event => setDraft(event.target.value)}/>
      <button type="submit" disabled={!draft.trim()}>送入控制台</button>
    </form>
    <footer className="game-console-footer"><span>SESSION BUFFER {events.length}/{GAME_CONSOLE_EVENT_LIMIT}</span><span>{typeof BroadcastChannel === 'undefined' ? 'LOCAL ONLY' : 'WINDOW SYNC ON'}</span></footer>
  </aside>
}
