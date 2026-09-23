# 公會分組與解鎖書架 · 0.11.1-guild-library

## 會員操作

職業公會分為三區。第一區最多三張卡：一個主要公會、最多兩個次要公會，按保存的順序顯示。「設定次要公會」從其他有效會員關係中選擇；取消所有勾選會保留空白，不自動補上。其他已加入、未加入各自列在下面。搜尋只過濾畫面，不重新指定主次關係。

加入新公會會出現在其他已加入區，不擠掉既有次要。升為主要時，原主要在有空位且未明確清空次要的情況下補入次要；退出次要會移除該選擇，重新加入不自動恢復。

每張卡保留公會長與最多三位專家的獨立人物列，只列第一本入門技能。完整技能書庫、成員與公告透過對話框閱讀，可按關閉或 Esc 回到原按鈕。卡片依所有可見卡片的實際內容統一高度，響應螢幕寬度與長名字；不截斷人物或將展開內容塞回卡片。

技能書架預設「已解鎖」，另一區「未解鎖」是現有目錄扣除實際領取紀錄。未解鎖仍可免費預覽介紹及公開 Repo，加入對應公會後領取。退出公會不刪除已領取技能書。讀取領取紀錄失敗時顯示重試，不假設所有書都未解鎖。

## 開發入口

- 畫面分區與選擇：`apps/portal-web/src/modules/PositioningPanels.tsx`。
- 等尺寸卡片、對話框及量測：`apps/portal-web/src/modules/GuildCard.tsx`、`GuildDesign.css`。
- 兩區書架：`SkillsPanel.tsx`、`Community.tsx`、`SkillBookIntro.tsx`。
- PostgreSQL：`migrations/027_secondary_guild_preferences.sql` 回填既有會員的有效前兩個次要，首次定位亦保存實際選擇。
- 指令與投影：`modules/positioning/onboarding.ts`、`service.ts`，API 見 [會員 API](member-api.md)。

次要偏好只改顯示，不授予管理、Repo、聯絡方式或額外技能書存取權。會員名片最多兩個次要，其餘保留在 `joined_guilds`；工坊夥伴加入紀錄仍包含全部有效公會。

## 驗證入口

```sh
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:contracts
npm run test:repos
npm run verify:inventory
```

新增 runtime 覆蓋 migration 真回填、初次保存、重新定位、主要交換、清空、再入會、版本／冪等與並行退出。瀏覽器使用隔離會員或合成資料驗三區、六公會選擇、巢狀書庫對話框、解鎖互斥目錄、API 失敗與 1440／390／320px 卡片等高及完整人物。
