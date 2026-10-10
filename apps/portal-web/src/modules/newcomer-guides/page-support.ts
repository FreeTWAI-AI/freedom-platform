import type {TabId} from '../../types';
import type {PageGuideSupport} from './contracts';
export type GuidePageId = TabId | 'registration' | 'onboarding' | 'admin' | 'skillbooks';
// Every real page must explicitly opt in or give a reason. CI also checks developmentPages.
export const DRAGON_PAGE_SUPPORT = {
  'community-search': {status:'disabled',reason:'社群內容搜尋導覽尚未完成審核，沿用頁面說明'},
  'my-content': {status:'disabled',reason:'私人內容管理導覽尚未完成審核，沿用頁面說明'},
  'home': {status:'supported',characterId:'home',contentId:'home',guideIds:["home:topic-1", "home:topic-3"],anchorContractVersion:1},
  'guilds': {status:'supported',characterId:'guilds',contentId:'guilds',guideIds:["guilds:topic-1", "guilds:topic-3"],anchorContractVersion:1},
  'skills': {status:'supported',characterId:'skills',contentId:'skills',guideIds:["skills:topic-1", "skills:topic-2"],anchorContractVersion:1},
  'messages': {status:'supported',characterId:'messages',contentId:'messages',guideIds:["messages:topic-1"],anchorContractVersion:1},
  'events': {status:'supported',characterId:'events',contentId:'events',guideIds:["events:topic-1", "events:topic-2"],anchorContractVersion:1},
  'tasks': {status:'supported',characterId:'tasks',contentId:'tasks',guideIds:["tasks:topic-1", "tasks:topic-2"],anchorContractVersion:1},
  'members': {status:'supported',characterId:'members',contentId:'members',guideIds:["members:topic-1", "members:topic-2"],anchorContractVersion:1},
  'friends': {status:'supported',characterId:'friends',contentId:'friends',guideIds:["friends:topic-1", "friends:topic-2"],anchorContractVersion:1},
  'highlights': {status:'supported',characterId:'highlights',contentId:'highlights',guideIds:["highlights:topic-2", "highlights:topic-3"],anchorContractVersion:1},
  'positioning': {status:'supported',characterId:'positioning',contentId:'positioning',guideIds:["positioning:topic-1"],anchorContractVersion:1},
  'squads': {status:'supported',characterId:'squads',contentId:'squads',guideIds:["squads:topic-1", "squads:topic-2"],anchorContractVersion:1},
  'cocreation': {status:'supported',characterId:'cocreation',contentId:'cocreation',guideIds:["cocreation:topic-1", "cocreation:topic-3"],anchorContractVersion:1},
  'social': {status:'supported',characterId:'social',contentId:'social',guideIds:["social:topic-1", "social:topic-3"],anchorContractVersion:1},
  'services': {status:'supported',characterId:'services',contentId:'services',guideIds:["services:topic-1", "services:topic-2"],anchorContractVersion:1},
  'promotion': {status:'supported',characterId:'promotion',contentId:'promotion',guideIds:["promotion:topic-1"],anchorContractVersion:1},
  'workbench': {status:'supported',characterId:'workbench',contentId:'workbench',guideIds:["workbench:topic-1"],anchorContractVersion:1},
  'opensource': {status:'supported',characterId:'opensource',contentId:'opensource',guideIds:["opensource:topic-1", "opensource:topic-2"],anchorContractVersion:1},
  'showcase': {status:'supported',characterId:'showcase',contentId:'showcase',guideIds:["showcase:topic-1", "showcase:topic-3"],anchorContractVersion:1},
  'engagement': {status:'supported',characterId:'engagement',contentId:'engagement',guideIds:["engagement:topic-1"],anchorContractVersion:1},
  'supplier': {status:'supported',characterId:'supplier',contentId:'supplier',guideIds:["supplier:topic-1", "supplier:topic-2"],anchorContractVersion:1},
  'retail': {status:'supported',characterId:'retail',contentId:'retail',guideIds:["retail:topic-1", "retail:topic-2"],anchorContractVersion:1},
  'marketing': {status:'supported',characterId:'marketing',contentId:'marketing',guideIds:["marketing:topic-1", "marketing:topic-2"],anchorContractVersion:1},
  'guild-workspace': {status:'supported',characterId:'guild-workspace',contentId:'guild-workspace',guideIds:["guild-workspace:topic-1"],anchorContractVersion:1},
  reservations:{status:'disabled',reason:'預留頁的導覽內容與操作定位尚未完成審核'},
  'stores': {status: 'disabled', reason: '商店導覽尚未完成審核'},
  'business': {status:'disabled',reason:'業務空間導覽尚未完成審核'},
  'community': {status:'supported',characterId:'community',contentId:'community',guideIds:["community:topic-1", "community:topic-2"],anchorContractVersion:1},
  'account': {status:'supported',characterId:'account',contentId:'account',guideIds:["account:topic-1", "account:topic-2"],anchorContractVersion:1},
  'todos': {status:'supported',characterId:'todos',contentId:'todos',guideIds:["todos:topic-2"],anchorContractVersion:1},
  'private-ai': {status:'disabled',reason:'本頁龍娘內容與定位尚未完成審核'},
  'registration': {status:'disabled',reason:'登入前不載入會員導覽'},
  'onboarding': {status:'disabled',reason:'尚未完成原有會員存取流程'},
  'admin': {status:'disabled',reason:'管理員流程使用原有安全說明'},
  'skillbooks': {status:'disabled',reason:'技能書彈窗沿用原有介紹與焦點流程'},
} as const satisfies Record<GuidePageId,PageGuideSupport>;
export function pageGuideSupport(pageId: string):PageGuideSupport | null {
  return Object.hasOwn(DRAGON_PAGE_SUPPORT,pageId) ? DRAGON_PAGE_SUPPORT[pageId as GuidePageId] : null;
}
