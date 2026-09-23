-- Shared catalogs are global. Member facts always carry the current community.
CREATE TABLE positioning_guild_catalog (
  guild_key text PRIMARY KEY, profession_key text UNIQUE NOT NULL,
  name text NOT NULL, purpose text NOT NULL, first_step text NOT NULL,
  module_key text NOT NULL, catalog_version integer NOT NULL DEFAULT 1
);
INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key) VALUES
('guild_talent_direction','talent_direction','人才與方向公會','協助會員探索方向、學習與陪跑。','整理一張自己確認的方向卡。','positioning'),
('guild_product_quality_supply','product_quality_supply','商品品質與供應公會','整理實體商品、供貨條件與品質資訊。','建立一件商品草稿與可供條件。','supplier'),
('guild_commerce_sales','commerce_sales','電商與銷售公會','選貨、經營商店與服務買家。','選一件商品，整理你的銷售計畫。','retail'),
('guild_marketing','marketing','成長與行銷公會','製作內容、設計活動並觀察成效。','為一件商品寫一份行銷草稿。','marketing'),
('guild_media_automation','media_automation','媒體自動化公會','製作影片、字幕與可重用媒體流程。','整理一段素材與剪輯需求。','workbench'),
('guild_member_operations','member_operations','會員與社群營運公會','協助會員加入、交流與找到下一步。','整理一份新人常見問題。','guilds'),
('guild_opportunity_partnership','opportunity_partnership','商機與夥伴公會','理解需求並連結合作夥伴。','寫清一個需求與預期成果。','engagement'),
('guild_platform_engineering','platform_engineering','平台工程公會','維護整合、資料與平台可靠性。','重現並記錄一個可以修正的問題。','opensource'),
('guild_commerce_settlement','commerce_settlement','交易整合與對帳公會','協助商家串接自有收款與對帳。','整理一條付款事件的核對步驟。','retail'),
('guild_ai_vibe','ai_vibe','AI 開發公會','把想法與程式做成可重用開源作品。','貼一個專案與可重現的使用說明。','opensource'),
('guild_ai_field','ai_field','AI 導入與驗證公會','測試、部署、回饋與協助使用者。','實際使用一個作品並留下回饋。','opensource'),
('guild_ai_project','ai_project','AI 專案公會','協調需求、範圍、交付與合作。','把一個需求拆成有完成條件的小步。','engagement');
CREATE TABLE positioning_track_catalog (
  track_key text PRIMARY KEY, name text NOT NULL, description text NOT NULL,
  guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  role_key text NOT NULL CHECK(role_key IN ('supplier','seller','creator','promoter','helper')),
  first_result text NOT NULL, estimated_minutes integer NOT NULL CHECK(estimated_minutes>0),
  catalog_version integer NOT NULL DEFAULT 1
);
INSERT INTO positioning_track_catalog(track_key,name,description,guild_key,role_key,first_result,estimated_minutes) VALUES
('food_supplier','食品供貨者','提供食品、規格與供貨條件。','guild_product_quality_supply','supplier','一件有規格的食品草稿',20),
('craft_supplier','手作與設計商品供貨者','提供手作、設計品與製作條件。','guild_product_quality_supply','supplier','一件手作商品草稿',20),
('manufacturer','製造與加工供應者','整理製造能力、批量與交期。','guild_product_quality_supply','supplier','一份可供規格與交期',30),
('quality_reviewer','商品品質協作者','整理檢驗方法、追溯與品質證據。','guild_product_quality_supply','helper','一份商品檢查清單',20),
('store_operator','網店經營者','選貨、上架並服務買家。','guild_commerce_sales','seller','一個商店草稿',20),
('curated_retailer','選品零售者','為特定客群挑選適合商品。','guild_commerce_sales','seller','一份三件商品的選品提案',30),
('customer_service','電商客服','回答商品問題並協助訂單處理。','guild_commerce_sales','helper','一份商品問答',15),
('community_seller','社群銷售者','向熟悉的社群介紹合適商品。','guild_commerce_sales','seller','一份社群介紹草稿',20),
('content_creator','內容創作者','把知識與產品寫成容易理解的內容。','guild_marketing','promoter','一篇內容草稿',30),
('campaign_planner','行銷活動企劃','規劃對象、訊息與活動成效。','guild_marketing','promoter','一份活動簡報草稿',30),
('affiliate_promoter','推薦推廣者','介紹商品並整理推薦來源。','guild_marketing','promoter','一份推薦內容草稿',15),
('visual_designer','視覺設計者','製作圖像、版面與視覺素材。','guild_marketing','creator','一張視覺作品說明',30),
('video_editor','影片剪輯者','整理素材、剪輯與字幕。','guild_media_automation','creator','一段剪輯規劃',30),
('media_workflow_builder','媒體流程建置者','串接素材、字幕與輸出流程。','guild_media_automation','creator','一份媒體流程圖',30),
('learning_companion','學習陪伴者','協助他人找到可以完成的學習步驟。','guild_talent_direction','helper','一份學習小步計畫',20),
('career_facilitator','方向探索協作者','用提問協助本人確認方向。','guild_talent_direction','helper','一張本人確認的方向卡',20),
('community_host','社群活動主持者','安排交流與促成互助。','guild_member_operations','helper','一份交流活動草稿',20),
('member_support','會員支援協作者','協助新人操作與問題轉介。','guild_member_operations','helper','一則新人操作說明',15),
('partnership_developer','合作開發者','理解外部需求與合作資源。','guild_opportunity_partnership','helper','一張合作需求卡',20),
('integration_engineer','系統整合開發者','把資料、工具與服務串接起來。','guild_platform_engineering','creator','一份整合介面說明',30),
('platform_operator','平台可靠性協作者','維護服務、備份與可觀察性。','guild_platform_engineering','helper','一份服務檢查紀錄',20),
('payment_integrator','收款與對帳整合者','協助商家串接自身帳戶與事件核對。','guild_commerce_settlement','helper','一份對帳流程草稿',30),
('open_source_developer','開源軟體開發者','製作並維護可重用程式。','guild_ai_vibe','creator','一個有 README 的專案介紹',30),
('automation_builder','流程自動化開發者','把重複工作整理成可重用流程。','guild_ai_vibe','creator','一個流程專案說明',30),
('field_implementer','AI 場域導入者','協助測試、安裝與實際應用。','guild_ai_field','helper','一份可重現安裝回饋',30),
('software_tester','軟體測試協作者','重現問題並提供清楚測試證據。','guild_ai_field','helper','一份測試回饋',20),
('project_coordinator','專案協調者','整理範圍、里程碑與交付。','guild_ai_project','helper','一份小型交付計畫',20),
('solution_consultant','方案需求顧問','把客戶問題整理成可討論需求。','guild_ai_project','helper','一張需求與成果卡',20);
CREATE TABLE positioning_profiles (
  profile_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users, aggregate_version bigint NOT NULL CHECK(aggregate_version>0),
  source text NOT NULL DEFAULT 'self_declared' CHECK(source='self_declared'),
  real_world_occupations text[] NOT NULL, background text NOT NULL, strengths text[] NOT NULL,
  goals text NOT NULL, weekly_minutes integer NOT NULL CHECK(weekly_minutes BETWEEN 0 AND 10080),
  desired_roles text[] NOT NULL, selected_tracks text[] NOT NULL,
  supersedes_id uuid REFERENCES positioning_profiles, confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(community_id,user_id,aggregate_version)
);
CREATE INDEX positioning_profiles_member ON positioning_profiles(community_id,user_id,aggregate_version DESC);
CREATE TABLE positioning_profession_memberships (
  membership_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users, guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  rank text NOT NULL DEFAULT 'runner' CHECK(rank='runner'),
  state text NOT NULL CHECK(state IN ('active','left')), aggregate_version bigint NOT NULL DEFAULT 1,
  joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
  UNIQUE(community_id,user_id,guild_key), CHECK(aggregate_version>0)
);
