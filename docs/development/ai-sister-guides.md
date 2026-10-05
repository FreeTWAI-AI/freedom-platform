# AI Sister newcomer guide

The member selects **新手導覽－AI Sister**, then opens **換角色** beside **問本頁／帶我看** and chooses one character in its **導覽角色** selector. That character stays selected across pages and reloads. Each supported page selects its own outfit; related pages may share an outfit because the source library contains 20 outfit themes for 26 supported pages. The character gallery independently previews all 17 characters, 20 outfits per character and four images per outfit: neutral, supported, challenged and victory. Browsing the gallery does not change the member's guide character.

The app, dialogue, inline guide and gallery use the existing light theme. The shared reserved companion layout follows [PR #122](https://github.com/FreeTWAI-AI/freedom-platform/pull/122), source `aba70369611b7b5bef6f90525c77cd0d12f3649e`: a 264px right column at 1280px and above, a normal-flow row before the page on narrower screens, and questions/history/preferences revealed on demand. The current outfit is visible before interaction, without preloading portraits or the wardrobe. No companion space is reserved until access, page support and release checks pass. The original logo, general help and member authorization retain their existing behavior. The choice is stored under `freedom-ai-sister-character` in the current browser; it is a presentation preference, not account data or authority. Unknown values fall back to Claude. Blocked local storage retains the choice for the current visit. Changing character resets the old conversation/focus/motion, closes the selector and returns focus to **換角色** without opening questions; changing page, account or theme starts from the idle companion with its current outfit visible. The character selector and its outfit hint only appear while **換角色** is expanded; the default companion shows just its character and three actions. Escape or pressing **換角色** again closes the selector and restores button focus. Switching help modes or opening outside dialogs also closes it. Merely opening the selector does not load question content or reaction images. `private-ai`, registration, onboarding, admin and skill-book dialogs remain disabled.

## Source and artwork

The owner requested reuse of their AI Sister characters, specifically the Admin **角色設計 → 服裝** library. Canonical identity and the read-only wardrobe validator are pinned to `teddashh/Multi-Ai-Chatapp` commit `563461cd61cbd35e7cb2b844cf804b774775c4bf`. The 17-character roster consists of Claude, ChatGPT, Gemini, Grok, DeepSeek, Qwen, Mistral, Llama (upstream ID `venice`), Sakana, Perplexity, GLM, Kimi, Hunyuan, MiniMax, Nemotron, Cohere and MiMo. No extra novel characters or personal/admin data are imported.

Wardrobe PNGs are an owner-approved local snapshot used by the source Admin implementation, not Git blobs. The read-only validator found 340 approved usable outfits and 1,020 usable reaction poses with valid source receipt checks. Rig completeness is independent and is not required or claimed for these static reaction images. The source checkout, approval ledger, rig assets and generation pipeline are unchanged. No new image generation was performed.

`docs/design/ai-sister-guide-art-manifest.json` records each source path relative to its source kind, source SHA-256, available receipt SHA-256, conversion settings and output SHA. Portraits come from committed avatars. The wardrobe inventory digest ties the import to the read-only validation snapshot. Full private paths and approval account names are excluded. Processing only resizes and converts to WebP, preserving the complete composition and alpha channel.

The immutable version `ai-sister-v1-20261005` contains **1,377 unique objects**, totaling **62,044,286 bytes**: 17 portraits, 340 outfits and 1,020 reactions. The exact manifest pin is `b2fbf0d348ac72729c2170a0f95a6c407907fefb1f7bdfaeb7733b0c5a2795c2`. Files remain outside Vite's public/dist tree. Full reproduction requires the owner's source checkout and validated wardrobe snapshot:

```sh
npx tsx scripts/import-ai-sister-guides.ts \
  --source-repo /path/to/Multi-Ai-Chatapp \
  --wardrobe-root /path/to/video-mvp \
  --inventory /path/to/wardrobe-inventory.json
```

The importer never uploads or enables a release. It emits an OFF code pin. Retain the raw snapshot and read-only inventory with operator evidence; the public provenance records their hashes and selected image sources, not the entire private source tree.

## Page outfits

`AI_SISTER_PAGE_SUPPORT` is the explicit page contract; all supported entries use `member-selected` character identity, a page-specific outfit and the shared reviewed product content/anchors.

| Outfit | Pages |
| --- | --- |
| 教育 | 會員首頁、技能書架 |
| 國際 | 職業公會 |
| 人際 | 我的訊息、我的好友 |
| 節慶 | 社群活動 |
| 科技 | 社群任務、開源投稿 |
| 文化 | 工坊夥伴、作品與需求 |
| 媒體 | 活動集錦、社群分享、行銷工作室 |
| 心理 | 我的定位 |
| 運動 | 小隊集合 |
| 科學 | 一起開發 |
| 健康 | 社員服務 |
| 財經 | 推廣排行榜 |
| 職場 | 我的工作 |
| 法律 | 合作紀錄 |
| 美食 | 我有東西要賣 |
| 旅行 | 我可以賣東西 |
| 公共事務 | 公會管理 |
| 環境 | 自由工坊社群 |
| 居家 | 我的名片 |
| 哲學 | 待辦清單 |

Outfits change presentation. Reviewed answers still describe only the current platform page; there are no model calls, message reads or business writes. Shared facts and safe anchors retain attribution to mars-tw PR #106. The engine switches among real still reactions on greeting, thinking and thanks; reduced-motion/static-energy preferences retain the neutral outfit. It never preloads the full wardrobe.

## Publication boundary

`GET /api/v1/guide-packs/release/ai-sister` advertises only the independently reviewed AI Sister release. The old `/api/v1/guide-packs/release` remains Dragon-compatible. Exact immutable assets use `/public/guide-packs/ai-sister/{version}/{sha256}.webp`, backed by the existing private `GUIDE_STATIC` purpose. Pack dispatch cannot borrow another pack's namespace or fall back to MEDIA. All seven MEDIA settings and GC OFF are preserved.

The separate activation change enables the AI Sister code pin using [complete per-environment publisher readbacks](ai-sister-publisher-2026-10-05.md). Both private origins hold all 1,377 objects, and the code pin binds the receipt set's exact bytes. Deployment still requires CI, independent review and merge, the explicit host flag and correct native binding, then staging acceptance before production. Local fixtures cannot activate a remote environment. The publisher receipts establish object publication; they do not establish Worker deployment or live browser acceptance.

```sh
npm run guide:publish-plan -- \
  --fixture-root assets/guide-packs/ai-sister-v1-20261005 --pack ai-sister
```

This command fully decodes and hashes the local objects and emits a publication plan. It is not an uploader or a publisher receipt. Follow [public asset delivery](public-guide-assets.md) for private-origin mapping, receipt-backed activation and staging acceptance before production.
