// Community-owned catalog. Source repositories are linked/forked, never executed during onboarding.
export type CatalogCategory = {id:string;label:string;items:{id:string;label:string}[]};
export type SkillBook = {id:string;title:string;repository_url:string;description:string;kind:string;fork_url:string;license_status:string;upstream_url:string;source_commit:string|null;introduction_url:string|null};
export const capabilityCategories:CatalogCategory[] = [
  {
    "id": "start",
    "label": "起步與通用能力",
    "items": [
      {
        "id": "getting_started",
        "label": "剛開始探索，想從基礎學起"
      },
      {
        "id": "research",
        "label": "資料搜尋與來源查證"
      },
      {
        "id": "documentation",
        "label": "文件整理與知識分享"
      },
      {
        "id": "communication",
        "label": "溝通與需求釐清"
      }
    ]
  },
  {
    "id": "ai",
    "label": "AI 與提示設計",
    "items": [
      {
        "id": "prompting",
        "label": "提示設計"
      },
      {
        "id": "codex",
        "label": "Codex"
      },
      {
        "id": "claude_code",
        "label": "Claude Code"
      },
      {
        "id": "gemini",
        "label": "Gemini"
      },
      {
        "id": "grok",
        "label": "Grok"
      },
      {
        "id": "rag",
        "label": "RAG／知識檢索"
      },
      {
        "id": "agent_workflows",
        "label": "Agent 工作流程"
      },
      {
        "id": "mcp",
        "label": "MCP 串接"
      }
    ]
  },
  {
    "id": "programming",
    "label": "程式語言",
    "items": [
      {
        "id": "python",
        "label": "Python"
      },
      {
        "id": "javascript",
        "label": "JavaScript"
      },
      {
        "id": "typescript",
        "label": "TypeScript"
      },
      {
        "id": "java",
        "label": "Java"
      },
      {
        "id": "csharp",
        "label": "C#"
      },
      {
        "id": "go",
        "label": "Go"
      },
      {
        "id": "rust",
        "label": "Rust"
      },
      {
        "id": "php",
        "label": "PHP"
      },
      {
        "id": "sql",
        "label": "SQL"
      },
      {
        "id": "bash",
        "label": "Bash／Shell"
      },
      {
        "id": "powershell",
        "label": "PowerShell"
      }
    ]
  },
  {
    "id": "web",
    "label": "網站與 App",
    "items": [
      {
        "id": "html_css",
        "label": "HTML／CSS"
      },
      {
        "id": "react",
        "label": "React"
      },
      {
        "id": "vue",
        "label": "Vue"
      },
      {
        "id": "nextjs",
        "label": "Next.js"
      },
      {
        "id": "nodejs",
        "label": "Node.js"
      },
      {
        "id": "fastapi",
        "label": "FastAPI"
      },
      {
        "id": "django",
        "label": "Django"
      },
      {
        "id": "dotnet",
        "label": ".NET"
      },
      {
        "id": "flutter",
        "label": "Flutter"
      },
      {
        "id": "tauri",
        "label": "Tauri"
      },
      {
        "id": "electron",
        "label": "Electron"
      },
      {
        "id": "wordpress",
        "label": "WordPress"
      }
    ]
  },
  {
    "id": "developer_tools",
    "label": "開發工具與協作",
    "items": [
      {
        "id": "git",
        "label": "Git"
      },
      {
        "id": "github",
        "label": "GitHub"
      },
      {
        "id": "vscode",
        "label": "VS Code"
      },
      {
        "id": "antigravity",
        "label": "Antigravity"
      },
      {
        "id": "cursor",
        "label": "Cursor"
      },
      {
        "id": "linux",
        "label": "Linux"
      },
      {
        "id": "api_design",
        "label": "API 設計"
      },
      {
        "id": "code_review",
        "label": "程式審查"
      }
    ]
  },
  {
    "id": "automation",
    "label": "自動化與整合",
    "items": [
      {
        "id": "n8n",
        "label": "n8n"
      },
      {
        "id": "make",
        "label": "Make"
      },
      {
        "id": "zapier",
        "label": "Zapier"
      },
      {
        "id": "apps_script",
        "label": "Google Apps Script"
      },
      {
        "id": "power_automate",
        "label": "Power Automate"
      },
      {
        "id": "webhooks",
        "label": "Webhook"
      },
      {
        "id": "line_bot",
        "label": "LINE Bot"
      },
      {
        "id": "discord_bot",
        "label": "Discord Bot"
      }
    ]
  },
  {
    "id": "data_cloud",
    "label": "資料、雲端與可靠性",
    "items": [
      {
        "id": "postgres",
        "label": "PostgreSQL"
      },
      {
        "id": "mysql",
        "label": "MySQL"
      },
      {
        "id": "sqlite",
        "label": "SQLite"
      },
      {
        "id": "redis",
        "label": "Redis"
      },
      {
        "id": "excel",
        "label": "Excel／試算表"
      },
      {
        "id": "powerbi",
        "label": "Power BI"
      },
      {
        "id": "docker",
        "label": "Docker"
      },
      {
        "id": "kubernetes",
        "label": "Kubernetes"
      },
      {
        "id": "cloudflare",
        "label": "Cloudflare"
      },
      {
        "id": "aws",
        "label": "AWS"
      },
      {
        "id": "azure",
        "label": "Azure"
      },
      {
        "id": "gcp",
        "label": "Google Cloud"
      },
      {
        "id": "ci_cd",
        "label": "CI/CD"
      },
      {
        "id": "backup",
        "label": "備份與還原"
      }
    ]
  },
  {
    "id": "quality",
    "label": "測試與安全",
    "items": [
      {
        "id": "manual_testing",
        "label": "手動測試"
      },
      {
        "id": "automated_testing",
        "label": "自動化測試"
      },
      {
        "id": "playwright",
        "label": "Playwright"
      },
      {
        "id": "security_review",
        "label": "安全檢查"
      },
      {
        "id": "privacy",
        "label": "個资保護"
      },
      {
        "id": "monitoring",
        "label": "監控與問題排查"
      }
    ]
  },
  {
    "id": "design_media",
    "label": "設計與影音",
    "items": [
      {
        "id": "figma",
        "label": "Figma"
      },
      {
        "id": "penpot",
        "label": "Penpot"
      },
      {
        "id": "canva",
        "label": "Canva"
      },
      {
        "id": "ux",
        "label": "使用者體驗"
      },
      {
        "id": "typography",
        "label": "排版設計"
      },
      {
        "id": "video_editing",
        "label": "影片剪輯"
      },
      {
        "id": "capcut",
        "label": "CapCut／剪映"
      },
      {
        "id": "davinci",
        "label": "DaVinci Resolve"
      },
      {
        "id": "premiere",
        "label": "Premiere Pro"
      },
      {
        "id": "ffmpeg",
        "label": "FFmpeg"
      },
      {
        "id": "storyboard",
        "label": "腳本與分鏡"
      },
      {
        "id": "audio",
        "label": "聲音與配樂"
      }
    ]
  },
  {
    "id": "growth",
    "label": "內容與行銷",
    "items": [
      {
        "id": "copywriting",
        "label": "文案寫作"
      },
      {
        "id": "social_media",
        "label": "社群內容經營"
      },
      {
        "id": "seo",
        "label": "SEO"
      },
      {
        "id": "ads",
        "label": "廣告投放"
      },
      {
        "id": "analytics",
        "label": "成效分析"
      },
      {
        "id": "ab_testing",
        "label": "A/B 測試"
      },
      {
        "id": "community_ops",
        "label": "社群營運"
      },
      {
        "id": "event_hosting",
        "label": "活動主持"
      }
    ]
  },
  {
    "id": "commerce",
    "label": "供貨、電商與服務",
    "items": [
      {
        "id": "sourcing",
        "label": "選品採購"
      },
      {
        "id": "supply_chain",
        "label": "供應鏈管理"
      },
      {
        "id": "product_quality",
        "label": "商品品質檢查"
      },
      {
        "id": "inventory",
        "label": "庫存管理"
      },
      {
        "id": "logistics",
        "label": "出貨與物流"
      },
      {
        "id": "retail",
        "label": "商店經營"
      },
      {
        "id": "pos",
        "label": "POS 操作"
      },
      {
        "id": "customer_service",
        "label": "客戶服務"
      },
      {
        "id": "sales",
        "label": "銷售與商務開發"
      },
      {
        "id": "accounting",
        "label": "會計基礎"
      },
      {
        "id": "reconciliation",
        "label": "對帳"
      }
    ]
  },
  {
    "id": "management",
    "label": "專案方法與專業經驗",
    "items": [
      {
        "id": "requirements",
        "label": "需求訪談"
      },
      {
        "id": "project_planning",
        "label": "專案規劃"
      },
      {
        "id": "pmp",
        "label": "PMP 知識／經驗（自行填報）"
      },
      {
        "id": "scrum",
        "label": "Scrum"
      },
      {
        "id": "sprint",
        "label": "Sprint 規劃"
      },
      {
        "id": "kanban",
        "label": "Kanban"
      },
      {
        "id": "agile",
        "label": "敏捷協作"
      },
      {
        "id": "coaching",
        "label": "教學與陪跑"
      },
      {
        "id": "facilitation",
        "label": "引導討論"
      },
      {
        "id": "negotiation",
        "label": "合作協商"
      }
    ]
  }
];
export const equipmentCategories:CatalogCategory[] = [
  {
    "id": "ai_subscriptions",
    "label": "AI 助手與開發訂閱",
    "items": [
      {
        "id": "sub_chatgpt",
        "label": "ChatGPT／Codex"
      },
      {
        "id": "sub_claude",
        "label": "Claude／Claude Code"
      },
      {
        "id": "sub_gemini",
        "label": "Gemini／Google AI"
      },
      {
        "id": "sub_grok",
        "label": "Grok"
      },
      {
        "id": "sub_perplexity",
        "label": "Perplexity"
      },
      {
        "id": "sub_copilot",
        "label": "GitHub Copilot"
      },
      {
        "id": "sub_cursor",
        "label": "Cursor"
      },
      {
        "id": "sub_antigravity",
        "label": "Antigravity"
      }
    ]
  },
  {
    "id": "creative_subscriptions",
    "label": "設計與影音訂閱",
    "items": [
      {
        "id": "sub_canva",
        "label": "Canva"
      },
      {
        "id": "sub_adobe",
        "label": "Adobe Creative Cloud"
      },
      {
        "id": "sub_figma",
        "label": "Figma"
      },
      {
        "id": "sub_capcut",
        "label": "CapCut"
      },
      {
        "id": "sub_midjourney",
        "label": "Midjourney"
      },
      {
        "id": "sub_runway",
        "label": "Runway"
      },
      {
        "id": "sub_suno",
        "label": "Suno"
      },
      {
        "id": "sub_elevenlabs",
        "label": "ElevenLabs"
      }
    ]
  },
  {
    "id": "automation_subscriptions",
    "label": "自動化與協作服務",
    "items": [
      {
        "id": "sub_n8n",
        "label": "n8n Cloud"
      },
      {
        "id": "sub_make",
        "label": "Make"
      },
      {
        "id": "sub_zapier",
        "label": "Zapier"
      },
      {
        "id": "sub_notion",
        "label": "Notion"
      },
      {
        "id": "sub_microsoft365",
        "label": "Microsoft 365"
      },
      {
        "id": "sub_google_workspace",
        "label": "Google Workspace"
      }
    ]
  },
  {
    "id": "infra_subscriptions",
    "label": "雲端與商店服務",
    "items": [
      {
        "id": "sub_cloudflare",
        "label": "Cloudflare"
      },
      {
        "id": "sub_aws",
        "label": "AWS"
      },
      {
        "id": "sub_azure",
        "label": "Azure"
      },
      {
        "id": "sub_gcp",
        "label": "Google Cloud"
      },
      {
        "id": "sub_vercel",
        "label": "Vercel"
      },
      {
        "id": "sub_supabase",
        "label": "Supabase"
      },
      {
        "id": "sub_shopify",
        "label": "Shopify"
      },
      {
        "id": "sub_shopline",
        "label": "SHOPLINE"
      }
    ]
  }
];
export const communityCatalog = {
  "name": "自由工坊",
  "tagline": "找到你的定位，帶著技能，和夥伴一起做出作品。",
  "links": [
    {
      "id": "line_claude",
      "label": "LINE · Claude 社群",
      "url": "https://line.me/ti/g2/DPTQR_XE6IYP8c5lBxsbRwsvEUsxI-70p1jWoA",
      "kind": "line"
    },
    {
      "id": "line_codex",
      "label": "LINE · Codex 社群",
      "url": "https://line.me/ti/g2/qwiG-IhXAyEBMzVNt6J-I1ryqj6dKhNoyCTr2A",
      "kind": "line"
    },
    {
      "id": "line_grok",
      "label": "LINE · Grok 社群",
      "url": "https://line.me/ti/g2/83dpd53WEvKWbgDROTV2t0z5hXnNSZTUTq17tg",
      "kind": "line"
    },
    {
      "id": "discord",
      "label": "Discord · 自由工坊",
      "url": "https://discord.gg/MtccYqJxCx",
      "kind": "discord"
    },
    {
      "id": "github",
      "label": "GitHub · 自由工坊",
      "url": "https://github.com/FreeTWAI-AI",
      "kind": "github"
    },
    {
      "id": "open_data",
      "label": "自由工坊開放數據",
      "url": "https://github.com/Hao0321/freeworkshop-open-data",
      "kind": "data"
    }
  ],
  "metrics": [
    {
      "label": "LINE 社群",
      "value": "5,000 + 1,500",
      "as_of": "2026-09-23",
      "source": "organizer_reported",
      "note": "主辦方提供的社群規模概況，非即時或去重人數。"
    },
    {
      "label": "Discord 社群",
      "value": "10,000",
      "as_of": "2026-09-23",
      "source": "organizer_reported",
      "note": "主辦方提供的社群規模概況，非即時人數。"
    }
  ],
  "featured_projects": [
    {
      "id": "social-post",
      "title": "Hao 社群貼文技能書",
      "repository_url": "https://github.com/FreeTWAI-AI/claude-skill-social-post",
      "description": "社群內容規劃、文案草稿與經確認後的發布流程。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/claude-skill-social-post/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/claude-skill-social-post",
      "source_commit": "c2641ba5ac7d7f722f1cef54b03fbfe553502c7b",
      "introduction_url": null
    },
    {
      "id": "typo-studio",
      "title": "Typo Studio 排版工作室",
      "repository_url": "https://github.com/FreeTWAI-AI/typo-studio",
      "description": "中文友善的輪播貼文排版工具。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/typo-studio/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/typo-studio",
      "source_commit": "9d60be439d150af74a79dbcc5a7547c6108c726f",
      "introduction_url": null
    },
    {
      "id": "video-autopilot",
      "title": "影片自動化工具包",
      "repository_url": "https://github.com/FreeTWAI-AI/video-autopilot-kit",
      "description": "影片素材、字幕與剪輯流程的起始框架。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/video-autopilot-kit/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/video-autopilot-kit",
      "source_commit": "74041fcb292788f4c24e3d06f39fe2c9dee7a8cb",
      "introduction_url": null
    },
    {
      "id": "pos-pro",
      "title": "POS Pro 商店工具",
      "repository_url": "https://github.com/FreeTWAI-AI/pos-pro",
      "description": "實體店的收銀、庫存、會員與營運工具。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/pos-pro/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/pos-pro",
      "source_commit": "2656945463e95d155fffca19de18014f5f0d75db",
      "introduction_url": null
    },
    {
      "id": "security-scanner",
      "title": "AI Security Scanner",
      "repository_url": "https://github.com/FreeTWAI-AI/ai-security-scanner",
      "description": "協助針對自己有權管理的系統進行安全檢查。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/ai-security-scanner/fork",
      "license_status": "Apache-2.0",
      "upstream_url": "https://github.com/teddashh/ai-security-scanner",
      "source_commit": "9fae58fbf0e78f25fad5b1e9f70104ac5ab73153",
      "introduction_url": "https://teddashh.github.io/ai-security-scanner/"
    },
    {
      "id": "ai-sister",
      "title": "AI Sister",
      "repository_url": "https://github.com/FreeTWAI-AI/AI-Sister",
      "description": "本機優先的桌面助理與專案設計。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/AI-Sister/fork",
      "license_status": "Apache-2.0",
      "upstream_url": "https://github.com/teddashh/AI-Sister",
      "source_commit": "02100bf2e83d3a77bce5dc14c256f4dd4bb5e270",
      "introduction_url": null
    },
    {
      "id": "multi-ai-desktop",
      "title": "Multi-AI Chat Desktop",
      "repository_url": "https://github.com/FreeTWAI-AI/multi-ai-chat-desktop",
      "description": "在自己的桌面協調多個 AI 對話與工作流。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/multi-ai-chat-desktop/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/teddashh/multi-ai-chat-desktop",
      "source_commit": "dd22b21178212cd9b717aafd9cca82d25b85f681",
      "introduction_url": "https://teddashh.github.io/multi-ai-chat-desktop/"
    },
    {
      "id": "multi-ai-chat",
      "title": "Multi-AI Chat",
      "repository_url": "https://github.com/FreeTWAI-AI/multi-ai-chat",
      "description": "多 AI 對話專案。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/multi-ai-chat/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/teddashh/multi-ai-chat",
      "source_commit": "cd96e66de6c0a5b2ff6b5f95e09963c66cd0bf7f",
      "introduction_url": "https://teddashh.github.io/multi-ai-chat/"
    }
  ],
  "project_links": [
    {
      "title": "Restrict AI Chat",
      "url": "https://restrictaichat.com/zh-TW/",
      "description": "Ted 提供的專案網站；不宣稱有公開程式碼。"
    }
  ],
  "skill_books": [
    {
      "id": "career-guide",
      "title": "方向探索與陪跑入門",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-career-guide",
      "description": "以提問、本人確認和可完成的小步陪伴會員探索方向。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-career-guide/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-career-guide",
      "source_commit": "22b1ff3fb3051ff98c330024f7507f5e9da13574",
      "introduction_url": null
    },
    {
      "id": "supplier-client",
      "title": "供應端工作台",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-supplier-client",
      "description": "先在自由工坊刊登商品；也能 fork 自己的供應端客戶端。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-supplier-client/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-supplier-client",
      "source_commit": null,
      "introduction_url": null
    },
    {
      "id": "storefront",
      "title": "我的第一間商店",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-storefront",
      "description": "商店、選品與供貨條件模板；接入中央平台資料。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-storefront/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-storefront",
      "source_commit": null,
      "introduction_url": null
    },
    {
      "id": "community-ops",
      "title": "新人接待與社群活動",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-community-ops",
      "description": "從一次歡迎與一次小活動開始，留下可交接的紀錄。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-community-ops/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-community-ops",
      "source_commit": "716f668a883c2333d4b7d6a8bd79e809d1c740a6",
      "introduction_url": null
    },
    {
      "id": "partnership",
      "title": "需求訪談與合作提案",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-partnership",
      "description": "把需求、受益者、範圍與下一步整理成合作提案。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-partnership/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-partnership",
      "source_commit": "7117120a635a0782f170de9448ef85314a16be5d",
      "introduction_url": null
    },
    {
      "id": "reconciliation",
      "title": "商家對帳入門",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-reconciliation",
      "description": "核對商家自有帳戶的紀錄與差異；平台不代收款。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-reconciliation/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-reconciliation",
      "source_commit": "c43eac1fa37418a6b7d7569bddf54e2eb4822815",
      "introduction_url": null
    },
    {
      "id": "project-delivery",
      "title": "專案交付與 Sprint",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-project-delivery",
      "description": "整理需求、待辦、驗收與回顧，交付一個可看見的成果。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-project-delivery/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-project-delivery",
      "source_commit": "ae381bcc77e82b4d646e5c3d7f7b63db2a0c0dd2",
      "introduction_url": null
    },
    {
      "id": "agent-kit",
      "title": "平台工具接入包",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-agent-kit",
      "description": "使用版本化 API 讀取會員與工作摘要。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-agent-kit/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-agent-kit",
      "source_commit": null,
      "introduction_url": null
    },
    {
      "id": "project-template",
      "title": "開源專案起始包",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-project-template",
      "description": "建立自己的專案、測試與介紹文件。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-project-template/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-project-template",
      "source_commit": null,
      "introduction_url": null
    },
    {
      "id": "social-post",
      "title": "Hao 社群貼文技能書",
      "repository_url": "https://github.com/FreeTWAI-AI/claude-skill-social-post",
      "description": "社群內容規劃、文案草稿與經確認後的發布流程。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/claude-skill-social-post/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/claude-skill-social-post",
      "source_commit": "c2641ba5ac7d7f722f1cef54b03fbfe553502c7b",
      "introduction_url": null
    },
    {
      "id": "typo-studio",
      "title": "Typo Studio 排版工作室",
      "repository_url": "https://github.com/FreeTWAI-AI/typo-studio",
      "description": "中文友善的輪播貼文排版工具。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/typo-studio/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/typo-studio",
      "source_commit": "9d60be439d150af74a79dbcc5a7547c6108c726f",
      "introduction_url": null
    },
    {
      "id": "video-autopilot",
      "title": "影片自動化工具包",
      "repository_url": "https://github.com/FreeTWAI-AI/video-autopilot-kit",
      "description": "影片素材、字幕與剪輯流程的起始框架。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/video-autopilot-kit/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/video-autopilot-kit",
      "source_commit": "74041fcb292788f4c24e3d06f39fe2c9dee7a8cb",
      "introduction_url": null
    },
    {
      "id": "short-drama",
      "title": "AI 短劇工作流",
      "repository_url": "https://github.com/FreeTWAI-AI/ai-short-drama",
      "description": "短劇故事、分鏡、連貫性與製作流程。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/ai-short-drama/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/ai-short-drama",
      "source_commit": "a1a00d3949fedd74edb6830a79d189a2c76920db",
      "introduction_url": null
    },
    {
      "id": "hao-studio",
      "title": "Hao Studio Web",
      "repository_url": "https://github.com/FreeTWAI-AI/Hao0321-Studio-WEB",
      "description": "Hao 提供的媒體工作室專案；使用前查看來源說明與授權。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/Hao0321-Studio-WEB/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/Hao0321/Hao0321-Studio-WEB",
      "source_commit": "40766413d3263e80d573e7c7928e1816c9f441e0",
      "introduction_url": null
    },
    {
      "id": "media-generator",
      "title": "AI 影音生成技能書",
      "repository_url": "https://github.com/FreeTWAI-AI/ai-media-generator",
      "description": "圖像、影片與音樂提示設計及創作流程。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/ai-media-generator/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/ai-media-generator",
      "source_commit": "edc8aa5227f4a58f9a3a88c7bf3e99bdda2a4361",
      "introduction_url": null
    },
    {
      "id": "pos-pro",
      "title": "POS Pro 商店工具",
      "repository_url": "https://github.com/FreeTWAI-AI/pos-pro",
      "description": "實體店的收銀、庫存、會員與營運工具。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/pos-pro/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/Hao0321/pos-pro",
      "source_commit": "2656945463e95d155fffca19de18014f5f0d75db",
      "introduction_url": null
    },
    {
      "id": "security-scanner",
      "title": "AI Security Scanner",
      "repository_url": "https://github.com/FreeTWAI-AI/ai-security-scanner",
      "description": "協助針對自己有權管理的系統進行安全檢查。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/ai-security-scanner/fork",
      "license_status": "Apache-2.0",
      "upstream_url": "https://github.com/teddashh/ai-security-scanner",
      "source_commit": "9fae58fbf0e78f25fad5b1e9f70104ac5ab73153",
      "introduction_url": "https://teddashh.github.io/ai-security-scanner/"
    },
    {
      "id": "ai-sister",
      "title": "AI Sister",
      "repository_url": "https://github.com/FreeTWAI-AI/AI-Sister",
      "description": "本機優先的桌面助理與專案設計。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/AI-Sister/fork",
      "license_status": "Apache-2.0",
      "upstream_url": "https://github.com/teddashh/AI-Sister",
      "source_commit": "02100bf2e83d3a77bce5dc14c256f4dd4bb5e270",
      "introduction_url": null
    },
    {
      "id": "multi-ai-desktop",
      "title": "Multi-AI Chat Desktop",
      "repository_url": "https://github.com/FreeTWAI-AI/multi-ai-chat-desktop",
      "description": "在自己的桌面協調多個 AI 對話與工作流。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/multi-ai-chat-desktop/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/teddashh/multi-ai-chat-desktop",
      "source_commit": "dd22b21178212cd9b717aafd9cca82d25b85f681",
      "introduction_url": "https://teddashh.github.io/multi-ai-chat-desktop/"
    },
    {
      "id": "multi-ai-chat",
      "title": "Multi-AI Chat",
      "repository_url": "https://github.com/FreeTWAI-AI/multi-ai-chat",
      "description": "多 AI 對話專案。",
      "kind": "reference",
      "fork_url": "https://github.com/FreeTWAI-AI/multi-ai-chat/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/teddashh/multi-ai-chat",
      "source_commit": "cd96e66de6c0a5b2ff6b5f95e09963c66cd0bf7f",
      "introduction_url": "https://teddashh.github.io/multi-ai-chat/"
    }
  ],
  "open_data_source": {
    "repository_url": "https://github.com/Hao0321/freeworkshop-open-data",
    "profile_url": "https://raw.githubusercontent.com/Hao0321/freeworkshop-open-data/main/data/profile.json",
    "upstream_updated": "2026-06-23",
    "note": "較新的規模由主辦方於2026-09-23提供，保留不同來源與日期。"
  }
};
const guildBooks:Record<string,string[]> = {
  "guild_talent_direction": [
    "career-guide"
  ],
  "guild_product_quality_supply": [
    "supplier-client"
  ],
  "guild_commerce_sales": [
    "storefront",
    "pos-pro"
  ],
  "guild_marketing": [
    "social-post",
    "typo-studio"
  ],
  "guild_media_automation": [
    "video-autopilot",
    "short-drama",
    "hao-studio",
    "media-generator"
  ],
  "guild_member_operations": [
    "community-ops"
  ],
  "guild_opportunity_partnership": [
    "partnership"
  ],
  "guild_platform_engineering": [
    "agent-kit",
    "security-scanner"
  ],
  "guild_commerce_settlement": [
    "reconciliation",
    "pos-pro"
  ],
  "guild_ai_vibe": [
    "project-template",
    "multi-ai-desktop",
    "multi-ai-chat",
    "ai-sister"
  ],
  "guild_ai_field": [
    "security-scanner",
    "agent-kit"
  ],
  "guild_ai_project": [
    "project-delivery"
  ]
};
export function skillBooksForGuild(guildKey:string):SkillBook[]{
  const books:SkillBook[]=[];
  for(const id of guildBooks[guildKey]??[]){
    const book=communityCatalog.skill_books.find(b=>b.id===id);
    if(book)books.push(book);
  }
  return books;
}
