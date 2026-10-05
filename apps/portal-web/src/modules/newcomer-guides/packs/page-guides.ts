// Adapted from mars-tw’s PR #106 page-spirit guide-data.ts, commit 46a40342509a9278c3a7b8a940bce27b7f464227.
// Original contribution: https://github.com/FreeTWAI-AI/freedom-platform/pull/106
// Named anchors are declared on existing controls or regions. They may be absent
// for the current role, data, or page state; the runner must stop safely then.
// This pack only supplies focus/scroll/highlight guidance, never control actions.
import type { GuideDefinition } from '../engine/guides';

export const PAGE_GUIDES: Record<string, Record<string, GuideDefinition>> = {
  "home": {
    "home:topic-1": {
      "label": "找到會員摘要",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"home:member-summary\"]",
          "instruction": "這裡是會員摘要，可以先看名片與主要公會。"
        }
      ]
    },
    "home:topic-3": {
      "label": "找到常用入口",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"home:shortcuts\"]",
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
          "selector": "[data-guide-anchor=\"guilds:search\"]",
          "instruction": "這是公會搜尋，可自行輸入名稱或想找的專業。"
        },
        {
          "selector": "[data-guide-anchor=\"guilds:scope\"]",
          "instruction": "這排是公會範圍，可自行選全部或已加入。"
        }
      ]
    },
    "guilds:topic-3": {
      "label": "找到創建申請",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"guilds:create-application\"]",
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
          "selector": "[data-guide-anchor=\"skills:unlocked\"]",
          "instruction": "這是已解鎖篩選，請自行選擇要看的書目。"
        }
      ]
    },
    "skills:topic-2": {
      "label": "找到免費預覽",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"skills:locked\"]",
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
          "selector": "[data-guide-anchor=\"messages:notifications\"]",
          "instruction": "這是通知分頁，想看通知時請自行點選。"
        },
        {
          "selector": "[data-guide-anchor=\"messages:direct\"]",
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
          "selector": "[data-guide-anchor=\"events:submit-event\"]",
          "instruction": "這是提交活動入口，需要時請自行開啟表單。"
        }
      ]
    },
    "events:topic-2": {
      "label": "找到活動行事曆",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"events:calendar\"]",
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
          "selector": "[data-guide-anchor=\"tasks:search\"]",
          "instruction": "這是任務搜尋，可自行輸入設計、文件或開發。"
        }
      ]
    },
    "tasks:topic-2": {
      "label": "找到共創專案選單",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"tasks:project\"]",
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
          "selector": "[data-guide-anchor=\"members:search\"]",
          "instruction": "這是夥伴搜尋，可自行輸入暱稱、定位或專長。"
        }
      ]
    },
    "members:topic-2": {
      "label": "找到夥伴與好友邀請",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"members:directory\"]",
          "instruction": "這裡列出符合篩選的夥伴；尚未成為好友且未送出邀請時，名片旁會顯示「邀請成為好友」，由你決定是否發出。"
        }
      ]
    }
  },
  "friends": {
    "friends:topic-1": {
      "label": "找到好友分區",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"friends:scope\"]",
          "instruction": "這排可分開看好友與邀請，請自行切換。"
        }
      ]
    },
    "friends:topic-2": {
      "label": "找到收到的邀請",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"friends:incoming\"]",
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
          "selector": "[data-guide-anchor=\"highlights:format\"]",
          "instruction": "這排可選全部、線上或實體，請自行選擇。"
        }
      ]
    },
    "highlights:topic-3": {
      "label": "找到活動集錦列表",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"highlights:list\"]",
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
          "selector": "[data-guide-anchor=\"positioning:result\"]",
          "instruction": "這裡是目前的定位與公會資料；完整定位探索可稍後補做。"
        }
      ]
    }
  },
  "squads": {
    "squads:topic-1": {
      "label": "找到小隊搜尋",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"squads:search\"]",
          "instruction": "這是小隊搜尋，可自行輸入名稱、目標或頻道。"
        }
      ]
    },
    "squads:topic-2": {
      "label": "找到小隊邀請",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"squads:invitations\"]",
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
          "selector": "[data-guide-anchor=\"cocreation:project\"]",
          "instruction": "這裡可選共創專案，請自行選一個想參與的作品。"
        }
      ]
    },
    "cocreation:topic-3": {
      "label": "找到共創任務搜尋",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"cocreation:task-search\"]",
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
          "selector": "[data-guide-anchor=\"social:composer\"]",
          "instruction": "這是分享表單入口，需要填寫時請自行展開。"
        }
      ]
    },
    "social:topic-3": {
      "label": "找到貼文平台篩選",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"social:platform\"]",
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
          "selector": "[data-guide-anchor=\"services:create\"]",
          "instruction": "這是新增或關閉服務表單的入口，請自行開啟。"
        }
      ]
    },
    "services:topic-2": {
      "label": "找到我的服務",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"services:mine\"]",
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
          "selector": "[data-guide-anchor=\"promotion:period\"]",
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
          "selector": "[data-guide-anchor=\"workbench:current-work\"]",
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
          "selector": "[data-guide-anchor=\"opensource:repository\"]",
          "instruction": "這是專案網址欄位，請自行填好介紹後預覽。"
        }
      ]
    },
    "opensource:topic-2": {
      "label": "找到投稿進度",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"opensource:progress\"]",
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
          "selector": "[data-guide-anchor=\"showcase:title\"]",
          "instruction": "這是作品標題欄位，可自行填名稱與用途。"
        }
      ]
    },
    "showcase:topic-3": {
      "label": "找到相關商機",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"showcase:opportunities\"]",
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
          "selector": "[data-guide-anchor=\"engagement:workflow\"]",
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
          "selector": "[data-guide-anchor=\"supplier:download-kit\"]",
          "instruction": "這是內部開店包入口，需要時請自行下載。"
        }
      ]
    },
    "supplier:topic-2": {
      "label": "找到成果交回區",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"supplier:import-results\"]",
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
          "selector": "[data-guide-anchor=\"retail:search\"]",
          "instruction": "這是商品搜尋，可自行輸入名稱、介紹或店名。"
        }
      ]
    },
    "retail:topic-2": {
      "label": "找到公開開店包",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"retail:download-kit\"]",
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
          "selector": "[data-guide-anchor=\"marketing:source\"]",
          "instruction": "這是內容來源選單，請自行選作品或活動來源。"
        }
      ]
    },
    "marketing:topic-2": {
      "label": "找到私人行銷草稿",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"marketing:drafts\"]",
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
          "selector": "[data-guide-anchor=\"guild-workspace:management\"]",
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
          "selector": "[data-guide-anchor=\"community:links\"]",
          "instruction": "這裡列出 Discord 與 LINE 社群入口，想前往時請自行選擇。"
        }
      ]
    },
    "community:topic-2": {
      "label": "找到社群足跡",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"community:footprint\"]",
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
          "selector": "[data-guide-anchor=\"account:display-name\"]",
          "instruction": "這是社群顯示名稱，可自行修改後再儲存。"
        }
      ]
    },
    "account:topic-2": {
      "label": "找到聯絡可見範圍",
      "steps": [
        {
          "selector": "[data-guide-anchor=\"account:email-visibility\"]",
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
          "selector": "[data-guide-anchor=\"todos:required\"]",
          "instruction": "這裡是必做待辦，先看各卡片的狀態與說明。"
        },
        {
          "selector": "[data-guide-anchor=\"todos:suggested\"]",
          "instruction": "這裡是建議待辦，可依自己的需要選擇處理。"
        }
      ]
    }
  }
};
