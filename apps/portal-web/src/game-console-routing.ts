import {NOTIFICATION_KINDS, type NotificationKind} from '../../../modules/member-communications/types'
import type {GameConsoleSourceChannel} from './game-console-core'

/**
 * Every console message source and the channel a member should read it on.
 * Human chat stays in its room. Tips stay on 系統導覽. Platform activity stays on 系統公告.
 * Presence, event share codes and event media are not console messages.
 */
const NOTIFICATION_CONSOLE_CHANNELS = {
  friend_request: 'system',
  friend_accepted: 'system',
  friend_declined: 'system',
  squad_invitation: 'system',
  guild_application_approved: 'system',
  guild_application_rejected: 'system',
  guild_expert_appointed: 'system',
  guild_expert_revoked: 'system',
  guild_master_appointed: 'system',
  guild_master_revoked: 'system',
  event_submitted: 'system',
  event_review_needed: 'system',
  event_approved: 'system',
  event_rejected: 'system',
} as const satisfies Record<NotificationKind, GameConsoleSourceChannel>

export const GITHUB_CONSOLE_KINDS = [
  'issue_opened', 'issue_closed', 'pr_opened', 'pr_merged', 'pr_closed', 'pr_approved', 'design_claimed', 'release_published',
] as const
export type GitHubConsoleKind = typeof GITHUB_CONSOLE_KINDS[number]

export const GITHUB_CONSOLE_ACTIONS: Record<GitHubConsoleKind, string> = {
  issue_opened: '提出 Issue',
  issue_closed: '關閉 Issue',
  pr_opened: '提交 PR',
  pr_merged: '合併 PR',
  pr_closed: '關閉 PR',
  pr_approved: '核准 PR',
  design_claimed: '表示願意接手 Issue 設計',
  release_published: '發布版本',
}

const STATIC_CONSOLE_CHANNELS = {
  world_chat: 'world_chat',
  guild_chat: 'guild',
  squad_chat: 'squad',
  direct_chat: 'direct',
  chat_sent_world: 'world_chat',
  chat_sent_guild: 'guild',
  chat_sent_squad: 'squad',
  chat_sent_direct: 'direct',
  guild_announcement: 'guild',
  skill_published: 'system',
  project_published: 'system',
  accepted_work: 'system',
  event_bulletin_submitted: 'system',
  event_bulletin_approved: 'system',
  event_bulletin_rejected: 'system',
  guide_navigation: 'guide',
  guide_next_step: 'guide',
  guide_keyboard: 'guide',
  guide_popup_blocked: 'guide',
  guide_ai_intro: 'guide',
  guide_welcome: 'guide',
  system_connected: 'system',
  system_page_error: 'system',
  system_background_error: 'system',
  system_network: 'system',
  system_api_error: 'system',
  ai_prompt: 'ai',
  github_issue_opened: 'system',
  github_issue_closed: 'system',
  github_pr_opened: 'system',
  github_pr_merged: 'system',
  github_pr_closed: 'system',
  github_pr_approved: 'system',
  github_design_claimed: 'system',
  github_release_published: 'system',
  notification_unknown: 'system',
} as const satisfies Record<string, GameConsoleSourceChannel>

export const CONSOLE_MESSAGE_CHANNELS: Record<string, GameConsoleSourceChannel> = {
  ...STATIC_CONSOLE_CHANNELS,
  ...Object.fromEntries(NOTIFICATION_KINDS.map(kind => [`notification_${kind}`, NOTIFICATION_CONSOLE_CHANNELS[kind]])),
}

export type ConsoleMessageSource = keyof typeof STATIC_CONSOLE_CHANNELS | `notification_${NotificationKind}`

export function consoleChannel(source: ConsoleMessageSource): GameConsoleSourceChannel {
  return CONSOLE_MESSAGE_CHANNELS[source]
}

/** Known GitHub events go to 系統公告. An unrecognised kind must not fall into a chat channel. */
export function githubConsoleChannel(kind: string): GameConsoleSourceChannel {
  const source = `github_${kind}`
  return source in CONSOLE_MESSAGE_CHANNELS ? CONSOLE_MESSAGE_CHANNELS[source] : 'system'
}

export function notificationConsoleChannel(kind: string | undefined): GameConsoleSourceChannel {
  if (!kind) return consoleChannel('notification_unknown')
  const source = `notification_${kind}`
  return source in CONSOLE_MESSAGE_CHANNELS ? CONSOLE_MESSAGE_CHANNELS[source] : consoleChannel('notification_unknown')
}

export function bulletinConsoleChannel(kind: string | undefined): GameConsoleSourceChannel {
  if (kind === 'approved') return consoleChannel('event_bulletin_approved')
  if (kind === 'rejected') return consoleChannel('event_bulletin_rejected')
  return consoleChannel('event_bulletin_submitted')
}

export function githubConsoleMessage(item: {actor: string; kind: string; title: string; number: number | null}): string {
  const action = item.kind in GITHUB_CONSOLE_ACTIONS ? GITHUB_CONSOLE_ACTIONS[item.kind as GitHubConsoleKind] : '更新 GitHub'
  const numbered = item.number != null && item.kind !== 'release_published'
  const generic = numbered && (item.title === `Issue #${item.number}` || item.title === `PR #${item.number}`)
  const title = generic || !item.title ? '' : `：${item.title}`
  const suffix = numbered ? `（#${item.number}）` : ''
  return `${item.actor} ${action}${title}${suffix}`
}

/** Facts that exist on the platform and must not be invented as console messages. */
export const CONSOLE_EXCLUDED_FACTS = [
  'member_presence', 'event_share_code', 'event_referral_registration', 'event_banner', 'event_video',
] as const
