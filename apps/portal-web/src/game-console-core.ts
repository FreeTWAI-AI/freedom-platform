export const GAME_CONSOLE_CHANNEL_NAME = 'freedom-game-console/v1'
export const GAME_CONSOLE_EVENT_LIMIT = 200

export const GAME_CONSOLE_CHANNELS = [
  { id: 'all', label: '總頻道', shortLabel: '全部' },
  { id: 'world_chat', label: '世界聊天', shortLabel: '世界' },
  { id: 'guild', label: '公會聊天', shortLabel: '公會' },
  { id: 'squad', label: '小隊聊天', shortLabel: '小隊' },
  { id: 'direct', label: '私人聊天', shortLabel: '私訊' },
  { id: 'guide', label: '系統導覽', shortLabel: '導覽' },
  { id: 'system', label: '系統公告', shortLabel: '公告' },
  { id: 'ai', label: 'AI 指令', shortLabel: 'AI' },
] as const

export type GameConsoleChannel = typeof GAME_CONSOLE_CHANNELS[number]['id']
export type GameConsoleSourceChannel = Exclude<GameConsoleChannel, 'all'>
export type ConsoleVisibility = Record<GameConsoleSourceChannel, boolean>
export const defaultConsoleVisibility = (): ConsoleVisibility => ({guild:true,squad:true,direct:true,world_chat:true,ai:true,guide:true,system:true})
export function isConsoleVisibility(value:unknown):value is ConsoleVisibility {
  if(!value||typeof value!=='object')return false
  return GAME_CONSOLE_CHANNELS.slice(1).every(channel=>typeof (value as Record<string,unknown>)[channel.id]==='boolean')
}
export type GameConsoleLevel = 'info' | 'success' | 'warning' | 'error'
export type GameConsoleKind = 'guide' | 'prompt' | 'status' | 'summary' | 'chat' | 'broadcast'

export type GameConsoleEvent = {
  id: string
  channel: GameConsoleSourceChannel
  level: GameConsoleLevel
  kind: GameConsoleKind
  message: string
  detail?: string
  source: string
  action?: 'guilds' | 'skills'
  createdAt: string
}

export type GameConsoleEventInput = {
  channel?: GameConsoleSourceChannel
  level?: GameConsoleLevel
  kind?: GameConsoleKind
  message: string
  detail?: string
  source?: string
  action?: 'guilds' | 'skills'
  id?: string
  createdAt?: string
}

export type GameConsoleWireMessage =
  | { type: 'event'; sender: string; event: GameConsoleEvent }
  | { type: 'sync-request'; sender: string }
  | { type: 'snapshot'; sender: string; target: string; events: GameConsoleEvent[]; visibility: ConsoleVisibility }
  | { type: 'visibility'; sender: string; visibility: ConsoleVisibility }
  | { type: 'session-end'; sender: string }

const CHANNEL_IDS = new Set<string>(GAME_CONSOLE_CHANNELS.slice(1).map(channel => channel.id))
const LEVELS = new Set<string>(['info', 'success', 'warning', 'error'])
const KINDS = new Set<string>(['guide', 'prompt', 'status', 'summary', 'chat', 'broadcast'])
const listeners = new Set<(event: GameConsoleEvent) => void>()

function eventId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `console-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Console text is intentionally short-lived, but still redacts common credential shapes. */
export function sanitizeConsoleText(value: unknown, maxLength = 800): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '')
  return text
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted-token]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength)
}

export function createConsoleEvent(input: GameConsoleEventInput): GameConsoleEvent {
  const message = sanitizeConsoleText(input.message)
  if (!message) throw new Error('Game Console event message is empty.')
  const createdAt = input.createdAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Game Console event time is invalid.')
  return {
    id: sanitizeConsoleText(input.id ?? eventId(), 160),
    channel: input.channel ?? 'system',
    level: input.level ?? 'info',
    kind: input.kind ?? 'status',
    message,
    ...(input.detail ? { detail: sanitizeConsoleText(input.detail, 8000) } : {}),
    source: sanitizeConsoleText(input.source ?? 'Workshop', 80) || 'Workshop',
    ...(input.action ? { action: input.action } : {}),
    createdAt: new Date(createdAt).toISOString(),
  }
}

export function isGameConsoleEvent(value: unknown): value is GameConsoleEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<GameConsoleEvent>
  return typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 160
    && typeof event.channel === 'string' && CHANNEL_IDS.has(event.channel)
    && typeof event.level === 'string' && LEVELS.has(event.level)
    && typeof event.kind === 'string' && KINDS.has(event.kind)
    && typeof event.message === 'string' && event.message.length > 0 && event.message.length <= 800
    && (event.detail === undefined || typeof event.detail === 'string' && event.detail.length <= 8000)
    && typeof event.source === 'string' && event.source.length > 0 && event.source.length <= 80
    && (event.action === undefined || event.action === 'guilds' || event.action === 'skills')
    && typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt))
}

export function isGameConsoleWireMessage(value: unknown): value is GameConsoleWireMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<GameConsoleWireMessage> & { sender?: unknown; target?: unknown; events?: unknown; event?: unknown }
  if (typeof message.sender !== 'string' || !message.sender || message.sender.length > 160) return false
  if (message.type === 'event') return isGameConsoleEvent(message.event)
  if (message.type === 'visibility') return isConsoleVisibility((message as {visibility?:unknown}).visibility)
  if (message.type === 'sync-request') return true
  if (message.type === 'session-end') return true
  return message.type === 'snapshot' && typeof message.target === 'string' && message.target.length > 0 && message.target.length <= 160
    && Array.isArray(message.events) && message.events.length <= GAME_CONSOLE_EVENT_LIMIT && message.events.every(isGameConsoleEvent)
    && isConsoleVisibility((message as {visibility?:unknown}).visibility)
}

export function mergeConsoleEvents(current: GameConsoleEvent[], incoming: GameConsoleEvent[], limit = GAME_CONSOLE_EVENT_LIMIT): GameConsoleEvent[] {
  const byId = new Map<string, GameConsoleEvent>()
  for (const event of [...current, ...incoming]) if (isGameConsoleEvent(event)) byId.set(event.id, event)
  return [...byId.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-Math.max(1, limit))
}

export function subscribeGameConsole(listener: (event: GameConsoleEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Usable outside React; never accepts secrets or arbitrary structured payloads. */
export function logConsoleEvent(input: GameConsoleEventInput): GameConsoleEvent {
  const event = createConsoleEvent(input)
  for (const listener of listeners) listener(event)
  return event
}
