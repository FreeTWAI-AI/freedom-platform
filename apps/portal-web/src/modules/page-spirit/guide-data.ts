import type { TabId } from '../../types'
import type { GuideDefinition } from './guides'

// Trusted static selectors verified against existing page markup.
// The runner may focus/scroll/highlight only; it never activates these controls.
// home: MemberHome.tsx:129; MemberHome.tsx:165
// guilds: PositioningPanels.tsx:147; PositioningPanels.tsx:125
// skills: SkillsPanel.tsx:61-63; SkillsPanel.tsx:61-63
// messages: MemberMessages.tsx:40,59-61
// events: EventsPanel.tsx:179-180; EventCalendar.tsx:19-26
// tasks: TaskBoardPanel.tsx:38-41; TaskBoardPanel.tsx:46
// members: Membership.tsx:147; Membership.tsx:151
// friends: FriendsPanel.tsx:20; FriendsPanel.tsx:20
// highlights: EventHighlights.tsx:80-83; EventHighlights.tsx:85-93
// positioning: PositioningPanels.tsx:37-44
// squads: Squads.tsx:110-113; Squads.tsx:35-40
// cocreation: CoCreationPanel.tsx:166-169; CoCreationPanel.tsx:186
// social: SocialZone.tsx:134-137; SocialZone.tsx:146-147
// services: MemberServices.tsx:150-153; MemberServices.tsx:150-161
// promotion: PromotionBoards.tsx:14,50-51
// workbench: App.tsx:746,754;Section:1883-1891
// opensource: SimpleSkillSubmission.tsx:GitHub 專案網址; SimpleSkillSubmission.tsx:投稿進度
// showcase: App.tsx:1391-1406; App.tsx:1296,1314
// engagement: App.tsx:1646,1873
// supplier: CommercePanels.tsx:70,74; CommercePanels.tsx:26,76
// retail: CommercePanels.tsx:70,73; CommercePanels.tsx:74
// marketing: OpenSourcePanels.tsx:75-77; OpenSourcePanels.tsx:85
// guild-workspace: GuildWorkspace.tsx:53
// community: Community.tsx:19; Community.tsx:97-105
// account: Membership.tsx:38; Membership.tsx:26,38,43
// todos: MemberTasks.tsx:160-179
export const GUIDES: Partial<Record<TabId, Record<string, GuideDefinition>>> = {
  "home": {
    "home:topic-1": {
      "label": "找到會員摘要",
      "steps": [
        {
          "selector": "#main-content .home-member-summary",
          "instruction": "這裡是會員摘要，可以先看名片與主要公會。"
        }
      ]
    },
    "home:topic-3": {
      "label": "找到常用入口",
      "steps": [
        {
          "selector": "#main-content .home-shortcuts",
          "instruction": "這裡有技能書與任務入口，請自行選需要的項目。"
        }
      ]
    }
  },
  "guilds": {
    "guilds:topic-1": {
      "label": "找到公會搜尋",
      "steps": [
        {
          "selector": "#main-content .guild-directory-tools input[type=\"search\"]",
          "instruction": "這是公會搜尋，可自行輸入名稱或想找的專業。"
        },
        {
          "selector": "#main-content .guild-scope button:first-of-type",
          "instruction": "這排是公會範圍，可自行選全部或已加入。"
        }
      ]
    },
    "guilds:topic-3": {
      "label": "找到創建申請",
      "steps": [
        {
          "selector": "#main-content .guild-hub-heading button[aria-controls=\"guild-application\"]",
          "instruction": "這是創建公會申請入口，想填寫時請自行開啟。"
        }
      ]
    }
  },
  "skills": {
    "skills:topic-1": {
      "label": "找到已解鎖書目",
      "steps": [
        {
          "selector": "#main-content .skills-panel [aria-label=\"技能書範圍\"] button:first-of-type",
          "instruction": "這是已解鎖篩選，請自行選擇要看的書目。"
        }
      ]
    },
    "skills:topic-2": {
      "label": "找到免費預覽",
      "steps": [
        {
          "selector": "#main-content .skills-panel [aria-label=\"技能書範圍\"] button:nth-of-type(2)",
          "instruction": "這是「未解鎖」篩選。請自行切換，再開書卡介紹。"
        }
      ]
    }
  },
  "messages": {
    "messages:topic-1": {
      "label": "找到訊息分頁",
      "steps": [
        {
          "selector": "#main-content #messages-tab-notifications",
          "instruction": "這是通知分頁，想看通知時請自行點選。"
        },
        {
          "selector": "#main-content #messages-tab-direct",
          "instruction": "這是私人訊息分頁，請自行選對象後閱讀。"
        }
      ]
    }
  },
  "events": {
    "events:topic-1": {
      "label": "找到提交活動入口",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"活動發佈區\"] .experience-heading > button",
          "instruction": "這是提交活動入口，需要時請自行開啟表單。"
        }
      ]
    },
    "events:topic-2": {
      "label": "找到活動行事曆",
      "steps": [
        {
          "selector": "#main-content .event-calendar",
          "instruction": "在這裡找活動，請自行開啟卡片查看名額與資格。"
        }
      ]
    }
  },
  "tasks": {
    "tasks:topic-1": {
      "label": "找到任務搜尋",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"社群任務\"] input[type=\"search\"]",
          "instruction": "這是任務搜尋，可自行輸入設計、文件或開發。"
        }
      ]
    },
    "tasks:topic-2": {
      "label": "找到共創專案選單",
      "steps": [
        {
          "selector": "#main-content .experience-project-picker select",
          "instruction": "這裡可選共創專案，請自行選擇要看的任務來源。"
        }
      ]
    }
  },
  "members": {
    "members:topic-1": {
      "label": "找到夥伴搜尋",
      "steps": [
        {
          "selector": "#main-content .members-panel input[aria-label=\"搜尋夥伴\"]",
          "instruction": "這是夥伴搜尋，可自行輸入暱稱、定位或專長。"
        }
      ]
    },
    "members:topic-2": {
      "label": "找到好友邀請",
      "steps": [
        {
          "selector": "#main-content .members-panel .directory-friend-actions > button:nth-child(2)",
          "instruction": "這是「邀請成為好友」按鈕，由你決定是否發出。"
        }
      ]
    }
  },
  "friends": {
    "friends:topic-1": {
      "label": "找到好友分區",
      "steps": [
        {
          "selector": "#main-content .friend-scopes button:first-of-type",
          "instruction": "這排可分開看好友與邀請，請自行切換。"
        }
      ]
    },
    "friends:topic-2": {
      "label": "找到收到的邀請",
      "steps": [
        {
          "selector": "#main-content .friend-scopes button:nth-of-type(2)",
          "instruction": "這是收到的邀請分區，請自行切換後再查看。"
        }
      ]
    }
  },
  "highlights": {
    "highlights:topic-2": {
      "label": "找到活動形式篩選",
      "steps": [
        {
          "selector": "#main-content .hl-chips .hl-chip:first-of-type",
          "instruction": "這排可選全部、線上或實體，請自行選擇。"
        }
      ]
    },
    "highlights:topic-3": {
      "label": "找到活動集錦列表",
      "steps": [
        {
          "selector": "#main-content .hl-grid",
          "instruction": "這裡是集錦列表，想看單場內容可自行開啟。"
        }
      ]
    }
  },
  "positioning": {
    "positioning:topic-1": {
      "label": "找到定位結果",
      "steps": [
        {
          "selector": "#main-content #positioning-result-title",
          "instruction": "這裡是最後確認的定位結果，可先看方向與能力。"
        }
      ]
    }
  },
  "squads": {
    "squads:topic-1": {
      "label": "找到小隊搜尋",
      "steps": [
        {
          "selector": "#main-content .squad-directory input[type=\"search\"]",
          "instruction": "這是小隊搜尋，可自行輸入名稱、目標或頻道。"
        }
      ]
    },
    "squads:topic-2": {
      "label": "找到小隊邀請",
      "steps": [
        {
          "selector": "#main-content #received-squad-invitations",
          "instruction": "這裡列出收到的小隊邀請，請自行查看再決定。"
        }
      ]
    }
  },
  "cocreation": {
    "cocreation:topic-1": {
      "label": "找到共創專案",
      "steps": [
        {
          "selector": "#main-content .cocreation-project-picker .discovery-search select",
          "instruction": "這裡可選共創專案，請自行選一個想參與的作品。"
        }
      ]
    },
    "cocreation:topic-3": {
      "label": "找到共創任務搜尋",
      "steps": [
        {
          "selector": "#main-content .cocreation-task-filters input[type=\"search\"]",
          "instruction": "這是任務搜尋，可自行輸入名稱、內容或編號。"
        }
      ]
    }
  },
  "social": {
    "social:topic-1": {
      "label": "找到貼文分享表單",
      "steps": [
        {
          "selector": "#main-content .social-composer > summary",
          "instruction": "這是分享表單入口，需要填寫時請自行展開。"
        }
      ]
    },
    "social:topic-3": {
      "label": "找到貼文平台篩選",
      "steps": [
        {
          "selector": "#main-content .social-filters button:first-of-type",
          "instruction": "這排可按平台找貼文，請自行選擇篩選。"
        }
      ]
    }
  },
  "services": {
    "services:topic-1": {
      "label": "找到新增服務入口",
      "steps": [
        {
          "selector": "#main-content .service-mine-head button",
          "instruction": "這是新增或關閉服務表單的入口，請自行開啟。"
        }
      ]
    },
    "services:topic-2": {
      "label": "找到我的服務",
      "steps": [
        {
          "selector": "#main-content .service-mine",
          "instruction": "這裡列出你的服務，可自行查看原有管理操作。"
        }
      ]
    }
  },
  "promotion": {
    "promotion:topic-1": {
      "label": "找到排行榜期間",
      "steps": [
        {
          "selector": "#main-content .promotion-periods .promotion-period:first-of-type",
          "instruction": "這排可選本週、本月或累計，請自行選比較期間。"
        }
      ]
    }
  },
  "workbench": {
    "workbench:topic-1": {
      "label": "找到進行中的工作",
      "steps": [
        {
          "selector": "#main-content .panels > section.section:nth-of-type(2)",
          "instruction": "這裡是「現在進行」，可自行查看工作卡片的步驟。"
        }
      ]
    }
  },
  "opensource": {
    "opensource:topic-1": {
      "label": "找到開源投稿網址",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"投稿開源工具\"] input[placeholder=\"https://github.com/你的帳號/專案名稱\"]",
          "instruction": "這是專案網址欄位，請自行填好介紹後預覽。"
        }
      ]
    },
    "opensource:topic-2": {
      "label": "找到投稿進度",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"投稿開源工具\"] .work-sharing-progress",
          "instruction": "這排是填寫、預覽與分享步驟，可先看目前流程。"
        }
      ]
    }
  },
  "showcase": {
    "showcase:topic-1": {
      "label": "找到作品分享表單",
      "steps": [
        {
          "selector": "#main-content .work-sharing-form input[placeholder=\"例如：我的品牌識別設計\"]",
          "instruction": "這是作品標題欄位，可自行填名稱與用途。"
        }
      ]
    },
    "showcase:topic-3": {
      "label": "找到相關商機",
      "steps": [
        {
          "selector": "#main-content .panels > section.section:nth-of-type(3)",
          "instruction": "這裡是「與你相關的商機」，可先自行查看需求。"
        }
      ]
    }
  },
  "engagement": {
    "engagement:topic-1": {
      "label": "找到合作流程",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"合作流程\"]",
          "instruction": "這排說明合作到交付的順序，可先對照原約定。"
        }
      ]
    }
  },
  "supplier": {
    "supplier:topic-1": {
      "label": "找到內部開店包",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"內部商店工作區\"] .shop-download button",
          "instruction": "這是內部開店包入口，需要時請自行下載。"
        }
      ]
    },
    "supplier:topic-2": {
      "label": "找到成果交回區",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"內部商店工作區\"] > section.card.stack",
          "instruction": "這裡可交回 AI 成果，請自行預覽後再確認。"
        }
      ]
    }
  },
  "retail": {
    "retail:topic-1": {
      "label": "找到商品搜尋",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"公開商店工作區\"] input[placeholder=\"商品名稱、介紹或店名\"]",
          "instruction": "這是商品搜尋，可自行輸入名稱、介紹或店名。"
        }
      ]
    },
    "retail:topic-2": {
      "label": "找到公開開店包",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"公開商店工作區\"] .shop-download",
          "instruction": "這裡是公開開店包，先自行選好商品再下載。"
        }
      ]
    }
  },
  "marketing": {
    "marketing:topic-1": {
      "label": "找到草稿內容來源",
      "steps": [
        {
          "selector": "#main-content .card-grid > section:first-child form > label:first-child select",
          "instruction": "這是內容來源選單，請自行選作品或活動來源。"
        }
      ]
    },
    "marketing:topic-2": {
      "label": "找到私人行銷草稿",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"我的行銷草稿\"]",
          "instruction": "這裡保存私人草稿，可自行選擇要修改的稿件。"
        }
      ]
    }
  },
  "guild-workspace": {
    "guild-workspace:topic-1": {
      "label": "找到可用管理功能",
      "steps": [
        {
          "selector": "#main-content .guild-workspace-tabs button:first-of-type",
          "instruction": "這排只列出可用功能，請自行選要管理的項目。"
        }
      ]
    }
  },
  "community": {
    "community:topic-1": {
      "label": "找到社群入口",
      "steps": [
        {
          "selector": "#main-content [aria-label=\"自由工坊社群\"] a:first-child",
          "instruction": "這裡是外部社群入口，想前往時請自行開啟。"
        }
      ]
    },
    "community:topic-2": {
      "label": "找到社群足跡",
      "steps": [
        {
          "selector": "#main-content #community-footprint-title",
          "instruction": "這裡是公開社群足跡，可先看數字的日期與備註。"
        }
      ]
    }
  },
  "account": {
    "account:topic-1": {
      "label": "找到社群顯示名稱",
      "steps": [
        {
          "selector": "#main-content .account-settings input[aria-describedby=\"community-name-hint\"]",
          "instruction": "這是社群顯示名稱，可自行修改後再儲存。"
        }
      ]
    },
    "account:topic-2": {
      "label": "找到聯絡可見範圍",
      "steps": [
        {
          "selector": "#main-content .account-settings fieldset[aria-label=\"聯絡 E-mail可見範圍\"]",
          "instruction": "這裡可選聯絡信箱的可見對象，請自行核對。"
        }
      ]
    }
  },
  "todos": {
    "todos:topic-2": {
      "label": "找到必做與建議待辦",
      "steps": [
        {
          "selector": "#main-content #member-tasks-required",
          "instruction": "這裡是必做待辦，先看各卡片的狀態與說明。"
        },
        {
          "selector": "#main-content #member-tasks-suggested",
          "instruction": "這裡是建議待辦，可依自己的需要選擇處理。"
        }
      ]
    }
  }
}
