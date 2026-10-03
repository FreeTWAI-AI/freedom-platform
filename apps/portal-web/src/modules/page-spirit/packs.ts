import type { TabId } from '../../types'
import type { SpiritPack } from './core'

const PACK_LOADERS: Record<TabId, () => Promise<SpiritPack>> = {
  "home": () => import('./packs/home.json').then(module => module.default),
  "guilds": () => import('./packs/guilds.json').then(module => module.default),
  "skills": () => import('./packs/skills.json').then(module => module.default),
  "messages": () => import('./packs/messages.json').then(module => module.default),
  "events": () => import('./packs/events.json').then(module => module.default),
  "tasks": () => import('./packs/tasks.json').then(module => module.default),
  "members": () => import('./packs/members.json').then(module => module.default),
  "friends": () => import('./packs/friends.json').then(module => module.default),
  "highlights": () => import('./packs/highlights.json').then(module => module.default),
  "positioning": () => import('./packs/positioning.json').then(module => module.default),
  "squads": () => import('./packs/squads.json').then(module => module.default),
  "cocreation": () => import('./packs/cocreation.json').then(module => module.default),
  "social": () => import('./packs/social.json').then(module => module.default),
  "services": () => import('./packs/services.json').then(module => module.default),
  "promotion": () => import('./packs/promotion.json').then(module => module.default),
  "workbench": () => import('./packs/workbench.json').then(module => module.default),
  "opensource": () => import('./packs/opensource.json').then(module => module.default),
  "showcase": () => import('./packs/showcase.json').then(module => module.default),
  "engagement": () => import('./packs/engagement.json').then(module => module.default),
  "supplier": () => import('./packs/supplier.json').then(module => module.default),
  "retail": () => import('./packs/retail.json').then(module => module.default),
  "marketing": () => import('./packs/marketing.json').then(module => module.default),
  "guild-workspace": () => import('./packs/guild-workspace.json').then(module => module.default),
  "community": () => import('./packs/community.json').then(module => module.default),
  "account": () => import('./packs/account.json').then(module => module.default),
  "todos": () => import('./packs/todos.json').then(module => module.default),
}

export async function loadSpiritPack(pageId: TabId): Promise<SpiritPack> {
  const pack = await PACK_LOADERS[pageId]()
  if (pack.id !== pageId || pack.topics.some(topic => !topic.id.startsWith(pageId + ':'))) {
    throw new TypeError('The spirit pack must belong to the current page')
  }
  return pack
}
