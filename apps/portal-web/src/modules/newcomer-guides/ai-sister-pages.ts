import {DRAGON_PAGE_SUPPORT,type GuidePageId} from './page-support';
import type {PageGuideSupport} from './contracts';
// Each actual page explicitly selects an outfit for the member’s chosen character.
// Shared content IDs/anchors
// retain the reviewed product facts, access boundaries and safe focus behavior.
export const AI_SISTER_PAGE_SUPPORT={
  home:{...DRAGON_PAGE_SUPPORT.home,characterId:'member-selected',outfitId:'education'},
  guilds:{...DRAGON_PAGE_SUPPORT.guilds,characterId:'member-selected',outfitId:'international'},
  skills:{...DRAGON_PAGE_SUPPORT.skills,characterId:'member-selected',outfitId:'education'},
  messages:{...DRAGON_PAGE_SUPPORT.messages,characterId:'member-selected',outfitId:'relationship'},
  events:{...DRAGON_PAGE_SUPPORT.events,characterId:'member-selected',outfitId:'festival'},
  tasks:{...DRAGON_PAGE_SUPPORT.tasks,characterId:'member-selected',outfitId:'tech'},
  members:{...DRAGON_PAGE_SUPPORT.members,characterId:'member-selected',outfitId:'culture'},
  friends:{...DRAGON_PAGE_SUPPORT.friends,characterId:'member-selected',outfitId:'relationship'},
  highlights:{...DRAGON_PAGE_SUPPORT.highlights,characterId:'member-selected',outfitId:'media'},
  positioning:{...DRAGON_PAGE_SUPPORT.positioning,characterId:'member-selected',outfitId:'psychology'},
  squads:{...DRAGON_PAGE_SUPPORT.squads,characterId:'member-selected',outfitId:'sports'},
  cocreation:{...DRAGON_PAGE_SUPPORT.cocreation,characterId:'member-selected',outfitId:'science'},
  social:{...DRAGON_PAGE_SUPPORT.social,characterId:'member-selected',outfitId:'media'},
  services:{...DRAGON_PAGE_SUPPORT.services,characterId:'member-selected',outfitId:'health'},
  promotion:{...DRAGON_PAGE_SUPPORT.promotion,characterId:'member-selected',outfitId:'finance'},
  workbench:{...DRAGON_PAGE_SUPPORT.workbench,characterId:'member-selected',outfitId:'workplace'},
  opensource:{...DRAGON_PAGE_SUPPORT.opensource,characterId:'member-selected',outfitId:'tech'},
  showcase:{...DRAGON_PAGE_SUPPORT.showcase,characterId:'member-selected',outfitId:'culture'},
  engagement:{...DRAGON_PAGE_SUPPORT.engagement,characterId:'member-selected',outfitId:'law'},
  supplier:{...DRAGON_PAGE_SUPPORT.supplier,characterId:'member-selected',outfitId:'food'},
  retail:{...DRAGON_PAGE_SUPPORT.retail,characterId:'member-selected',outfitId:'travel'},
  marketing:{...DRAGON_PAGE_SUPPORT.marketing,characterId:'member-selected',outfitId:'media'},
  'guild-workspace':{...DRAGON_PAGE_SUPPORT['guild-workspace'],characterId:'member-selected',outfitId:'politics'},
  community:{...DRAGON_PAGE_SUPPORT.community,characterId:'member-selected',outfitId:'environment'},
  account:{...DRAGON_PAGE_SUPPORT.account,characterId:'member-selected',outfitId:'family'},
  todos:{...DRAGON_PAGE_SUPPORT.todos,characterId:'member-selected',outfitId:'philosophy'},
  'private-ai':{status:'disabled',reason:'本頁 AI Sister 內容與定位尚未完成審核'},
  registration:{status:'disabled',reason:'登入前不載入會員導覽'},
  onboarding:{status:'disabled',reason:'尚未完成原有會員存取流程'},
  admin:{status:'disabled',reason:'管理員流程使用原有安全說明'},
  skillbooks:{status:'disabled',reason:'技能書彈窗沿用原有介紹與焦點流程'},
} as const satisfies Record<GuidePageId,PageGuideSupport>;
