import type { TabId } from '../../types'

export interface SpiritCharacter {
  pageId: TabId
  name: string
  title: string
  accent: string
  intro: string
  backdropColor: string | null
  portrait: string
  hero: string
  frames: readonly string[]
  views: readonly string[]
}

export const SPIRIT_CHARACTERS: Record<TabId, SpiritCharacter> = {
  "home": {
    "pageId": "home",
    "name": "晨曦",
    "title": "會員首頁",
    "accent": "#D6A540",
    "intro": "我是晨曦，這裡的入口怎麼走，我可以陪你看。",
    "backdropColor": "#bfab84",
    "portrait": "/art/page-spirit/v2-20261002/home/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/home/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/home/frame-0.webp",
      "/art/page-spirit/v2-20261002/home/frame-1.webp",
      "/art/page-spirit/v2-20261002/home/frame-2.webp",
      "/art/page-spirit/v2-20261002/home/frame-3.webp",
      "/art/page-spirit/v2-20261002/home/frame-4.webp",
      "/art/page-spirit/v2-20261002/home/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/home/view-0.webp",
      "/art/page-spirit/v2-20261002/home/view-1.webp",
      "/art/page-spirit/v2-20261002/home/view-2.webp",
      "/art/page-spirit/v2-20261002/home/view-3.webp",
      "/art/page-spirit/v2-20261002/home/view-4.webp",
      "/art/page-spirit/v2-20261002/home/view-5.webp"
    ]
  },
  "guilds": {
    "pageId": "guilds",
    "name": "翠珀",
    "title": "職業公會",
    "accent": "#39A475",
    "intro": "我是翠珀，想找哪一類公會？我們從這頁的分類看起。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/guilds/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/guilds/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/guilds/frame-0.webp",
      "/art/page-spirit/v2-20261002/guilds/frame-1.webp",
      "/art/page-spirit/v2-20261002/guilds/frame-2.webp",
      "/art/page-spirit/v2-20261002/guilds/frame-3.webp",
      "/art/page-spirit/v2-20261002/guilds/frame-4.webp",
      "/art/page-spirit/v2-20261002/guilds/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/guilds/view-0.webp",
      "/art/page-spirit/v2-20261002/guilds/view-1.webp",
      "/art/page-spirit/v2-20261002/guilds/view-2.webp",
      "/art/page-spirit/v2-20261002/guilds/view-3.webp",
      "/art/page-spirit/v2-20261002/guilds/view-4.webp",
      "/art/page-spirit/v2-20261002/guilds/view-5.webp"
    ]
  },
  "skills": {
    "pageId": "skills",
    "name": "星墨",
    "title": "技能書架",
    "accent": "#8D74D9",
    "intro": "我是星墨，這頁的技能書想先找哪一本？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/skills/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/skills/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/skills/frame-0.webp",
      "/art/page-spirit/v2-20261002/skills/frame-1.webp",
      "/art/page-spirit/v2-20261002/skills/frame-2.webp",
      "/art/page-spirit/v2-20261002/skills/frame-3.webp",
      "/art/page-spirit/v2-20261002/skills/frame-4.webp",
      "/art/page-spirit/v2-20261002/skills/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/skills/view-0.webp",
      "/art/page-spirit/v2-20261002/skills/view-1.webp",
      "/art/page-spirit/v2-20261002/skills/view-2.webp",
      "/art/page-spirit/v2-20261002/skills/view-3.webp",
      "/art/page-spirit/v2-20261002/skills/view-4.webp",
      "/art/page-spirit/v2-20261002/skills/view-5.webp"
    ]
  },
  "messages": {
    "pageId": "messages",
    "name": "鈴語",
    "title": "我的訊息",
    "accent": "#557BDE",
    "intro": "我是鈴語，通知和聊天在哪裡，我可以幫你分清楚。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/messages/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/messages/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/messages/frame-0.webp",
      "/art/page-spirit/v2-20261002/messages/frame-1.webp",
      "/art/page-spirit/v2-20261002/messages/frame-2.webp",
      "/art/page-spirit/v2-20261002/messages/frame-3.webp",
      "/art/page-spirit/v2-20261002/messages/frame-4.webp",
      "/art/page-spirit/v2-20261002/messages/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/messages/view-0.webp",
      "/art/page-spirit/v2-20261002/messages/view-1.webp",
      "/art/page-spirit/v2-20261002/messages/view-2.webp",
      "/art/page-spirit/v2-20261002/messages/view-3.webp",
      "/art/page-spirit/v2-20261002/messages/view-4.webp",
      "/art/page-spirit/v2-20261002/messages/view-5.webp"
    ]
  },
  "events": {
    "pageId": "events",
    "name": "緋舞",
    "title": "社群活動",
    "accent": "#E47776",
    "intro": "我是緋舞，來看看這頁有哪些活動可以參加。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/events/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/events/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/events/frame-0.webp",
      "/art/page-spirit/v2-20261002/events/frame-1.webp",
      "/art/page-spirit/v2-20261002/events/frame-2.webp",
      "/art/page-spirit/v2-20261002/events/frame-3.webp",
      "/art/page-spirit/v2-20261002/events/frame-4.webp",
      "/art/page-spirit/v2-20261002/events/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/events/view-0.webp",
      "/art/page-spirit/v2-20261002/events/view-1.webp",
      "/art/page-spirit/v2-20261002/events/view-2.webp",
      "/art/page-spirit/v2-20261002/events/view-3.webp",
      "/art/page-spirit/v2-20261002/events/view-4.webp",
      "/art/page-spirit/v2-20261002/events/view-5.webp"
    ]
  },
  "tasks": {
    "pageId": "tasks",
    "name": "燈巡",
    "title": "社群任務",
    "accent": "#E59A36",
    "intro": "我是燈巡，認領和提交任務的流程，我陪你一步一步看。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/tasks/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/tasks/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/tasks/frame-0.webp",
      "/art/page-spirit/v2-20261002/tasks/frame-1.webp",
      "/art/page-spirit/v2-20261002/tasks/frame-2.webp",
      "/art/page-spirit/v2-20261002/tasks/frame-3.webp",
      "/art/page-spirit/v2-20261002/tasks/frame-4.webp",
      "/art/page-spirit/v2-20261002/tasks/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/tasks/view-0.webp",
      "/art/page-spirit/v2-20261002/tasks/view-1.webp",
      "/art/page-spirit/v2-20261002/tasks/view-2.webp",
      "/art/page-spirit/v2-20261002/tasks/view-3.webp",
      "/art/page-spirit/v2-20261002/tasks/view-4.webp",
      "/art/page-spirit/v2-20261002/tasks/view-5.webp"
    ]
  },
  "members": {
    "pageId": "members",
    "name": "花棠",
    "title": "工坊夥伴",
    "accent": "#D78EAC",
    "intro": "我是花棠，想找什麼專長的夥伴？先看看這頁的篩選。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/members/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/members/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/members/frame-0.webp",
      "/art/page-spirit/v2-20261002/members/frame-1.webp",
      "/art/page-spirit/v2-20261002/members/frame-2.webp",
      "/art/page-spirit/v2-20261002/members/frame-3.webp",
      "/art/page-spirit/v2-20261002/members/frame-4.webp",
      "/art/page-spirit/v2-20261002/members/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/members/view-0.webp",
      "/art/page-spirit/v2-20261002/members/view-1.webp",
      "/art/page-spirit/v2-20261002/members/view-2.webp",
      "/art/page-spirit/v2-20261002/members/view-3.webp",
      "/art/page-spirit/v2-20261002/members/view-4.webp",
      "/art/page-spirit/v2-20261002/members/view-5.webp"
    ]
  },
  "friends": {
    "pageId": "friends",
    "name": "澄友",
    "title": "我的好友",
    "accent": "#52B8C1",
    "intro": "我是澄友，這頁的邀請和好友名單，我可以陪你整理。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/friends/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/friends/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/friends/frame-0.webp",
      "/art/page-spirit/v2-20261002/friends/frame-1.webp",
      "/art/page-spirit/v2-20261002/friends/frame-2.webp",
      "/art/page-spirit/v2-20261002/friends/frame-3.webp",
      "/art/page-spirit/v2-20261002/friends/frame-4.webp",
      "/art/page-spirit/v2-20261002/friends/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/friends/view-0.webp",
      "/art/page-spirit/v2-20261002/friends/view-1.webp",
      "/art/page-spirit/v2-20261002/friends/view-2.webp",
      "/art/page-spirit/v2-20261002/friends/view-3.webp",
      "/art/page-spirit/v2-20261002/friends/view-4.webp",
      "/art/page-spirit/v2-20261002/friends/view-5.webp"
    ]
  },
  "highlights": {
    "pageId": "highlights",
    "name": "映光",
    "title": "活動集錦（會員入口）",
    "accent": "#C75C55",
    "intro": "我是映光，想回顧哪場活動？我們從這頁的集錦找起。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/highlights/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/highlights/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/highlights/frame-0.webp",
      "/art/page-spirit/v2-20261002/highlights/frame-1.webp",
      "/art/page-spirit/v2-20261002/highlights/frame-2.webp",
      "/art/page-spirit/v2-20261002/highlights/frame-3.webp",
      "/art/page-spirit/v2-20261002/highlights/frame-4.webp",
      "/art/page-spirit/v2-20261002/highlights/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/highlights/view-0.webp",
      "/art/page-spirit/v2-20261002/highlights/view-1.webp",
      "/art/page-spirit/v2-20261002/highlights/view-2.webp",
      "/art/page-spirit/v2-20261002/highlights/view-3.webp",
      "/art/page-spirit/v2-20261002/highlights/view-4.webp",
      "/art/page-spirit/v2-20261002/highlights/view-5.webp"
    ]
  },
  "positioning": {
    "pageId": "positioning",
    "name": "知羽",
    "title": "我的定位",
    "accent": "#B3ABCF",
    "intro": "我是知羽，這頁的定位結果哪裡看不懂？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/positioning/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/positioning/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/positioning/frame-0.webp",
      "/art/page-spirit/v2-20261002/positioning/frame-1.webp",
      "/art/page-spirit/v2-20261002/positioning/frame-2.webp",
      "/art/page-spirit/v2-20261002/positioning/frame-3.webp",
      "/art/page-spirit/v2-20261002/positioning/frame-4.webp",
      "/art/page-spirit/v2-20261002/positioning/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/positioning/view-0.webp",
      "/art/page-spirit/v2-20261002/positioning/view-1.webp",
      "/art/page-spirit/v2-20261002/positioning/view-2.webp",
      "/art/page-spirit/v2-20261002/positioning/view-3.webp",
      "/art/page-spirit/v2-20261002/positioning/view-4.webp",
      "/art/page-spirit/v2-20261002/positioning/view-5.webp"
    ]
  },
  "squads": {
    "pageId": "squads",
    "name": "嵐翼",
    "title": "小隊集合",
    "accent": "#568D98",
    "intro": "我是嵐翼，小隊要怎麼加入，我陪你看這頁的條件。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/squads/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/squads/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/squads/frame-0.webp",
      "/art/page-spirit/v2-20261002/squads/frame-1.webp",
      "/art/page-spirit/v2-20261002/squads/frame-2.webp",
      "/art/page-spirit/v2-20261002/squads/frame-3.webp",
      "/art/page-spirit/v2-20261002/squads/frame-4.webp",
      "/art/page-spirit/v2-20261002/squads/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/squads/view-0.webp",
      "/art/page-spirit/v2-20261002/squads/view-1.webp",
      "/art/page-spirit/v2-20261002/squads/view-2.webp",
      "/art/page-spirit/v2-20261002/squads/view-3.webp",
      "/art/page-spirit/v2-20261002/squads/view-4.webp",
      "/art/page-spirit/v2-20261002/squads/view-5.webp"
    ]
  },
  "cocreation": {
    "pageId": "cocreation",
    "name": "工晴",
    "title": "一起開發",
    "accent": "#68B9E4",
    "intro": "我是工晴，想一起做點什麼？先看看這頁的開發入口。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/cocreation/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/cocreation/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/cocreation/frame-0.webp",
      "/art/page-spirit/v2-20261002/cocreation/frame-1.webp",
      "/art/page-spirit/v2-20261002/cocreation/frame-2.webp",
      "/art/page-spirit/v2-20261002/cocreation/frame-3.webp",
      "/art/page-spirit/v2-20261002/cocreation/frame-4.webp",
      "/art/page-spirit/v2-20261002/cocreation/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/cocreation/view-0.webp",
      "/art/page-spirit/v2-20261002/cocreation/view-1.webp",
      "/art/page-spirit/v2-20261002/cocreation/view-2.webp",
      "/art/page-spirit/v2-20261002/cocreation/view-3.webp",
      "/art/page-spirit/v2-20261002/cocreation/view-4.webp",
      "/art/page-spirit/v2-20261002/cocreation/view-5.webp"
    ]
  },
  "social": {
    "pageId": "social",
    "name": "璃音",
    "title": "社群分享",
    "accent": "#BA70BE",
    "intro": "我是璃音，這頁要分享到哪裡、哪些內容會公開，我可以說明。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/social/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/social/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/social/frame-0.webp",
      "/art/page-spirit/v2-20261002/social/frame-1.webp",
      "/art/page-spirit/v2-20261002/social/frame-2.webp",
      "/art/page-spirit/v2-20261002/social/frame-3.webp",
      "/art/page-spirit/v2-20261002/social/frame-4.webp",
      "/art/page-spirit/v2-20261002/social/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/social/view-0.webp",
      "/art/page-spirit/v2-20261002/social/view-1.webp",
      "/art/page-spirit/v2-20261002/social/view-2.webp",
      "/art/page-spirit/v2-20261002/social/view-3.webp",
      "/art/page-spirit/v2-20261002/social/view-4.webp",
      "/art/page-spirit/v2-20261002/social/view-5.webp"
    ]
  },
  "services": {
    "pageId": "services",
    "name": "茶芽",
    "title": "社員服務",
    "accent": "#8AA66A",
    "intro": "我是茶芽，這頁的服務想先了解哪一項？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/services/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/services/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/services/frame-0.webp",
      "/art/page-spirit/v2-20261002/services/frame-1.webp",
      "/art/page-spirit/v2-20261002/services/frame-2.webp",
      "/art/page-spirit/v2-20261002/services/frame-3.webp",
      "/art/page-spirit/v2-20261002/services/frame-4.webp",
      "/art/page-spirit/v2-20261002/services/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/services/view-0.webp",
      "/art/page-spirit/v2-20261002/services/view-1.webp",
      "/art/page-spirit/v2-20261002/services/view-2.webp",
      "/art/page-spirit/v2-20261002/services/view-3.webp",
      "/art/page-spirit/v2-20261002/services/view-4.webp",
      "/art/page-spirit/v2-20261002/services/view-5.webp"
    ]
  },
  "promotion": {
    "pageId": "promotion",
    "name": "耀璃",
    "title": "推廣排行榜",
    "accent": "#D5B04B",
    "intro": "我是耀璃，排行榜怎麼算分，我陪你看這頁的規則。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/promotion/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/promotion/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/promotion/frame-0.webp",
      "/art/page-spirit/v2-20261002/promotion/frame-1.webp",
      "/art/page-spirit/v2-20261002/promotion/frame-2.webp",
      "/art/page-spirit/v2-20261002/promotion/frame-3.webp",
      "/art/page-spirit/v2-20261002/promotion/frame-4.webp",
      "/art/page-spirit/v2-20261002/promotion/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/promotion/view-0.webp",
      "/art/page-spirit/v2-20261002/promotion/view-1.webp",
      "/art/page-spirit/v2-20261002/promotion/view-2.webp",
      "/art/page-spirit/v2-20261002/promotion/view-3.webp",
      "/art/page-spirit/v2-20261002/promotion/view-4.webp",
      "/art/page-spirit/v2-20261002/promotion/view-5.webp"
    ]
  },
  "workbench": {
    "pageId": "workbench",
    "name": "礪星",
    "title": "我的工作",
    "accent": "#6986A5",
    "intro": "我是礪星，這頁的工作進度卡在哪一步？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/workbench/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/workbench/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/workbench/frame-0.webp",
      "/art/page-spirit/v2-20261002/workbench/frame-1.webp",
      "/art/page-spirit/v2-20261002/workbench/frame-2.webp",
      "/art/page-spirit/v2-20261002/workbench/frame-3.webp",
      "/art/page-spirit/v2-20261002/workbench/frame-4.webp",
      "/art/page-spirit/v2-20261002/workbench/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/workbench/view-0.webp",
      "/art/page-spirit/v2-20261002/workbench/view-1.webp",
      "/art/page-spirit/v2-20261002/workbench/view-2.webp",
      "/art/page-spirit/v2-20261002/workbench/view-3.webp",
      "/art/page-spirit/v2-20261002/workbench/view-4.webp",
      "/art/page-spirit/v2-20261002/workbench/view-5.webp"
    ]
  },
  "opensource": {
    "pageId": "opensource",
    "name": "碼芽",
    "title": "開源投稿",
    "accent": "#5CC4B2",
    "intro": "我是碼芽，開源投稿要準備什麼，我可以陪你核對。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/opensource/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/opensource/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/opensource/frame-0.webp",
      "/art/page-spirit/v2-20261002/opensource/frame-1.webp",
      "/art/page-spirit/v2-20261002/opensource/frame-2.webp",
      "/art/page-spirit/v2-20261002/opensource/frame-3.webp",
      "/art/page-spirit/v2-20261002/opensource/frame-4.webp",
      "/art/page-spirit/v2-20261002/opensource/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/opensource/view-0.webp",
      "/art/page-spirit/v2-20261002/opensource/view-1.webp",
      "/art/page-spirit/v2-20261002/opensource/view-2.webp",
      "/art/page-spirit/v2-20261002/opensource/view-3.webp",
      "/art/page-spirit/v2-20261002/opensource/view-4.webp",
      "/art/page-spirit/v2-20261002/opensource/view-5.webp"
    ]
  },
  "showcase": {
    "pageId": "showcase",
    "name": "繪璃",
    "title": "作品與需求",
    "accent": "#BC79A5",
    "intro": "我是繪璃，這頁要看作品，還是看看大家需要什麼？",
    "backdropColor": "#b19396",
    "portrait": "/art/page-spirit/v2-20261002/showcase/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/showcase/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/showcase/frame-0.webp",
      "/art/page-spirit/v2-20261002/showcase/frame-1.webp",
      "/art/page-spirit/v2-20261002/showcase/frame-2.webp",
      "/art/page-spirit/v2-20261002/showcase/frame-3.webp",
      "/art/page-spirit/v2-20261002/showcase/frame-4.webp",
      "/art/page-spirit/v2-20261002/showcase/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/showcase/view-0.webp",
      "/art/page-spirit/v2-20261002/showcase/view-1.webp",
      "/art/page-spirit/v2-20261002/showcase/view-2.webp",
      "/art/page-spirit/v2-20261002/showcase/view-3.webp",
      "/art/page-spirit/v2-20261002/showcase/view-4.webp",
      "/art/page-spirit/v2-20261002/showcase/view-5.webp"
    ]
  },
  "engagement": {
    "pageId": "engagement",
    "name": "緣書",
    "title": "合作紀錄",
    "accent": "#995970",
    "intro": "我是緣書，這頁的合作紀錄要從哪一筆看起？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/engagement/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/engagement/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/engagement/frame-0.webp",
      "/art/page-spirit/v2-20261002/engagement/frame-1.webp",
      "/art/page-spirit/v2-20261002/engagement/frame-2.webp",
      "/art/page-spirit/v2-20261002/engagement/frame-3.webp",
      "/art/page-spirit/v2-20261002/engagement/frame-4.webp",
      "/art/page-spirit/v2-20261002/engagement/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/engagement/view-0.webp",
      "/art/page-spirit/v2-20261002/engagement/view-1.webp",
      "/art/page-spirit/v2-20261002/engagement/view-2.webp",
      "/art/page-spirit/v2-20261002/engagement/view-3.webp",
      "/art/page-spirit/v2-20261002/engagement/view-4.webp",
      "/art/page-spirit/v2-20261002/engagement/view-5.webp"
    ]
  },
  "supplier": {
    "pageId": "supplier",
    "name": "琥珀",
    "title": "我有東西要賣",
    "accent": "#B98050",
    "intro": "我是琥珀，這頁的供貨設定哪裡需要幫忙？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/supplier/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/supplier/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/supplier/frame-0.webp",
      "/art/page-spirit/v2-20261002/supplier/frame-1.webp",
      "/art/page-spirit/v2-20261002/supplier/frame-2.webp",
      "/art/page-spirit/v2-20261002/supplier/frame-3.webp",
      "/art/page-spirit/v2-20261002/supplier/frame-4.webp",
      "/art/page-spirit/v2-20261002/supplier/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/supplier/view-0.webp",
      "/art/page-spirit/v2-20261002/supplier/view-1.webp",
      "/art/page-spirit/v2-20261002/supplier/view-2.webp",
      "/art/page-spirit/v2-20261002/supplier/view-3.webp",
      "/art/page-spirit/v2-20261002/supplier/view-4.webp",
      "/art/page-spirit/v2-20261002/supplier/view-5.webp"
    ]
  },
  "retail": {
    "pageId": "retail",
    "name": "蜜菈",
    "title": "我可以賣東西",
    "accent": "#D8B34B",
    "intro": "我是蜜菈，這頁的銷售商品和分享入口，我可以陪你看。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/retail/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/retail/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/retail/frame-0.webp",
      "/art/page-spirit/v2-20261002/retail/frame-1.webp",
      "/art/page-spirit/v2-20261002/retail/frame-2.webp",
      "/art/page-spirit/v2-20261002/retail/frame-3.webp",
      "/art/page-spirit/v2-20261002/retail/frame-4.webp",
      "/art/page-spirit/v2-20261002/retail/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/retail/view-0.webp",
      "/art/page-spirit/v2-20261002/retail/view-1.webp",
      "/art/page-spirit/v2-20261002/retail/view-2.webp",
      "/art/page-spirit/v2-20261002/retail/view-3.webp",
      "/art/page-spirit/v2-20261002/retail/view-4.webp",
      "/art/page-spirit/v2-20261002/retail/view-5.webp"
    ]
  },
  "marketing": {
    "pageId": "marketing",
    "name": "霓霞",
    "title": "行銷工作室",
    "accent": "#BE72D2",
    "intro": "我是霓霞，這頁要找行銷任務，還是先看素材工具？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/marketing/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/marketing/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/marketing/frame-0.webp",
      "/art/page-spirit/v2-20261002/marketing/frame-1.webp",
      "/art/page-spirit/v2-20261002/marketing/frame-2.webp",
      "/art/page-spirit/v2-20261002/marketing/frame-3.webp",
      "/art/page-spirit/v2-20261002/marketing/frame-4.webp",
      "/art/page-spirit/v2-20261002/marketing/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/marketing/view-0.webp",
      "/art/page-spirit/v2-20261002/marketing/view-1.webp",
      "/art/page-spirit/v2-20261002/marketing/view-2.webp",
      "/art/page-spirit/v2-20261002/marketing/view-3.webp",
      "/art/page-spirit/v2-20261002/marketing/view-4.webp",
      "/art/page-spirit/v2-20261002/marketing/view-5.webp"
    ]
  },
  "guild-workspace": {
    "pageId": "guild-workspace",
    "name": "御青",
    "title": "公會管理",
    "accent": "#4D947D",
    "intro": "我是御青，這頁的公告、技能書和審核入口，我可以帶你找。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/guild-workspace/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/guild-workspace/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/guild-workspace/frame-0.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/frame-1.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/frame-2.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/frame-3.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/frame-4.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/guild-workspace/view-0.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/view-1.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/view-2.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/view-3.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/view-4.webp",
      "/art/page-spirit/v2-20261002/guild-workspace/view-5.webp"
    ]
  },
  "community": {
    "pageId": "community",
    "name": "和鈴",
    "title": "自由工坊社群",
    "accent": "#7BBEAE",
    "intro": "我是和鈴，這頁的社群入口想先看哪一個？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/community/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/community/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/community/frame-0.webp",
      "/art/page-spirit/v2-20261002/community/frame-1.webp",
      "/art/page-spirit/v2-20261002/community/frame-2.webp",
      "/art/page-spirit/v2-20261002/community/frame-3.webp",
      "/art/page-spirit/v2-20261002/community/frame-4.webp",
      "/art/page-spirit/v2-20261002/community/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/community/view-0.webp",
      "/art/page-spirit/v2-20261002/community/view-1.webp",
      "/art/page-spirit/v2-20261002/community/view-2.webp",
      "/art/page-spirit/v2-20261002/community/view-3.webp",
      "/art/page-spirit/v2-20261002/community/view-4.webp",
      "/art/page-spirit/v2-20261002/community/view-5.webp"
    ]
  },
  "account": {
    "pageId": "account",
    "name": "鏡月",
    "title": "我的名片",
    "accent": "#91ABC9",
    "intro": "我是鏡月，這頁的名片哪些會公開，我可以陪你核對。",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/account/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/account/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/account/frame-0.webp",
      "/art/page-spirit/v2-20261002/account/frame-1.webp",
      "/art/page-spirit/v2-20261002/account/frame-2.webp",
      "/art/page-spirit/v2-20261002/account/frame-3.webp",
      "/art/page-spirit/v2-20261002/account/frame-4.webp",
      "/art/page-spirit/v2-20261002/account/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/account/view-0.webp",
      "/art/page-spirit/v2-20261002/account/view-1.webp",
      "/art/page-spirit/v2-20261002/account/view-2.webp",
      "/art/page-spirit/v2-20261002/account/view-3.webp",
      "/art/page-spirit/v2-20261002/account/view-4.webp",
      "/art/page-spirit/v2-20261002/account/view-5.webp"
    ]
  },
  "todos": {
    "pageId": "todos",
    "name": "序星",
    "title": "待辦清單",
    "accent": "#9A91AF",
    "intro": "我是序星，這頁的待辦想先整理哪一件？",
    "backdropColor": null,
    "portrait": "/art/page-spirit/v2-20261002/todos/portrait.webp",
    "hero": "/art/page-spirit/v2-20261002/todos/hero.webp",
    "frames": [
      "/art/page-spirit/v2-20261002/todos/frame-0.webp",
      "/art/page-spirit/v2-20261002/todos/frame-1.webp",
      "/art/page-spirit/v2-20261002/todos/frame-2.webp",
      "/art/page-spirit/v2-20261002/todos/frame-3.webp",
      "/art/page-spirit/v2-20261002/todos/frame-4.webp",
      "/art/page-spirit/v2-20261002/todos/frame-5.webp"
    ],
    "views": [
      "/art/page-spirit/v2-20261002/todos/view-0.webp",
      "/art/page-spirit/v2-20261002/todos/view-1.webp",
      "/art/page-spirit/v2-20261002/todos/view-2.webp",
      "/art/page-spirit/v2-20261002/todos/view-3.webp",
      "/art/page-spirit/v2-20261002/todos/view-4.webp",
      "/art/page-spirit/v2-20261002/todos/view-5.webp"
    ]
  }
}
