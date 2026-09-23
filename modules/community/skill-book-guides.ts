/** Repo-specific reading guides. Reviewed against pinned primary source files, not live-service certification. */
export type SkillBookBeginner = {
  category:'定位與社群'|'供貨與商店'|'作品與開源'|'內容與行銷'|'小隊與協作'|'資訊安全';
  purpose:string; for_whom:string; make:string; workshop_use:string; next_step:string;
};
export type SkillBookGuide = {
  beginner:SkillBookBeginner;
  format:string; summary:string; audience:string[]; status:string; features:string[]; prerequisites:string[];
  first_steps:string[]; first_result:string; contribution:string; contribution_url:string; reading_url:string;
  source_commit:string; reviewed_at:string; source_evidence:{path:string;url:string}[];
  quickstart?:{commands:string;context:string}; website_url?:string;
};
export const skillBookGuides:Record<string,SkillBookGuide> = {
  "career-guide": {
    "format": "實作手冊",
    "summary": "把「不知道自己能做什麼」整理成由本人選定的一個小練習。",
    "audience": [
      "想找方向的新會員",
      "願意陪新人整理目標的夥伴"
    ],
    "status": "入門手冊與成果模板，可手動使用；不是職業診斷或自動媒合服務。",
    "features": [
      "現況與可投入時間訪談",
      "比較兩到三個可嘗試方向",
      "記錄完成條件與回顧日期"
    ],
    "prerequisites": [
      "一位願意討論方向的人，或先替自己整理",
      "可填寫 Markdown 的筆記工具；不需要程式環境"
    ],
    "first_steps": [
      "先寫目前身分、做過的事，以及這週想改變的一件事。",
      "列出兩個可以試的小活動，自己選一個，寫清完成長什麼樣。",
      "把投入時間、需要的協助與回顧日期填進成果模板。"
    ],
    "first_result": "一張本人確認的方向卡，附本週小成果與回顧日期。",
    "contribution": "補充不同職業的匿名訪談例子，或讓成果模板更好填。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-skill-career-guide/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-skill-career-guide/blob/22b1ff3fb3051ff98c330024f7507f5e9da13574/SKILL.md",
    "source_commit": "22b1ff3fb3051ff98c330024f7507f5e9da13574",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-career-guide/blob/22b1ff3fb3051ff98c330024f7507f5e9da13574/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-career-guide/blob/22b1ff3fb3051ff98c330024f7507f5e9da13574/README.md"
      }
    ],
    "beginner": {
      "category": "定位與社群",
      "purpose": "把想做的事，整理成這週能開始的一個小練習。",
      "for_whom": "還在找方向，或想陪新人一起起步的人。",
      "make": "一張方向卡與本週練習計畫。",
      "workshop_use": "完成會員定位後，想進一步整理目標時，可帶到公會找夥伴討論。",
      "next_step": "先挑一件這週想完成的小事，照手冊填一張方向卡。"
    }
  },
  "community-ops": {
    "format": "實作手冊",
    "summary": "把一次新人歡迎或小活動，整理成下一位主持人接得住的流程。",
    "audience": [
      "公會接待者",
      "Discord／LINE 社群志工",
      "活動主持人"
    ],
    "status": "手動接待與活動交接模板；不會自動加好友或發送訊息。",
    "features": [
      "新人需求詢問",
      "活動主題、時間與主持分工",
      "經同意的夥伴介紹與去識別交接"
    ],
    "prerequisites": [
      "選定一場小活動或一次新人接待",
      "取得參與者同意後才介紹私人聯絡方式"
    ],
    "first_steps": [
      "先問新夥伴想參與什麼，再把詢問、適合的入口與接待說法寫成可重用的歡迎流程。",
      "寫一份小活動說明，列明主題、時間、加入方法與主持人。",
      "結束後留下結論與待辦，另做一份未到場者也看得懂的摘要。"
    ],
    "first_result": "一份歡迎流程、一份活動說明與一份可交接摘要。",
    "contribution": "提供實際可用的接待話術與去識別活動回顧。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-skill-community-ops/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-skill-community-ops/blob/716f668a883c2333d4b7d6a8bd79e809d1c740a6/SKILL.md",
    "source_commit": "716f668a883c2333d4b7d6a8bd79e809d1c740a6",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-community-ops/blob/716f668a883c2333d4b7d6a8bd79e809d1c740a6/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-community-ops/blob/716f668a883c2333d4b7d6a8bd79e809d1c740a6/README.md"
      }
    ],
    "beginner": {
      "category": "定位與社群",
      "purpose": "準備一套好上手的新人歡迎與小活動流程。",
      "for_whom": "公會接待夥伴、社群志工與活動主持人。",
      "make": "歡迎話術、活動說明與交接摘要。",
      "workshop_use": "用在公會迎新、讀書會或小隊聚會，讓下一位主持人也能接手。",
      "next_step": "先選一次迎新或一場小活動，寫下參加方式與主持分工。"
    }
  },
  "partnership": {
    "format": "實作手冊",
    "summary": "把聊天裡的模糊商機，收斂成雙方能確認的最小合作提案。",
    "audience": [
      "業務與合作開發者",
      "接案者",
      "要找供應或執行夥伴的人"
    ],
    "status": "訪談與提案手冊；條款與付款仍由合作當事人確認。",
    "features": [
      "找出問題與真正受益者",
      "盤點投入、限制與不包含範圍",
      "安排小試作、交付期限及回饋窗口"
    ],
    "prerequisites": [
      "一個真實需求或可訪談的情境",
      "能代表各自需求的確認窗口"
    ],
    "first_steps": [
      "詢問現在怎麼做、卡在哪，以及改善後會看見什麼差別。",
      "寫出本輪可投入時間、資源和暫不包含的事。",
      "提出一份小試作，請雙方確認交付物、期限與下一步。"
    ],
    "first_result": "一頁合作提案，包含受益者、範圍與雙方確認的下一步。",
    "contribution": "提交匿名需求訪談範例，改善提案的範圍與驗收欄位。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-skill-partnership/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-skill-partnership/blob/7117120a635a0782f170de9448ef85314a16be5d/SKILL.md",
    "source_commit": "7117120a635a0782f170de9448ef85314a16be5d",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-partnership/blob/7117120a635a0782f170de9448ef85314a16be5d/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-partnership/blob/7117120a635a0782f170de9448ef85314a16be5d/README.md"
      }
    ],
    "beginner": {
      "category": "小隊與協作",
      "purpose": "把聊出來的需求，寫成雙方看得懂的小合作。",
      "for_whom": "想找合作夥伴、接案，或釐清客戶需求的人。",
      "make": "一頁有範圍與下一步的合作提案。",
      "workshop_use": "和公會或小隊夥伴討論合作時，先確認要交付什麼、誰負責。",
      "next_step": "用手冊的問題訪談一位需求方，再寫出一個小試作。"
    }
  },
  "reconciliation": {
    "format": "實作手冊",
    "summary": "把商家的訂單與收款紀錄逐筆比對，清楚列出尚未核實的差異。",
    "audience": [
      "商家營運人員",
      "協助對帳的夥伴"
    ],
    "status": "商家自有資料的對帳手冊；不連銀行、不代收款，也不把本人回報當銀行核實。",
    "features": [
      "區分回報、雙方確認與來源核實",
      "核對 reference、金額、幣別和時間",
      "整理重複、缺漏、退款與商家確認"
    ],
    "prerequisites": [
      "商家允許使用的訂單及付款紀錄",
      "私人保存證據的位置；公開模板只放參照"
    ],
    "first_steps": [
      "選三筆虛構訂單，或商家允許使用的紀錄，記下訂單與付款參照。",
      "逐筆核對金額、幣別與時間，缺少來源就保留待核實。",
      "把差異清單交回商家確認，記下更正與尚待處理的項目。"
    ],
    "first_result": "三筆紀錄的對照表與差異清單，逐筆區分本人回報、雙方確認、來源核實及待核實。",
    "contribution": "用虛構交易補充重複付款、退款與幣別差異的範例。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-skill-reconciliation/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-skill-reconciliation/blob/c43eac1fa37418a6b7d7569bddf54e2eb4822815/SKILL.md",
    "source_commit": "c43eac1fa37418a6b7d7569bddf54e2eb4822815",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-reconciliation/blob/c43eac1fa37418a6b7d7569bddf54e2eb4822815/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-reconciliation/blob/c43eac1fa37418a6b7d7569bddf54e2eb4822815/README.md"
      }
    ],
    "beginner": {
      "category": "供貨與商店",
      "purpose": "學會比對訂單與收款紀錄，找出需要確認的差異。",
      "for_whom": "小店營運者與協助整理帳目的人。",
      "make": "三筆紀錄的對照表與差異清單。",
      "workshop_use": "有商家合作時，用自己的資料整理差異，再請當事人核對；不會連銀行。",
      "next_step": "先用三筆範例紀錄練習，標出金額、時間與待確認項目。"
    }
  },
  "project-delivery": {
    "format": "實作手冊",
    "summary": "讓小隊把一個想法拆成能驗收的短迭代，交付後知道下一步怎麼改。",
    "audience": [
      "專案協調者",
      "小隊召集人",
      "使用 Sprint 或 Kanban 的協作者"
    ],
    "status": "專案規劃與回顧模板；不會代人認領責任或保證交付。",
    "features": [
      "目標與具體驗收例子",
      "責任、時間容量與待辦",
      "短迭代交付、使用說明與回顧"
    ],
    "prerequisites": [
      "一個本週可完成的目標",
      "願意認領的小隊成員及驗收者"
    ],
    "first_steps": [
      "用一個使用情境寫出本輪成果和通過的樣子。",
      "拆出少量待辦，由本人認領並確認可投入時間。",
      "交付可操作的成果，請驗收者實際試用，再記下下一輪調整。"
    ],
    "first_result": "一份小隊短迭代板，附實際成果、驗收回饋與下一輪待辦。",
    "contribution": "改善驗收案例與小隊容量範例，讓不同職業都能使用。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-skill-project-delivery/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-skill-project-delivery/blob/ae381bcc77e82b4d646e5c3d7f7b63db2a0c0dd2/SKILL.md",
    "source_commit": "ae381bcc77e82b4d646e5c3d7f7b63db2a0c0dd2",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-project-delivery/blob/ae381bcc77e82b4d646e5c3d7f7b63db2a0c0dd2/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-project-delivery/blob/ae381bcc77e82b4d646e5c3d7f7b63db2a0c0dd2/README.md"
      }
    ],
    "beginner": {
      "category": "小隊與協作",
      "purpose": "把小隊的大想法，拆成這一輪能完成的小成果。",
      "for_whom": "小隊召集人、專案協調者與一起做作品的夥伴。",
      "make": "一份任務板與成果回顧。",
      "workshop_use": "小隊開始合作時，拿來確認分工、驗收方式與下一輪待辦。",
      "next_step": "先選一個小成果，列出完成條件與每個人的可投入時間。"
    }
  },
  "music-mv": {
    "format": "製作手冊",
    "summary": "先完成一段 30–60 秒音樂或 MV 的企劃，讓聲音、畫面與素材來源接得起來。",
    "audience": [
      "音樂創作者",
      "MV 導演與剪輯者",
      "第一次跨聲音和影像合作的人"
    ],
    "status": "提供製作手冊、成果與來源表；實際作曲、錄音、剪輯由你選用的工具完成。",
    "features": [
      "歌曲段落與畫面對照",
      "音軌、分鏡與製作分工",
      "素材來源、輸出規格與具體回饋"
    ],
    "prerequisites": [
      "自己的歌曲構想或已確認可用的片段",
      "能記筆記即可開始；真的製作時再選 DAW 或剪輯工具"
    ],
    "first_steps": [
      "選一段 30–60 秒構想，寫下要給誰聽、想表達的情緒。",
      "把前奏、主歌或副歌對應到畫面，列最少需要的素材。",
      "填來源表與交付規格；有片段就請夥伴回饋，只有企劃則如實標記。"
    ],
    "first_result": "一份歌曲／MV 小企劃、段落分鏡與素材來源表；可選擇附上實作片段。",
    "contribution": "補充原創分鏡、聲畫節奏與不同工具的交付範例。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-skill-music-mv/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-skill-music-mv/blob/c189cbcbde61d2a4b109ba6e72f2ee8882f9ee07/SKILL.md",
    "source_commit": "c189cbcbde61d2a4b109ba6e72f2ee8882f9ee07",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-music-mv/blob/c189cbcbde61d2a4b109ba6e72f2ee8882f9ee07/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-music-mv/blob/c189cbcbde61d2a4b109ba6e72f2ee8882f9ee07/README.md"
      }
    ],
    "beginner": {
      "category": "內容與行銷",
      "purpose": "先規劃一小段音樂或 MV，讓聲音與畫面接得起來。",
      "for_whom": "音樂創作者、剪輯者與第一次跨影音合作的人。",
      "make": "一份音樂或 MV 企劃與素材來源表。",
      "workshop_use": "帶到音樂與 MV 公會找夥伴，先對齊分工，再用各自工具實作。",
      "next_step": "先選 30–60 秒的段落，寫出聲音、畫面與需要的素材。"
    }
  },
  "commercial-production": {
    "format": "製作手冊",
    "summary": "把「商品要拍得漂亮」轉成可確認的 brief、鏡位與各渠道交付規格。",
    "audience": [
      "商品攝影師",
      "廣告影片製作者",
      "品牌窗口與接案小隊"
    ],
    "status": "拍攝企劃與交付模板；不會自動拍片、投放或保證廣告成效。",
    "features": [
      "受眾、渠道與商品重點釐清",
      "鏡位、光線、道具與拍攝安排",
      "粗稿確認、尺寸版本與修改紀錄"
    ],
    "prerequisites": [
      "一件商品與一個要溝通的賣點",
      "能確認商品事實及交付範圍的窗口"
    ],
    "first_steps": [
      "限定一件商品、一個情境與一組輸出，寫清受眾及渠道。",
      "列主視覺、細節與使用情境鏡位，確認商品、道具和負責人。",
      "先交構圖草稿或粗剪，再列正式照片／影片的尺寸、長度與修改項。"
    ],
    "first_result": "一份經確認的商品拍攝 brief、鏡位表與交付版本表。",
    "contribution": "提供去識別的商品 brief、鏡位圖或跨渠道交付案例。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-skill-commercial-production/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-skill-commercial-production/blob/815b0a2f2bff90f9c9624d35a144d8bb70477667/SKILL.md",
    "source_commit": "815b0a2f2bff90f9c9624d35a144d8bb70477667",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-commercial-production/blob/815b0a2f2bff90f9c9624d35a144d8bb70477667/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-skill-commercial-production/blob/815b0a2f2bff90f9c9624d35a144d8bb70477667/README.md"
      }
    ],
    "beginner": {
      "category": "內容與行銷",
      "purpose": "把商品拍攝需求，整理成攝影師和品牌都看得懂的計畫。",
      "for_whom": "商品攝影師、廣告影片小隊與品牌窗口。",
      "make": "一份拍攝說明、鏡位表與交付清單。",
      "workshop_use": "供貨者與影像夥伴合作時，可用同一份拍攝計畫確認重點與修改。",
      "next_step": "先選一件商品，寫清受眾、用途和三個必拍重點。"
    }
  },
  "supplier-client": {
    "format": "讀取客戶端",
    "summary": "把自由工坊裡自己的商品與供貨申請讀回本機，整理成供應端工作工具。",
    "audience": [
      "已刊登商品的供貨者",
      "想改造自己供應端介面的開發者"
    ],
    "status": "可連中央平台讀取自己的資料；刊登、改價與供貨決定仍在網站完成，沒有寫入或付款權限。",
    "features": [
      "一次性代碼核准供應端讀取",
      "商品、供貨申請與連線狀態 JSON",
      "本機私人憑證保存與網站撤銷"
    ],
    "prerequisites": [
      "Node.js 24",
      "自由工坊會員已完成定位，供貨中心已有自己的商品與供貨條件"
    ],
    "first_steps": [
      "先在供貨中心整理商品和供貨條件。",
      "執行 npm run connect，複製終端顯示的代碼；到「我的名片」貼進「客戶端一次性代碼」，核對名稱與供應端讀取範圍後核准。",
      "讀取自己的商品，挑一個欄位整理成私人商品檢視；資料不放公開 GitHub。"
    ],
    "first_result": "一份能讀回自己商品與申請的私人供應端檢視。",
    "contribution": "改善私人商品檢視與錯誤提示；保留中央資料權限與讀取範圍。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-supplier-client/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-supplier-client/blob/6f5f905aa20f89a33dbcf9053421a1dbaf70e97a/README.md",
    "source_commit": "6f5f905aa20f89a33dbcf9053421a1dbaf70e97a",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-supplier-client/blob/6f5f905aa20f89a33dbcf9053421a1dbaf70e97a/README.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/FreeTWAI-AI/freedom-supplier-client/blob/6f5f905aa20f89a33dbcf9053421a1dbaf70e97a/package.json"
      }
    ],
    "quickstart": {
      "commands": "npm ci --ignore-scripts\nnpm test\nnpm run connect\nnpm run read -- products",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "供貨與商店",
      "purpose": "在自己的電腦查看工坊商品與供貨申請。",
      "for_whom": "已在工坊供貨的人，以及協助整理資料的開發者。",
      "make": "一份只讀取自己資料的供貨檢視。",
      "workshop_use": "搭配供貨中心查看自己的商品；刊登、改價與供貨決定仍回網站處理。",
      "next_step": "先讀準備步驟，再由本人核准自己的供應端讀取連線。"
    }
  },
  "storefront": {
    "format": "商店模板與讀取客戶端",
    "summary": "為已選定的商品做本機版面預覽，也能讀取自己一家商店的選品與供貨狀態。",
    "audience": [
      "想開店的銷售者",
      "協助商家製作展示版面的開發者"
    ],
    "status": "已提供四種模板與私人的商店讀取連線；公開買家商店、結帳、訂單與金流尚未實作。",
    "features": [
      "目錄、單品與參考商品 HTML 預覽",
      "一次只核准自己的一家商店",
      "共用平台選品與供貨狀態；服務模板明示尚無預約 API"
    ],
    "prerequisites": [
      "Node.js 24",
      "連真資料前先在平台建立自己的商店；離線範例不需要帳號"
    ],
    "first_steps": [
      "先用虛構 snapshot 產生單品預覽，確認文案與商品資訊排版。",
      "到平台建立商店並選品，再用 connect 代碼核准該商店的讀取。",
      "修改自己的版面；含供貨價格與私人資料的預覽留在本機。"
    ],
    "first_result": "一張可在本機開啟的商店／單品 HTML，清楚標示預覽而非可下單商店。",
    "contribution": "改善模板的易讀性與手機排版；公開結帳需求先在中央平台討論。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-storefront/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-storefront/blob/39aeff383bb4fa58b57dcf9ed3bf7e1023535d3f/README.md",
    "source_commit": "39aeff383bb4fa58b57dcf9ed3bf7e1023535d3f",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-storefront/blob/39aeff383bb4fa58b57dcf9ed3bf7e1023535d3f/README.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/FreeTWAI-AI/freedom-storefront/blob/39aeff383bb4fa58b57dcf9ed3bf7e1023535d3f/package.json"
      }
    ],
    "quickstart": {
      "commands": "npm ci --ignore-scripts\nnpm test\nnpm run build -- --template single-product --input examples/demo-snapshot.json --output dist/product.html --listing-id demo-listing",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "供貨與商店",
      "purpose": "把想賣的商品，排成可以在自己電腦看的商店樣稿。",
      "for_whom": "想練習開店，或替商家設計商品展示頁的人。",
      "make": "一張商店或單品展示頁。",
      "workshop_use": "搭配「開店與銷售」的選品，先討論版面；樣稿目前不能下單或結帳。",
      "next_step": "挑一個商品，先用範例做出展示頁，再換成自己的內容。"
    }
  },
  "agent-kit": {
    "format": "開發接入範例",
    "summary": "用一份共用平台協定示範本機會員查詢，作為 AI 工具接入的開發起點。",
    "audience": [
      "平台整合開發者",
      "想為自己的 AI CLI 增加狀態查詢工具的人"
    ],
    "status": "目前 CLI 只提供本機示範會員查詢；真實 Agent device flow、短效授權和 MCP server 仍待實作。",
    "features": [
      "固定版本的平台 DTO 與共用 client",
      "本機 demo 查詢完成後登出",
      "協定來源與摘要核對工具"
    ],
    "prerequisites": [
      "Node.js 24",
      "要執行狀態查詢需另有本機 Freedom Platform 示範服務"
    ],
    "first_steps": [
      "先讀 README，分清現有 demo 查詢與尚未提供的正式代理授權。",
      "在副本跑測試，查看 CLI 如何呼叫共用 client。",
      "挑一項純讀取摘要改善輸出，不在工具內另建會員或任務真相。"
    ],
    "first_result": "一個通過測試的本機狀態摘要小改動，附輸入、輸出與限制。",
    "contribution": "補充不同 CLI 的讀取範例、錯誤處理或正式授權需求。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-agent-kit/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-agent-kit/blob/df41da159920fb520d962402f2a98dcc9d36c5d1/README.md",
    "source_commit": "df41da159920fb520d962402f2a98dcc9d36c5d1",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-agent-kit/blob/df41da159920fb520d962402f2a98dcc9d36c5d1/README.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/FreeTWAI-AI/freedom-agent-kit/blob/df41da159920fb520d962402f2a98dcc9d36c5d1/package.json"
      }
    ],
    "quickstart": {
      "commands": "npm ci\nnpm test",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "作品與開源",
      "purpose": "用現成範例，練習讓 AI 工具讀取平台狀態。",
      "for_whom": "想研究工坊工具串接、能操作程式環境的人。",
      "make": "一個能跑測試的本機查詢小改動。",
      "workshop_use": "適合平台工程與 AI 公會研究工具接入；目前先用本機示範練習。",
      "next_step": "照準備步驟啟動本機範例，先看懂一次查詢的輸入與輸出。"
    }
  },
  "project-template": {
    "format": "Node.js 專案起始包",
    "summary": "從會跑的本機頁面、測試和介紹文件，開始你的獨立開源專案。",
    "audience": [
      "第一次發布作品的會員",
      "想快速開新專案的小隊"
    ],
    "status": "Node 24 範本含測試、本機預覽與平台協定；不含雲端部署、公開註冊或付款。",
    "features": [
      "本機 loopback 預覽",
      "可重建的 server 產物",
      "專案身分初始化、GitHub 任務與 PR 協作說明"
    ],
    "prerequisites": [
      "Node.js 24.x",
      "建立自己的 GitHub 專案或 Fork，能在自己的電腦開啟預覽"
    ],
    "first_steps": [
      "在副本跑測試與 build，再啟動本機預覽。",
      "按照初始化清單改專案名稱及自己的 repository 身分。",
      "選一個小功能，用 Issue 說明目標，再提出有測試的 PR。"
    ],
    "first_result": "一個能在自己電腦開啟、帶測試與用途說明的新專案。",
    "contribution": "改善新手初始化步驟、範例測試或首次 PR 的指引。",
    "contribution_url": "https://github.com/FreeTWAI-AI/freedom-project-template/issues",
    "reading_url": "https://github.com/FreeTWAI-AI/freedom-project-template/blob/0f58bd087a38e9a1dec98b7038ad9840d20f2cdc/README.md",
    "source_commit": "0f58bd087a38e9a1dec98b7038ad9840d20f2cdc",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-project-template/blob/0f58bd087a38e9a1dec98b7038ad9840d20f2cdc/README.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/FreeTWAI-AI/freedom-project-template/blob/0f58bd087a38e9a1dec98b7038ad9840d20f2cdc/package.json"
      },
      {
        "path": "docs/initialize-project.md",
        "url": "https://github.com/FreeTWAI-AI/freedom-project-template/blob/0f58bd087a38e9a1dec98b7038ad9840d20f2cdc/docs/initialize-project.md"
      }
    ],
    "quickstart": {
      "commands": "npm test\nnpm run build\nnpm run dev",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "作品與開源",
      "purpose": "從能開啟的範例頁面，開始自己的第一個開源作品。",
      "for_whom": "想做第一個程式作品的會員或小隊。",
      "make": "一個有用途說明與測試的新專案。",
      "workshop_use": "在作品共創中練習修改、提出任務與送出修改審查。",
      "next_step": "先把範例在自己電腦打開，再改成你的作品名稱與用途。"
    }
  },
  "social-post": {
    "format": "社群內容 Skill",
    "summary": "把自己的口吻與內容方向整理給 AI，產出可以逐篇確認的社群貼文。",
    "audience": [
      "社群小編",
      "個人品牌創作者",
      "行銷公會夥伴"
    ],
    "status": "收錄版本含內容規劃、聲線學習與貼文草稿；三平台真實自動回覆仍未全面驗收，不能當作全自動代管。",
    "features": [
      "以授權樣本建立本機聲線",
      "內容計畫、分平台草稿與成效分析",
      "另有精簡 ChatGPT Chat 版；私人樣本留本機"
    ],
    "prerequisites": [
      "Codex、Claude Code 或閱讀精簡規則的 ChatGPT 使用者",
      "自己的公開或已授權貼文樣本；需要發文才另外設定帳號與確認"
    ],
    "first_steps": [
      "閱讀 social-post/SKILL.md，先用自己的方向填聲線與內容 brief。",
      "選一個主題，請 AI 產出一篇符合自己口吻的草稿。",
      "自己核對事實與語氣，保留修改紀錄；第一輪可以只完成草稿。"
    ],
    "first_result": "一份自己的聲線簡卡與一篇經本人修訂的貼文草稿。",
    "contribution": "提供匿名可重現案例、平台改版問題或內容品質回歸測試。",
    "contribution_url": "https://github.com/FreeTWAI-AI/claude-skill-social-post/issues",
    "reading_url": "https://github.com/Hao0321/claude-skill-social-post/blob/c2641ba5ac7d7f722f1cef54b03fbfe553502c7b/social-post/SKILL.md",
    "source_commit": "c2641ba5ac7d7f722f1cef54b03fbfe553502c7b",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "social-post/SKILL.md",
        "url": "https://github.com/Hao0321/claude-skill-social-post/blob/c2641ba5ac7d7f722f1cef54b03fbfe553502c7b/social-post/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/Hao0321/claude-skill-social-post/blob/c2641ba5ac7d7f722f1cef54b03fbfe553502c7b/README.md"
      }
    ],
    "beginner": {
      "category": "內容與行銷",
      "purpose": "讓 AI 先認識你的口吻，再一起寫社群貼文。",
      "for_whom": "社群小編、個人品牌創作者與行銷夥伴。",
      "make": "自己的口吻簡卡與一篇貼文草稿。",
      "workshop_use": "為商品、作品或公會活動寫介紹，內容由本人確認後再發布。",
      "next_step": "選幾篇你有權使用的文字，先整理口吻，再改好第一篇草稿。"
    }
  },
  "typo-studio": {
    "format": "排版工具",
    "summary": "把中文內容做成能匯出的 IG 輪播圖，減少字級、斷行與對比的反覆調整。",
    "audience": [
      "社群設計者",
      "知識型內容創作者",
      "需要商品輪播圖的小店"
    ],
    "status": "收錄 v2.2.0，提供瀏覽器／PWA 與 Electron 桌面版；字型首次使用可能需要連網。",
    "features": [
      "中文避頭尾與自動字級",
      "多頁輪播、比例與背景圖",
      "單頁圖片、整組 ZIP 與專案 JSON 匯出"
    ],
    "prerequisites": [
      "瀏覽器即可使用作者網頁版",
      "一段自己的文字與可使用的圖片；改程式需 Node.js／npm"
    ],
    "first_steps": [
      "開啟作者網頁版，選一組五頁輪播結構。",
      "填自己的封面、三頁重點與結尾，檢查文字可讀性。",
      "匯出圖片及專案 JSON，請夥伴看一遍再決定是否發布。"
    ],
    "first_result": "一組五頁輪播圖與可繼續編輯的專案檔。",
    "contribution": "回報可重現的中文排版案例，或改善 vendor/app.jsx 的編輯體驗。",
    "contribution_url": "https://github.com/FreeTWAI-AI/typo-studio/issues",
    "reading_url": "https://github.com/Hao0321/typo-studio/blob/9d60be439d150af74a79dbcc5a7547c6108c726f/README.md",
    "source_commit": "9d60be439d150af74a79dbcc5a7547c6108c726f",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/Hao0321/typo-studio/blob/9d60be439d150af74a79dbcc5a7547c6108c726f/README.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/Hao0321/typo-studio/blob/9d60be439d150af74a79dbcc5a7547c6108c726f/package.json"
      },
      {
        "path": "TUTORIAL.md",
        "url": "https://github.com/Hao0321/typo-studio/blob/9d60be439d150af74a79dbcc5a7547c6108c726f/TUTORIAL.md"
      }
    ],
    "quickstart": {
      "commands": "npm install\nnpm start",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "website_url": "https://hao0321.github.io/typo-studio/",
    "beginner": {
      "category": "內容與行銷",
      "purpose": "把一段中文內容，排成清楚好讀的社群輪播圖。",
      "for_whom": "想做知識圖卡、商品介紹或社群設計的人。",
      "make": "五頁輪播圖與可再編輯的專案檔。",
      "workshop_use": "把商品重點、公會活動或作品教學整理成能分享的圖卡。",
      "next_step": "先準備五個重點，套入一組輪播，再調整字級與斷行。"
    }
  },
  "video-autopilot": {
    "format": "剪輯工具與方法框架",
    "summary": "用可重現的素材檢查與剪輯流程，把頻道方法整理成自己的工具包。",
    "audience": [
      "短影音剪輯者",
      "頻道營運者",
      "想改善剪輯工具的開發者"
    ],
    "status": "收錄 v0.23.0；完整剪輯走 Editkin v4，另有無真素材範例。實際頻道設定、素材與執行環境需自行準備。",
    "features": [
      "長片、Shorts 與 Reels 的規劃和品質檢查",
      "ffmpeg 素材處理及濾鏡工具",
      "可重跑範例與逐步剪輯流程"
    ],
    "prerequisites": [
      "入門範例使用 Python 3.9+，示範 04 不需要額外套件或 ffmpeg",
      "真正渲染影片時另需 ffmpeg／ffprobe 及對應媒體相依"
    ],
    "first_steps": [
      "先跑不需要影片素材的 Shorts 規則範例，看看不合格與修正後的差別。",
      "只改一個門檻，記錄判定為何改變。",
      "再依 SETUP.md 填自己的頻道資料，挑一段素材進入後續剪輯練習。"
    ],
    "first_result": "一份可重跑的 Shorts 判定結果與你修改門檻的說明。",
    "contribution": "參與自由工坊的影片共創任務，補可重現素材、測試或剪輯說明。",
    "contribution_url": "https://github.com/FreeTWAI-AI/video-autopilot-kit/issues",
    "reading_url": "https://github.com/Hao0321/video-autopilot-kit/blob/74041fcb292788f4c24e3d06f39fe2c9dee7a8cb/README.md",
    "source_commit": "74041fcb292788f4c24e3d06f39fe2c9dee7a8cb",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/Hao0321/video-autopilot-kit/blob/74041fcb292788f4c24e3d06f39fe2c9dee7a8cb/README.md"
      },
      {
        "path": "examples/README.md",
        "url": "https://github.com/Hao0321/video-autopilot-kit/blob/74041fcb292788f4c24e3d06f39fe2c9dee7a8cb/examples/README.md"
      },
      {
        "path": "examples/04_shorts_gate.py",
        "url": "https://github.com/Hao0321/video-autopilot-kit/blob/74041fcb292788f4c24e3d06f39fe2c9dee7a8cb/examples/04_shorts_gate.py"
      }
    ],
    "quickstart": {
      "commands": "python examples/04_shorts_gate.py",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "內容與行銷",
      "purpose": "把影片素材的檢查與剪輯步驟，整理成可重跑的流程。",
      "for_whom": "會剪短影音、經營頻道或想改造剪輯工具的人。",
      "make": "一份短影音判定結果與調整紀錄。",
      "workshop_use": "影音公會或小隊可用來比較剪輯規則，再逐步套用到自己的素材。",
      "next_step": "先跑不需真素材的範例，理解規則後再準備自己的影片。"
    }
  },
  "short-drama": {
    "format": "短劇策劃 Skill",
    "summary": "把一句短劇點子展開成角色設定、單集轉折與可交接的製作包。",
    "audience": [
      "編劇",
      "AI 短劇創作者",
      "影片企劃與剪輯小隊"
    ],
    "status": "核心處理故事、連載狀態與製作包驗證；產生媒體和組成影片需要另外的生成／剪輯工具。",
    "features": [
      "角色與世界設定",
      "單集回報、轉折與追更鉤子",
      "逐鏡時間線、角色一致性與製作包檢查"
    ],
    "prerequisites": [
      "支援 Skills 的 AI 客戶端",
      "原創故事點子；要跑附帶驗證需 Python"
    ],
    "first_steps": [
      "先讀 SKILL.md，寫一句主角、目標與代價都清楚的故事點子。",
      "讓工具規劃三集試播，每集明確發生一個轉變。",
      "先用附帶的示範計畫確認驗證工具可用；自己的鏡頭計畫也要依格式檢查，通過前保留草稿標記。"
    ],
    "first_result": "三集試播概要、角色設定與鏡頭計畫草稿；自己的製作包通過檢查後再交接。",
    "contribution": "補敘事一致性的失敗例、示範計畫或製作包驗證案例。",
    "contribution_url": "https://github.com/FreeTWAI-AI/ai-short-drama/issues",
    "reading_url": "https://github.com/Hao0321/ai-short-drama/blob/a1a00d3949fedd74edb6830a79d189a2c76920db/SKILL.md",
    "source_commit": "a1a00d3949fedd74edb6830a79d189a2c76920db",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/Hao0321/ai-short-drama/blob/a1a00d3949fedd74edb6830a79d189a2c76920db/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/Hao0321/ai-short-drama/blob/a1a00d3949fedd74edb6830a79d189a2c76920db/README.md"
      }
    ],
    "quickstart": {
      "commands": "python scripts/studio_lint.py examples/studio-plan.example.json --studio-ready",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "內容與行銷",
      "purpose": "把一個短劇點子，整理成角色、分集與鏡頭計畫。",
      "for_whom": "編劇、短劇創作者與影片企劃小隊。",
      "make": "三集試播概要與製作計畫草稿。",
      "workshop_use": "先和影音公會夥伴確認故事，再交給各自選用的生成或剪輯工具製作。",
      "next_step": "先寫一句故事點子與主角目標，照步驟展開三集概要。"
    }
  },
  "hao-studio": {
    "format": "網站實作參考",
    "summary": "研究 Hao 如何把作品、文章、遊戲與社群入口放在同一個品牌網站。",
    "audience": [
      "作品集設計者",
      "品牌網站開發者",
      "想研究遊戲與社群網站的人"
    ],
    "status": "收錄的是實際靜態網站及獨立遊戲 API 程式，沒有根目錄 README；不是已接自由工坊的會員或影片平台。",
    "features": [
      "首頁、作品案例與文章頁",
      "自由工坊社群頁與瀏覽器遊戲",
      "另有 Cloudflare Worker／D1 遊戲後端"
    ],
    "prerequisites": [
      "先用瀏覽器看作者網站即可",
      "改作前釐清頁面、素材及未明確宣告的授權；不沿用作者帳號與後端設定"
    ],
    "first_steps": [
      "先看首頁與一個案例頁，畫出內容層級與導覽。",
      "挑一個值得學習的互動或作品卡，記下它解決什麼問題。",
      "用自己的文字和素材做獨立小版面；接遊戲 API 前另外檢查其部署需求。"
    ],
    "first_result": "一張網站內容地圖與使用自己素材製作的單頁練習。",
    "contribution": "針對可重現的版面、導覽或無障礙問題提出 Issue；先討論再改原站。",
    "contribution_url": "https://github.com/FreeTWAI-AI/Hao0321-Studio-WEB/issues",
    "reading_url": "https://github.com/Hao0321/Hao0321-Studio-WEB/blob/40766413d3263e80d573e7c7928e1816c9f441e0/index.html",
    "source_commit": "40766413d3263e80d573e7c7928e1816c9f441e0",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "index.html",
        "url": "https://github.com/Hao0321/Hao0321-Studio-WEB/blob/40766413d3263e80d573e7c7928e1816c9f441e0/index.html"
      },
      {
        "path": "game-api/README.md",
        "url": "https://github.com/Hao0321/Hao0321-Studio-WEB/blob/40766413d3263e80d573e7c7928e1816c9f441e0/game-api/README.md"
      }
    ],
    "website_url": "https://hao0321.com/",
    "beginner": {
      "category": "作品與開源",
      "purpose": "從真實網站學習怎麼介紹作品、文章與社群。",
      "for_whom": "想做個人作品集、品牌頁或研究網站的人。",
      "make": "一張內容地圖與自己的單頁練習。",
      "workshop_use": "可作為介紹工坊作品的版面參考；練習頁請使用自己的素材。",
      "next_step": "先看首頁怎麼分類內容，畫一張地圖，再做自己的小頁面。"
    }
  },
  "media-generator": {
    "format": "影音提示與生成 Skill",
    "summary": "把影像或音樂構想整理成分鏡與適合目標平台的提示，而不是只堆「電影感」形容詞。",
    "audience": [
      "AI 影像創作者",
      "影片企劃",
      "要產出商品素材的行銷者"
    ],
    "status": "提供提示參考、分鏡模板與部分平台瀏覽器流程；平台功能、登入、額度及付費需在使用時確認。",
    "features": [
      "鏡頭、光線、聲音與風格描述",
      "依生成平台調整提示",
      "多鏡頭連貫性、分鏡與音樂影片模板"
    ],
    "prerequisites": [
      "支援 Skills 的 AI 客戶端",
      "生成素材需自己可用的服務帳號；瀏覽器自動操作另需相容工具"
    ],
    "first_steps": [
      "先只做提示：寫清主體、動作、場景、光線與預期長度。",
      "對照目標平台的參考頁，整理一份分鏡及限制條件。",
      "自己確認後再選擇是否生成，留下提示、平台與輸出差異。"
    ],
    "first_result": "一份含三個鏡頭的生成 brief；可附一次實際生成與修訂比較。",
    "contribution": "補平台變動證據、實測提示案例或尚未完善的操作頁。",
    "contribution_url": "https://github.com/FreeTWAI-AI/ai-media-generator/issues",
    "reading_url": "https://github.com/Hao0321/ai-media-generator/blob/edc8aa5227f4a58f9a3a88c7bf3e99bdda2a4361/SKILL.md",
    "source_commit": "edc8aa5227f4a58f9a3a88c7bf3e99bdda2a4361",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "SKILL.md",
        "url": "https://github.com/Hao0321/ai-media-generator/blob/edc8aa5227f4a58f9a3a88c7bf3e99bdda2a4361/SKILL.md"
      },
      {
        "path": "README.md",
        "url": "https://github.com/Hao0321/ai-media-generator/blob/edc8aa5227f4a58f9a3a88c7bf3e99bdda2a4361/README.md"
      }
    ],
    "beginner": {
      "category": "內容與行銷",
      "purpose": "把模糊的影音想法，寫成清楚的分鏡與生成提示。",
      "for_whom": "想用 AI 做商品素材、影片或音樂企劃的人。",
      "make": "一份三個鏡頭的生成說明。",
      "workshop_use": "和行銷、影音公會討論同一份分鏡，再選擇工具實際生成。",
      "next_step": "先決定一個主題，寫出三個鏡頭的畫面、聲音與風格。"
    }
  },
  "pos-pro": {
    "format": "離線零售 POS",
    "summary": "在自己的裝置練習收銀、庫存與報表，理解一間小店的營運資料怎麼流動。",
    "audience": [
      "小型零售店主",
      "門市營運人員",
      "零售工具開發者"
    ],
    "status": "收錄 v2.5.0，桌面 SQLite／瀏覽器 localStorage；Supabase 同步是選配，尚未自動連自由工坊商品與帳務。",
    "features": [
      "收銀、退貨與庫存變動",
      "會員、點數、儲值與進貨",
      "複式記帳與營運報表"
    ],
    "prerequisites": [
      "先用測試資料試用；首次登入修改預設員工密碼",
      "自行啟動需 Node.js／npm；公開同步需另行檢查資料權限"
    ],
    "first_steps": [
      "用三個虛構商品建立庫存，完成一筆測試銷售。",
      "再退回其中一項，檢查庫存、付款與報表是否一致。",
      "記下適合自己店裡的流程；連真資料或雲端同步前先完成帳號與權限設定。"
    ],
    "first_result": "一份測試銷售與退款的操作紀錄，能說明庫存與帳務的對應。",
    "contribution": "提供去識別的門市流程案例，改善測試、收銀體驗或資料權限。",
    "contribution_url": "https://github.com/FreeTWAI-AI/pos-pro/issues",
    "reading_url": "https://github.com/Hao0321/pos-pro/blob/2656945463e95d155fffca19de18014f5f0d75db/README.md",
    "source_commit": "2656945463e95d155fffca19de18014f5f0d75db",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/Hao0321/pos-pro/blob/2656945463e95d155fffca19de18014f5f0d75db/README.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/Hao0321/pos-pro/blob/2656945463e95d155fffca19de18014f5f0d75db/package.json"
      }
    ],
    "quickstart": {
      "commands": "npm install\nnpm run dev",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "供貨與商店",
      "purpose": "在自己的裝置，練習小店收銀、庫存與報表。",
      "for_whom": "小店店主、門市夥伴與零售工具開發者。",
      "make": "一份測試銷售、退款與庫存紀錄。",
      "workshop_use": "可在銷售或對帳公會討論門市流程；不會自動同步工坊商品或帳務。",
      "next_step": "先建測試商品，練習一筆銷售與退款，再核對庫存變化。"
    }
  },
  "security-scanner": {
    "format": "安全檢查桌面工具",
    "summary": "把自己的程式碼、網站或內部系統檢查結果整理成一份有優先順序的報告。",
    "audience": [
      "維護自有網站或程式的開發者",
      "資訊安全公會夥伴",
      "協助企業盤點系統的人"
    ],
    "status": "收錄版本已有桌面與 Agent Skill 流程；三平台候選安裝檔仍標 HOLD，先依來源區分已發布版本與自行建置。",
    "features": [
      "針對資產選擇適用上游掃描器",
      "保留完成、失敗與未執行的檢查狀態",
      "依優先序閱讀問題、比較掃描並匯出 HTML"
    ],
    "prerequisites": [
      "只選自己管理或明確獲准的目標",
      "從原始碼開發需 Node.js 24+、Rust 1.98 與 Tauri 平台相依"
    ],
    "first_steps": [
      "在自己的原始碼副本開啟 Codex 或 Claude Code，依 README 的 Agent Skill 入口要求建置，並選自己有權檢查的測試專案。",
      "確認範圍後執行適用檢查，分開查看有結果與未執行的項目。",
      "保存 HTML 報告，挑一個問題修正後再核對結果。"
    ],
    "first_result": "一份可重開的 HTML 安全報告；有待修問題時，再附一項修正前後比較。",
    "contribution": "提交去識別的重現步驟、輸出解析或報告體驗問題；敏感發現依來源安全政策處理。",
    "contribution_url": "https://github.com/FreeTWAI-AI/ai-security-scanner/issues",
    "reading_url": "https://github.com/teddashh/ai-security-scanner/blob/9fae58fbf0e78f25fad5b1e9f70104ac5ab73153/README.zh-TW.md",
    "source_commit": "9fae58fbf0e78f25fad5b1e9f70104ac5ab73153",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.zh-TW.md",
        "url": "https://github.com/teddashh/ai-security-scanner/blob/9fae58fbf0e78f25fad5b1e9f70104ac5ab73153/README.zh-TW.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/teddashh/ai-security-scanner/blob/9fae58fbf0e78f25fad5b1e9f70104ac5ab73153/package.json"
      }
    ],
    "beginner": {
      "category": "資訊安全",
      "purpose": "檢查自己的網站或程式，找出應優先處理的安全問題。",
      "for_whom": "維護自有系統的開發者與資安公會夥伴。",
      "make": "一份能重開的安全報告。",
      "workshop_use": "拿自己的或已獲授權的測試專案練習，再和夥伴討論修正順序。",
      "next_step": "先讀支援範圍與安裝狀態，挑一個已獲授權的小專案開始。"
    }
  },
  "ai-sister": {
    "format": "本機記憶桌面助理",
    "summary": "練習把看到過的資訊存成本機記憶，查詢時能回到答案的畫面來源。",
    "audience": [
      "想研究個人知識工具的會員",
      "桌面助理開發者",
      "關心可追溯回答與本機隱私的人"
    ],
    "status": "收錄 alpha.143，已有記錄、OCR、記憶與可點出處的問答；各作業系統支援與發布狀態不同。",
    "features": [
      "本機螢幕紀錄與 OCR",
      "帶來源的記憶檢索",
      "選定 CLI 的文字理解；另有明確同意與暫停機制"
    ],
    "prerequisites": [
      "入門重播範例需 Rust 1.88+",
      "範例不讀螢幕；真實記錄需另外設定同意、排除與暫停"
    ],
    "first_steps": [
      "先編譯 CLI，使用 repo 的帳單情境重播，暫不開啟自己的螢幕記錄。",
      "查詢「電話」，點對答案與來源，理解資料如何被找回。",
      "記下一個找不到或需要改善的案例，再決定是否試用桌面記錄。"
    ],
    "first_result": "一份範例查詢結果與來源核對筆記；不需要上傳私人螢幕資料。",
    "contribution": "補匿名可重播的查詢案例、來源呈現或暫停狀態測試。",
    "contribution_url": "https://github.com/FreeTWAI-AI/AI-Sister/issues",
    "reading_url": "https://github.com/teddashh/AI-Sister/blob/02100bf2e83d3a77bce5dc14c256f4dd4bb5e270/README.md",
    "source_commit": "02100bf2e83d3a77bce5dc14c256f4dd4bb5e270",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.md",
        "url": "https://github.com/teddashh/AI-Sister/blob/02100bf2e83d3a77bce5dc14c256f4dd4bb5e270/README.md"
      },
      {
        "path": "Cargo.toml",
        "url": "https://github.com/teddashh/AI-Sister/blob/02100bf2e83d3a77bce5dc14c256f4dd4bb5e270/Cargo.toml"
      }
    ],
    "quickstart": {
      "commands": "cargo build --release -p sister-cli --locked\n./target/release/sister --data-dir ./data replay scenarios/bill-lookup.json\n./target/release/sister --data-dir ./data query 電話",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "website_url": "https://teddashh.github.io/AI-Sister/",
    "beginner": {
      "category": "作品與開源",
      "purpose": "研究怎麼把看過的資訊存成記憶，回答時找回來源。",
      "for_whom": "想研究個人知識工具或桌面助理的人。",
      "make": "一份範例問答與來源核對筆記。",
      "workshop_use": "AI 公會可用範例資料討論記憶與搜尋，先不用私人螢幕內容。",
      "next_step": "先讀支援平台與隱私說明，再用範例核對一次答案的出處。"
    }
  },
  "multi-ai-desktop": {
    "format": "多 AI 桌面工作台",
    "summary": "在獨立桌面視窗安排多個 AI 輪流提案、審查與收斂，而不是反覆手動貼同一段問題。",
    "audience": [
      "多模型協作使用者",
      "需要桌面工作流程的小隊",
      "Tauri 與瀏覽器整合開發者"
    ],
    "status": "收錄 v1.9.5，核心功能已凍結維護；Meta AI 為實驗備用，各平台實機驗證程度不同。",
    "features": [
      "多種協作與辯證工作流",
      "各提供者獨立登入視窗",
      "對話快照、重播與檢查點"
    ],
    "prerequisites": [
      "可用的 AI 服務帳號與自己的圖形桌面",
      "原始碼需 Node ^22.13 或 >=24、pnpm、Rust 與 Tauri 相依"
    ],
    "first_steps": [
      "由來源網站選適合系統的版本，逐一登入自己要使用的 AI。",
      "選一個不含私密資料的小問題，讓兩方先各提方案，再安排審查。",
      "比較單一回答與最後收斂結果，記下工作流適合和不適合的地方。"
    ],
    "first_result": "一份多 AI 協作結果，附你採納與未採納的判斷。",
    "contribution": "在既有維護範圍內提供可重現的 provider 改版、登入或回覆擷取問題。",
    "contribution_url": "https://github.com/FreeTWAI-AI/multi-ai-chat-desktop/issues",
    "reading_url": "https://github.com/teddashh/multi-ai-chat-desktop/blob/dd22b21178212cd9b717aafd9cca82d25b85f681/README.zh-TW.md",
    "source_commit": "dd22b21178212cd9b717aafd9cca82d25b85f681",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.zh-TW.md",
        "url": "https://github.com/teddashh/multi-ai-chat-desktop/blob/dd22b21178212cd9b717aafd9cca82d25b85f681/README.zh-TW.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/teddashh/multi-ai-chat-desktop/blob/dd22b21178212cd9b717aafd9cca82d25b85f681/package.json"
      }
    ],
    "beginner": {
      "category": "小隊與協作",
      "purpose": "在桌面視窗，安排多個 AI 輪流提案與檢查。",
      "for_whom": "常用多種 AI、想整理協作流程的人。",
      "make": "一份多 AI 討論結果與自己的判斷。",
      "workshop_use": "小隊可用公開題目比較提案，再由夥伴決定採用什麼。",
      "next_step": "選一個不含機密的小問題，先跑一輪提案與審查。"
    }
  },
  "multi-ai-chat": {
    "format": "Chrome 側欄外掛",
    "summary": "用瀏覽器側欄協調已登入的 AI 分頁，快速比較回答或跑一輪交叉審查。",
    "audience": [
      "慣用 Chrome 的 AI 使用者",
      "想減少多分頁複製貼上的人",
      "瀏覽器外掛開發者"
    ],
    "status": "收錄 GitHub v0.3.0；來源記錄 Chrome 商店仍為 v0.2.3。GitHub 的實驗 Meta 備用功能不等於商店版已有。",
    "features": [
      "自由分送、多方諮詢與辯證",
      "保存在本機的對話與後續追問",
      "可選的 HackMD 發布，由使用者明確操作"
    ],
    "prerequisites": [
      "Chrome 114+ 與可登入的 AI 服務帳號",
      "原始碼建置需 Node.js 22.18+、npm 及 Git"
    ],
    "first_steps": [
      "本練習以 GitHub v0.3.0 為準：依來源下載 ZIP，或建置後在 chrome://extensions 載入 dist/，再開啟側欄並登入需要的 AI。",
      "用一個小問題做自由分送，保留兩個回答的差異。",
      "再試多方諮詢，整理自己最後採用的結論。"
    ],
    "first_result": "一份跨 AI 的回答比較與人工選擇理由。",
    "contribution": "提供瀏覽器與 provider 版本、去識別重現步驟，改善連線與回覆可靠性。",
    "contribution_url": "https://github.com/FreeTWAI-AI/multi-ai-chat/issues",
    "reading_url": "https://github.com/teddashh/multi-ai-chat/blob/cd96e66de6c0a5b2ff6b5f95e09963c66cd0bf7f/README.zh-TW.md",
    "source_commit": "cd96e66de6c0a5b2ff6b5f95e09963c66cd0bf7f",
    "reviewed_at": "2026-09-23",
    "source_evidence": [
      {
        "path": "README.zh-TW.md",
        "url": "https://github.com/teddashh/multi-ai-chat/blob/cd96e66de6c0a5b2ff6b5f95e09963c66cd0bf7f/README.zh-TW.md"
      },
      {
        "path": "package.json",
        "url": "https://github.com/teddashh/multi-ai-chat/blob/cd96e66de6c0a5b2ff6b5f95e09963c66cd0bf7f/package.json"
      }
    ],
    "quickstart": {
      "commands": "npm ci\nnpm run verify",
      "context": "在自己的專案副本根目錄執行；指令已對照收錄版本的說明，這次介紹核對沒有代為安裝或執行。"
    },
    "beginner": {
      "category": "小隊與協作",
      "purpose": "在瀏覽器側欄，比較多個 AI 的回答。",
      "for_whom": "慣用 Chrome、常在多個 AI 分頁之間切換的人。",
      "make": "一份回答比較與採用理由。",
      "workshop_use": "用在作品討論或小隊腦力激盪，整理不同意見後再一起決定。",
      "next_step": "先看安裝方式，選一個公開問題，送到已登入的 AI 分頁比較。"
    }
  }
};
