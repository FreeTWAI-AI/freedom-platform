import { skillBookGuides, type SkillBookGuide } from './skill-book-guides.js';
import {memberSkillBooks} from './member-skill-books.js';
// Community-owned catalog. Source repositories are linked/forked, never executed during onboarding.
export type CatalogOption = {id:string;label:string};
export type CatalogSubcategory = {id:string;label:string;items:CatalogOption[]};
export type CatalogCategory = {id:string;label:string;items:CatalogOption[];subcategories?:CatalogSubcategory[]};
export type SkillBook = {id:string;title:string;repository_url:string;description:string;kind:string;fork_url:string;license_status:string;upstream_url:string;source_commit:string|null;introduction_url:string|null;guide?:SkillBookGuide;cover_url?:string;star_url?:string};
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
    ],
    "subcategories": [
      {
        "id": "exploration",
        "label": "入門探索",
        "items": [
          {
            "id": "getting_started",
            "label": "剛開始探索，想從基礎學起"
          }
        ]
      },
      {
        "id": "general",
        "label": "研究與溝通",
        "items": [
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
    ],
    "subcategories": [
      {
        "id": "assistants",
        "label": "AI 助手使用",
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
          }
        ]
      },
      {
        "id": "systems",
        "label": "Agent 與知識流程",
        "items": [
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
    ],
    "subcategories": [
      {
        "id": "web_scripts",
        "label": "網頁與腳本",
        "items": [
          {
            "id": "javascript",
            "label": "JavaScript"
          },
          {
            "id": "typescript",
            "label": "TypeScript"
          },
          {
            "id": "python",
            "label": "Python"
          },
          {
            "id": "php",
            "label": "PHP"
          }
        ]
      },
      {
        "id": "systems",
        "label": "應用與系統語言",
        "items": [
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
          }
        ]
      },
      {
        "id": "data_shell",
        "label": "資料查詢與命令列",
        "items": [
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
    ],
    "subcategories": [
      {
        "id": "frontend",
        "label": "網頁介面",
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
            "id": "wordpress",
            "label": "WordPress"
          }
        ]
      },
      {
        "id": "backend",
        "label": "網站服務",
        "items": [
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
          }
        ]
      },
      {
        "id": "apps",
        "label": "跨平台應用",
        "items": [
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
          }
        ]
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
    ],
    "subcategories": [
      {
        "id": "editing",
        "label": "編輯器與開發環境",
        "items": [
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
          }
        ]
      },
      {
        "id": "collaboration",
        "label": "版本與程式協作",
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
            "id": "api_design",
            "label": "API 設計"
          },
          {
            "id": "code_review",
            "label": "程式審查"
          }
        ]
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
    ],
    "subcategories": [
      {
        "id": "workflow",
        "label": "流程建置工具",
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
          }
        ]
      },
      {
        "id": "bridges",
        "label": "通知與機器人整合",
        "items": [
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
    ],
    "subcategories": [
      {
        "id": "databases",
        "label": "資料庫",
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
          }
        ]
      },
      {
        "id": "analysis",
        "label": "試算表與分析",
        "items": [
          {
            "id": "excel",
            "label": "Excel／試算表"
          },
          {
            "id": "powerbi",
            "label": "Power BI"
          }
        ]
      },
      {
        "id": "hosting",
        "label": "部署與雲端",
        "items": [
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
          }
        ]
      },
      {
        "id": "reliability",
        "label": "交付與復原",
        "items": [
          {
            "id": "ci_cd",
            "label": "CI/CD"
          },
          {
            "id": "backup",
            "label": "備份與還原"
          }
        ]
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
        "label": "個資保護"
      },
      {
        "id": "monitoring",
        "label": "監控與問題排查"
      }
    ],
    "subcategories": [
      {
        "id": "testing",
        "label": "測試流程",
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
          }
        ]
      },
      {
        "id": "protection",
        "label": "保護與觀察",
        "items": [
          {
            "id": "security_review",
            "label": "安全檢查"
          },
          {
            "id": "privacy",
            "label": "個資保護"
          },
          {
            "id": "monitoring",
            "label": "監控與問題排查"
          }
        ]
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
    ],
    "subcategories": [
      {
        "id": "visual",
        "label": "介面與視覺",
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
          }
        ]
      },
      {
        "id": "editing",
        "label": "剪輯與影音工具",
        "items": [
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
          }
        ]
      },
      {
        "id": "story",
        "label": "故事與聲音",
        "items": [
          {
            "id": "storyboard",
            "label": "腳本與分鏡"
          },
          {
            "id": "audio",
            "label": "聲音與配樂"
          }
        ]
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
    ],
    "subcategories": [
      {
        "id": "content",
        "label": "內容與曝光",
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
          }
        ]
      },
      {
        "id": "measurement",
        "label": "廣告與成效觀察",
        "items": [
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
          }
        ]
      },
      {
        "id": "community",
        "label": "社群與活動",
        "items": [
          {
            "id": "community_ops",
            "label": "社群營運"
          },
          {
            "id": "event_hosting",
            "label": "活動主持"
          }
        ]
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
    ],
    "subcategories": [
      {
        "id": "supply",
        "label": "供貨與商品",
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
          }
        ]
      },
      {
        "id": "delivery",
        "label": "庫存與物流",
        "items": [
          {
            "id": "inventory",
            "label": "庫存管理"
          },
          {
            "id": "logistics",
            "label": "出貨與物流"
          }
        ]
      },
      {
        "id": "retail",
        "label": "店務與服務",
        "items": [
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
          }
        ]
      },
      {
        "id": "accounts",
        "label": "帳務整理",
        "items": [
          {
            "id": "accounting",
            "label": "會計基礎"
          },
          {
            "id": "reconciliation",
            "label": "對帳"
          }
        ]
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
        "label": "PMP 相關知識／經驗（自填）"
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
    ],
    "subcategories": [
      {
        "id": "planning",
        "label": "需求與專案",
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
            "label": "PMP 相關知識／經驗（自填）"
          }
        ]
      },
      {
        "id": "methods",
        "label": "協作方法",
        "items": [
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
          }
        ]
      },
      {
        "id": "people",
        "label": "陪跑與協商",
        "items": [
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
    ]
  },
  {
    "id": "security_practice",
    "label": "資安與修復驗證",
    "items": [
      {
        "id": "threat_modeling",
        "label": "威脅建模"
      },
      {
        "id": "dependency_audit",
        "label": "相依套件與供應鏈檢查"
      },
      {
        "id": "access_review",
        "label": "權限與存取檢查"
      },
      {
        "id": "vulnerability_reproduction",
        "label": "授權範圍內的問題重現"
      },
      {
        "id": "incident_triage",
        "label": "事件初步分析與分流"
      },
      {
        "id": "remediation_verification",
        "label": "修復驗證"
      }
    ],
    "subcategories": [
      {
        "id": "prevention",
        "label": "風險與範圍",
        "items": [
          {
            "id": "threat_modeling",
            "label": "威脅建模"
          },
          {
            "id": "dependency_audit",
            "label": "相依套件與供應鏈檢查"
          },
          {
            "id": "access_review",
            "label": "權限與存取檢查"
          }
        ]
      },
      {
        "id": "verification",
        "label": "問題分析與修復驗證",
        "items": [
          {
            "id": "vulnerability_reproduction",
            "label": "授權範圍內的問題重現"
          },
          {
            "id": "incident_triage",
            "label": "事件初步分析與分流"
          },
          {
            "id": "remediation_verification",
            "label": "修復驗證"
          }
        ]
      }
    ]
  },
  {
    "id": "music_creation",
    "label": "音樂創作與 MV",
    "items": [
      {
        "id": "composition",
        "label": "作曲與旋律設計"
      },
      {
        "id": "lyric_writing",
        "label": "歌詞創作"
      },
      {
        "id": "arrangement",
        "label": "編曲"
      },
      {
        "id": "daw_workflow",
        "label": "DAW 音樂工作流程"
      },
      {
        "id": "vocal_recording",
        "label": "人聲與樂器錄音"
      },
      {
        "id": "mixing_mastering",
        "label": "混音與母帶製作"
      },
      {
        "id": "mv_direction",
        "label": "MV 故事與導演"
      },
      {
        "id": "music_source_tracking",
        "label": "音樂與影像素材來源整理"
      }
    ],
    "subcategories": [
      {
        "id": "composition",
        "label": "詞曲與編曲",
        "items": [
          {
            "id": "composition",
            "label": "作曲與旋律設計"
          },
          {
            "id": "lyric_writing",
            "label": "歌詞創作"
          },
          {
            "id": "arrangement",
            "label": "編曲"
          }
        ]
      },
      {
        "id": "production",
        "label": "聲音製作",
        "items": [
          {
            "id": "daw_workflow",
            "label": "DAW 音樂工作流程"
          },
          {
            "id": "vocal_recording",
            "label": "人聲與樂器錄音"
          },
          {
            "id": "mixing_mastering",
            "label": "混音與母帶製作"
          }
        ]
      },
      {
        "id": "mv",
        "label": "MV 與素材管理",
        "items": [
          {
            "id": "mv_direction",
            "label": "MV 故事與導演"
          },
          {
            "id": "music_source_tracking",
            "label": "音樂與影像素材來源整理"
          }
        ]
      }
    ]
  },
  {
    "id": "commercial_production",
    "label": "廣告攝影與影片",
    "items": [
      {
        "id": "product_photography",
        "label": "商品攝影"
      },
      {
        "id": "lighting_design",
        "label": "燈光配置"
      },
      {
        "id": "commercial_art_direction",
        "label": "商業影像美術與風格"
      },
      {
        "id": "camera_operation",
        "label": "攝影機操作與鏡位"
      },
      {
        "id": "commercial_brief",
        "label": "拍攝需求與廣告 brief"
      },
      {
        "id": "color_grading",
        "label": "調光與調色"
      },
      {
        "id": "production_delivery",
        "label": "渠道尺寸與交付版本管理"
      }
    ],
    "subcategories": [
      {
        "id": "planning",
        "label": "拍攝企劃與風格",
        "items": [
          {
            "id": "commercial_art_direction",
            "label": "商業影像美術與風格"
          },
          {
            "id": "commercial_brief",
            "label": "拍攝需求與廣告 brief"
          }
        ]
      },
      {
        "id": "shooting",
        "label": "攝影與燈光",
        "items": [
          {
            "id": "product_photography",
            "label": "商品攝影"
          },
          {
            "id": "lighting_design",
            "label": "燈光配置"
          },
          {
            "id": "camera_operation",
            "label": "攝影機操作與鏡位"
          }
        ]
      },
      {
        "id": "delivery",
        "label": "後製與交付",
        "items": [
          {
            "id": "color_grading",
            "label": "調光與調色"
          },
          {
            "id": "production_delivery",
            "label": "渠道尺寸與交付版本管理"
          }
        ]
      }
    ]
  },
  {
    "id": "sales_support",
    "label": "銷售與客戶支持",
    "items": [
      {
        "id": "customer_interview",
        "label": "客戶需求訪談"
      },
      {
        "id": "lead_qualification",
        "label": "潛在客戶需求分流"
      },
      {
        "id": "solution_pitch",
        "label": "方案介紹與提案"
      },
      {
        "id": "product_demo",
        "label": "商品或服務示範"
      },
      {
        "id": "relationship_management",
        "label": "客戶關係維護"
      },
      {
        "id": "support_triage",
        "label": "客服問題分流"
      },
      {
        "id": "knowledge_base",
        "label": "客服知識庫整理"
      },
      {
        "id": "after_sales",
        "label": "售後服務"
      },
      {
        "id": "complaint_resolution",
        "label": "客訴溝通與處理"
      }
    ],
    "subcategories": [
      {
        "id": "sales",
        "label": "需求與提案",
        "items": [
          {
            "id": "customer_interview",
            "label": "客戶需求訪談"
          },
          {
            "id": "lead_qualification",
            "label": "潛在客戶需求分流"
          },
          {
            "id": "solution_pitch",
            "label": "方案介紹與提案"
          },
          {
            "id": "product_demo",
            "label": "商品或服務示範"
          }
        ]
      },
      {
        "id": "support",
        "label": "關係與售後",
        "items": [
          {
            "id": "relationship_management",
            "label": "客戶關係維護"
          },
          {
            "id": "support_triage",
            "label": "客服問題分流"
          },
          {
            "id": "knowledge_base",
            "label": "客服知識庫整理"
          },
          {
            "id": "after_sales",
            "label": "售後服務"
          },
          {
            "id": "complaint_resolution",
            "label": "客訴溝通與處理"
          }
        ]
      }
    ]
  },
  {
    "id": "craft_food",
    "label": "手作、餐飲與商品呈現",
    "items": [
      {
        "id": "craft_design",
        "label": "手作商品設計"
      },
      {
        "id": "sewing",
        "label": "縫紉與布作"
      },
      {
        "id": "woodworking",
        "label": "木作"
      },
      {
        "id": "physical_prototyping",
        "label": "實體打樣與模型"
      },
      {
        "id": "food_preparation",
        "label": "食材與餐飲製作"
      },
      {
        "id": "baking",
        "label": "烘焙"
      },
      {
        "id": "packaging_design",
        "label": "包裝設計"
      },
      {
        "id": "retail_display",
        "label": "商品陳列"
      }
    ],
    "subcategories": [
      {
        "id": "craft",
        "label": "手作與打樣",
        "items": [
          {
            "id": "craft_design",
            "label": "手作商品設計"
          },
          {
            "id": "sewing",
            "label": "縫紉與布作"
          },
          {
            "id": "woodworking",
            "label": "木作"
          },
          {
            "id": "physical_prototyping",
            "label": "實體打樣與模型"
          }
        ]
      },
      {
        "id": "food",
        "label": "餐飲製作",
        "items": [
          {
            "id": "food_preparation",
            "label": "食材與餐飲製作"
          },
          {
            "id": "baking",
            "label": "烘焙"
          }
        ]
      },
      {
        "id": "presentation",
        "label": "包裝與陳列",
        "items": [
          {
            "id": "packaging_design",
            "label": "包裝設計"
          },
          {
            "id": "retail_display",
            "label": "商品陳列"
          }
        ]
      }
    ]
  },
  {
    "id": "field_operations",
    "label": "現場執行與活動支援",
    "items": [
      {
        "id": "onsite_coordination",
        "label": "現場人員與流程協調"
      },
      {
        "id": "event_checkin",
        "label": "活動報到與接待"
      },
      {
        "id": "equipment_setup",
        "label": "器材準備與架設"
      },
      {
        "id": "venue_planning",
        "label": "場地與動線規劃"
      },
      {
        "id": "procurement",
        "label": "採購詢價與交期協調"
      },
      {
        "id": "delivery_scheduling",
        "label": "出貨與派送排程"
      },
      {
        "id": "operating_procedures",
        "label": "作業步驟與交接整理"
      }
    ],
    "subcategories": [
      {
        "id": "onsite",
        "label": "活動現場",
        "items": [
          {
            "id": "onsite_coordination",
            "label": "現場人員與流程協調"
          },
          {
            "id": "event_checkin",
            "label": "活動報到與接待"
          },
          {
            "id": "equipment_setup",
            "label": "器材準備與架設"
          },
          {
            "id": "venue_planning",
            "label": "場地與動線規劃"
          }
        ]
      },
      {
        "id": "logistics",
        "label": "採購與作業",
        "items": [
          {
            "id": "procurement",
            "label": "採購詢價與交期協調"
          },
          {
            "id": "delivery_scheduling",
            "label": "出貨與派送排程"
          },
          {
            "id": "operating_procedures",
            "label": "作業步驟與交接整理"
          }
        ]
      }
    ]
  },
  {
    "id": "education_languages",
    "label": "教學、語言與知識轉譯",
    "items": [
      {
        "id": "training_design",
        "label": "教學與工作坊設計"
      },
      {
        "id": "workshop_teaching",
        "label": "工作坊帶領"
      },
      {
        "id": "learning_review",
        "label": "學習成果回饋"
      },
      {
        "id": "translation",
        "label": "文字翻譯"
      },
      {
        "id": "localization",
        "label": "內容在地化"
      },
      {
        "id": "bilingual_facilitation",
        "label": "雙語溝通協作"
      },
      {
        "id": "technical_writing",
        "label": "技術內容轉譯"
      }
    ],
    "subcategories": [
      {
        "id": "teaching",
        "label": "教學與陪伴",
        "items": [
          {
            "id": "training_design",
            "label": "教學與工作坊設計"
          },
          {
            "id": "workshop_teaching",
            "label": "工作坊帶領"
          },
          {
            "id": "learning_review",
            "label": "學習成果回饋"
          }
        ]
      },
      {
        "id": "language",
        "label": "語言與內容",
        "items": [
          {
            "id": "translation",
            "label": "文字翻譯"
          },
          {
            "id": "localization",
            "label": "內容在地化"
          },
          {
            "id": "bilingual_facilitation",
            "label": "雙語溝通協作"
          },
          {
            "id": "technical_writing",
            "label": "技術內容轉譯"
          }
        ]
      }
    ]
  },
  {
    "id": "business_support",
    "label": "行政與營運整理",
    "items": [
      {
        "id": "scheduling",
        "label": "行事曆與人力排程"
      },
      {
        "id": "document_management",
        "label": "文件與檔案整理"
      },
      {
        "id": "data_entry",
        "label": "資料輸入與核對"
      },
      {
        "id": "cost_estimation",
        "label": "成本估算與報價整理"
      },
      {
        "id": "meeting_notes",
        "label": "會議紀錄與追蹤"
      },
      {
        "id": "business_reporting",
        "label": "營運報表整理"
      }
    ],
    "subcategories": [
      {
        "id": "admin",
        "label": "行政整理",
        "items": [
          {
            "id": "scheduling",
            "label": "行事曆與人力排程"
          },
          {
            "id": "document_management",
            "label": "文件與檔案整理"
          },
          {
            "id": "data_entry",
            "label": "資料輸入與核對"
          }
        ]
      },
      {
        "id": "management",
        "label": "營運追蹤",
        "items": [
          {
            "id": "cost_estimation",
            "label": "成本估算與報價整理"
          },
          {
            "id": "meeting_notes",
            "label": "會議紀錄與追蹤"
          },
          {
            "id": "business_reporting",
            "label": "營運報表整理"
          }
        ]
      }
    ]
  },
{
  "id": "projection_mapping",
  "label": "光影與光雕",
  "items": [
    {
      "id": "projection_survey",
      "label": "投影場勘與表面配置"
    },
    {
      "id": "projection_visuals",
      "label": "光雕視覺與動態素材"
    },
    {
      "id": "projection_cues",
      "label": "播放 cue 與排程"
    },
    {
      "id": "projection_calibration",
      "label": "投影對位與校正"
    }
  ],
  "subcategories": [
    {
      "id": "planning",
      "label": "場勘與畫面規劃",
      "items": [
        {
          "id": "projection_survey",
          "label": "投影場勘與表面配置"
        },
        {
          "id": "projection_visuals",
          "label": "光雕視覺與動態素材"
        }
      ]
    },
    {
      "id": "playback",
      "label": "播放與交接",
      "items": [
        {
          "id": "projection_cues",
          "label": "播放 cue 與排程"
        },
        {
          "id": "projection_calibration",
          "label": "投影對位與校正"
        }
      ]
    }
  ]
},
{
  "id": "human_design",
  "label": "人類圖共讀",
  "items": [
    {
      "id": "human_design_reading",
      "label": "人類圖概念共讀"
    },
    {
      "id": "human_design_sources",
      "label": "多來源筆記與觀點整理"
    },
    {
      "id": "reflection_facilitation",
      "label": "自我反思提問"
    },
    {
      "id": "study_facilitation",
      "label": "共讀主持與匿名紀錄"
    }
  ],
  "subcategories": [
    {
      "id": "reading",
      "label": "閱讀與來源",
      "items": [
        {
          "id": "human_design_reading",
          "label": "人類圖概念共讀"
        },
        {
          "id": "human_design_sources",
          "label": "多來源筆記與觀點整理"
        }
      ]
    },
    {
      "id": "facilitation",
      "label": "引導與反思",
      "items": [
        {
          "id": "reflection_facilitation",
          "label": "自我反思提問"
        },
        {
          "id": "study_facilitation",
          "label": "共讀主持與匿名紀錄"
        }
      ]
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
    ],
    "subcategories": [
      {
        "id": "general",
        "label": "AI 助手",
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
          }
        ]
      },
      {
        "id": "coding",
        "label": "開發協作工具",
        "items": [
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
    ],
    "subcategories": [
      {
        "id": "design",
        "label": "設計與影像",
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
            "id": "sub_midjourney",
            "label": "Midjourney"
          }
        ]
      },
      {
        "id": "audio_video",
        "label": "聲音與影片",
        "items": [
          {
            "id": "sub_capcut",
            "label": "CapCut"
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
    ],
    "subcategories": [
      {
        "id": "automation",
        "label": "流程自動化",
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
          }
        ]
      },
      {
        "id": "collaboration",
        "label": "文件與辦公協作",
        "items": [
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
    ],
    "subcategories": [
      {
        "id": "cloud",
        "label": "雲端服務",
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
          }
        ]
      },
      {
        "id": "commerce",
        "label": "商店服務",
        "items": [
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
    ]
  },
  {
    "id": "music_subscriptions",
    "label": "音樂製作訂閱與服務",
    "items": [
      {
        "id": "sub_music_daw",
        "label": "音樂製作／DAW 訂閱"
      },
      {
        "id": "sub_music_library",
        "label": "音樂與音效素材庫訂閱"
      },
      {
        "id": "sub_stem_tools",
        "label": "音軌分離與音訊處理服務"
      }
    ],
    "subcategories": [
      {
        "id": "production",
        "label": "聲音製作工具",
        "items": [
          {
            "id": "sub_music_daw",
            "label": "音樂製作／DAW 訂閱"
          },
          {
            "id": "sub_stem_tools",
            "label": "音軌分離與音訊處理服務"
          }
        ]
      },
      {
        "id": "sources",
        "label": "音樂素材資源",
        "items": [
          {
            "id": "sub_music_library",
            "label": "音樂與音效素材庫訂閱"
          }
        ]
      }
    ]
  },
  {
    "id": "commercial_subscriptions",
    "label": "商業影像訂閱與服務",
    "items": [
      {
        "id": "sub_stock_video",
        "label": "影片與圖片素材庫訂閱"
      },
      {
        "id": "sub_review_delivery",
        "label": "客戶審片與交付服務"
      },
      {
        "id": "sub_color_tools",
        "label": "調色與影像後製服務"
      }
    ],
    "subcategories": [
      {
        "id": "production",
        "label": "後製與審片",
        "items": [
          {
            "id": "sub_review_delivery",
            "label": "客戶審片與交付服務"
          },
          {
            "id": "sub_color_tools",
            "label": "調色與影像後製服務"
          }
        ]
      },
      {
        "id": "sources",
        "label": "影像素材資源",
        "items": [
          {
            "id": "sub_stock_video",
            "label": "影片與圖片素材庫訂閱"
          }
        ]
      }
    ]
  },
  {
    "id": "business_subscriptions",
    "label": "客戶與營運服務",
    "items": [
      {
        "id": "sub_crm",
        "label": "CRM／客戶關係服務"
      },
      {
        "id": "sub_helpdesk",
        "label": "客服工單服務"
      },
      {
        "id": "sub_email_marketing",
        "label": "Email 行銷服務"
      },
      {
        "id": "sub_scheduling",
        "label": "預約與排程服務"
      },
      {
        "id": "sub_inventory",
        "label": "庫存與採購服務"
      },
      {
        "id": "sub_accounting",
        "label": "記帳與報表服務"
      }
    ],
    "subcategories": [
      {
        "id": "relationships",
        "label": "客戶關係",
        "items": [
          {
            "id": "sub_crm",
            "label": "CRM／客戶關係服務"
          },
          {
            "id": "sub_helpdesk",
            "label": "客服工單服務"
          },
          {
            "id": "sub_email_marketing",
            "label": "Email 行銷服務"
          }
        ]
      },
      {
        "id": "operations",
        "label": "營運與排程",
        "items": [
          {
            "id": "sub_scheduling",
            "label": "預約與排程服務"
          },
          {
            "id": "sub_inventory",
            "label": "庫存與採購服務"
          },
          {
            "id": "sub_accounting",
            "label": "記帳與報表服務"
          }
        ]
      }
    ]
  },
  {
    "id": "learning_subscriptions",
    "label": "學習與知識服務",
    "items": [
      {
        "id": "sub_learning_platform",
        "label": "線上課程與學習平台"
      },
      {
        "id": "sub_translation",
        "label": "翻譯與語言服務"
      },
      {
        "id": "sub_reference_library",
        "label": "專業資料庫與參考資源"
      }
    ],
    "subcategories": [
      {
        "id": "learning",
        "label": "學習與語言",
        "items": [
          {
            "id": "sub_learning_platform",
            "label": "線上課程與學習平台"
          },
          {
            "id": "sub_translation",
            "label": "翻譯與語言服務"
          }
        ]
      },
      {
        "id": "references",
        "label": "知識資源",
        "items": [
          {
            "id": "sub_reference_library",
            "label": "專業資料庫與參考資源"
          }
        ]
      }
    ]
  }
];
const communityCatalogBase = {
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
    ...memberSkillBooks,
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
    },
    {
      "id": "music-mv",
      "title": "音樂與 MV 製作入門手冊",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-music-mv",
      "description": "原創製作手冊與可填模板：歌曲構想、MV 企劃、素材來源及交付檢查；不是自動作曲軟體。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-music-mv/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-music-mv",
      "source_commit": "c189cbcbde61d2a4b109ba6e72f2ee8882f9ee07",
      "introduction_url": null
    },
    {
      "id": "commercial-production",
      "title": "廣告攝影與影片製作入門手冊",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-commercial-production",
      "description": "原創拍攝手冊與可填模板：商業 brief、商品鏡位、拍攝安排與交付檢查；不是自動產片服務。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-commercial-production/fork",
      "license_status": "NOASSERTION",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-commercial-production",
      "source_commit": "815b0a2f2bff90f9c9624d35a144d8bb70477667",
      "introduction_url": null
    },
    {
      "id": "event-space",
      "title": "活動與空間實作手冊",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-event-space",
      "description": "把讀書會、聚會或小型展演整理成場地 brief、動線與現場分工。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-event-space/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-event-space",
      "source_commit": "574c00b651e89248876c2846484c105623076cac",
      "introduction_url": null
    },
    {
      "id": "projection-mapping",
      "title": "光影與光雕製作手冊",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-projection-mapping",
      "description": "把投影光雕構想整理成場勘、畫面分區、素材規格與播放 cue。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-projection-mapping/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-projection-mapping",
      "source_commit": "4d43669501aabbaf329989d32e4e404a80f1a539",
      "introduction_url": null
    },
    {
      "id": "human-design",
      "title": "人類圖共讀與研究手冊",
      "repository_url": "https://github.com/FreeTWAI-AI/freedom-skill-human-design",
      "description": "整理人類圖共讀筆記、來源與反思提問，保留不同解讀及本人選擇。",
      "kind": "starter",
      "fork_url": "https://github.com/FreeTWAI-AI/freedom-skill-human-design/fork",
      "license_status": "MIT",
      "upstream_url": "https://github.com/FreeTWAI-AI/freedom-skill-human-design",
      "source_commit": "74f4a7fc6e6abb2bf36a75980ee72448563385d4",
      "introduction_url": null
    }
  ],
  "open_data_source": {
    "repository_url": "https://github.com/Hao0321/freeworkshop-open-data",
    "profile_url": "https://raw.githubusercontent.com/Hao0321/freeworkshop-open-data/main/data/profile.json",
    "upstream_updated": "2026-06-23",
    "note": "較新的規模由主辦方於2026-09-23提供，保留不同來源與日期。"
  }
};
function withSkillBookGuide(book:SkillBook):SkillBook {
  const guide=skillBookGuides[book.id];
  const visuals={cover_url:`/art/skills/${book.id}.webp`,star_url:book.upstream_url};
  return guide?{...book,...visuals,description:guide.summary,source_commit:book.source_commit??guide.source_commit,introduction_url:book.introduction_url??guide.website_url??null,guide}:{...book,...visuals};
}
export const communityCatalog = {...communityCatalogBase,
  skill_books:communityCatalogBase.skill_books.map(withSkillBookGuide),
  featured_projects:communityCatalogBase.featured_projects.map(withSkillBookGuide),
};

const guildBooks:Record<string,string[]> = {
  "guild_event_space": ["event-space", "freedom-party-guild-lounge"],
  "guild_projection_mapping": ["projection-mapping"],
  "guild_human_design": ["human-design"],
  "guild_talent_direction": [
    "career-guide", "positioning-companion"
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
    "media-generator", "editkin"
  ],
  "guild_member_operations": [
    "community-ops", "freedom-party-guild-lounge"
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
    "ai-sister", "local-workspace-mcp"
  ],
  "guild_ai_field": [
    "security-scanner",
    "agent-kit", "local-workspace-mcp"
  ],
  "guild_ai_project": [
    "project-delivery"
  ],
  "guild_security": [
    "security-scanner"
  ],
  "guild_music_mv": [
    "music-mv"
  ],
  "guild_commercial_production": [
    "commercial-production"
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
