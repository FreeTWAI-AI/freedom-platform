// Prewritten share introductions per skill book; a dice picks one line when a member shares the book.
import agentKit from './share-introductions/agent-kit.json' with {type:'json'};
import aiSister from './share-introductions/ai-sister.json' with {type:'json'};
import careerGuide from './share-introductions/career-guide.json' with {type:'json'};
import commercialProduction from './share-introductions/commercial-production.json' with {type:'json'};
import communityOps from './share-introductions/community-ops.json' with {type:'json'};
import eventSpace from './share-introductions/event-space.json' with {type:'json'};
import haoStudio from './share-introductions/hao-studio.json' with {type:'json'};
import humanDesign from './share-introductions/human-design.json' with {type:'json'};
import mediaGenerator from './share-introductions/media-generator.json' with {type:'json'};
import multiAiChat from './share-introductions/multi-ai-chat.json' with {type:'json'};
import multiAiDesktop from './share-introductions/multi-ai-desktop.json' with {type:'json'};
import musicMv from './share-introductions/music-mv.json' with {type:'json'};
import partnership from './share-introductions/partnership.json' with {type:'json'};
import posPro from './share-introductions/pos-pro.json' with {type:'json'};
import projectDelivery from './share-introductions/project-delivery.json' with {type:'json'};
import projectTemplate from './share-introductions/project-template.json' with {type:'json'};
import projectionMapping from './share-introductions/projection-mapping.json' with {type:'json'};
import reconciliation from './share-introductions/reconciliation.json' with {type:'json'};
import securityScanner from './share-introductions/security-scanner.json' with {type:'json'};
import shortDrama from './share-introductions/short-drama.json' with {type:'json'};
import socialPost from './share-introductions/social-post.json' with {type:'json'};
import storefront from './share-introductions/storefront.json' with {type:'json'};
import supplierClient from './share-introductions/supplier-client.json' with {type:'json'};
import typoStudio from './share-introductions/typo-studio.json' with {type:'json'};
import videoAutopilot from './share-introductions/video-autopilot.json' with {type:'json'};

export const skillShareContentVersion='2026-09-23.1';
export type SkillShareContent = {introductions:string[];illustration_url:string;illustration_alt:string};

const content:Record<string,{introductions:string[];illustration_alt:string}> = {
  'career-guide':{introductions:careerGuide,illustration_alt:'人物比較不同路徑，選出一項可以開始的小練習。'},
  'community-ops':{introductions:communityOps,illustration_alt:'從迎接新夥伴，到準備活動與圍坐交流的社群流程。'},
  'partnership':{introductions:partnership,illustration_alt:'兩人訪談需求，整理提案並確認一項共同試作。'},
  'reconciliation':{introductions:reconciliation,illustration_alt:'兩份交易紀錄逐筆比對，將差異標記出來等待確認。'},
  'project-delivery':{introductions:projectDelivery,illustration_alt:'大目標拆成任務卡，再經小隊分工完成可驗收成果。'},
  'music-mv':{introductions:musicMv,illustration_alt:'音樂波形對齊分鏡畫面，呈現聲音與 MV 的編排。'},
  'commercial-production':{introductions:commercialProduction,illustration_alt:'商品、攝影機與燈光配置，連到不同尺寸的拍攝成品。'},
  'event-space':{introductions:eventSpace,illustration_alt:'活動場地的報到、座位、舞台與人員動線安排。'},
  'projection-mapping':{introductions:projectionMapping,illustration_alt:'投影機對應建築表面的分區、素材與播放時序。'},
  'human-design':{introductions:humanDesign,illustration_alt:'人物與多種觀點卡片，呈現共讀、討論和自我反思。'},
  'supplier-client':{introductions:supplierClient,illustration_alt:'供應端工作台從資料中心讀取商品與供貨申請。'},
  'storefront':{introductions:storefront,illustration_alt:'商品素材排列成目錄與店面樣稿，呈現在瀏覽器預覽。'},
  'agent-kit':{introductions:agentKit,illustration_alt:'本機工具經由連接器讀取中央資料，再回傳狀態面板的示意圖。'},
  'project-template':{introductions:projectTemplate,illustration_alt:'程式資料夾與模組組成網站，並透過分支協作改進。'},
  'social-post':{introductions:socialPost,illustration_alt:'整理原本的寫作口吻，再準備不同平台的貼文草稿。'},
  'typo-studio':{introductions:typoStudio,illustration_alt:'中文內容整理成多頁輪播版面，再匯出圖片。'},
  'video-autopilot':{introductions:videoAutopilot,illustration_alt:'影片素材經過檢查與時間軸編排，產出橫式及直式預覽。'},
  'short-drama':{introductions:shortDrama,illustration_alt:'角色與故事構想，展開為分集分鏡與時間軸。'},
  'hao-studio':{introductions:haoStudio,illustration_alt:'網站的作品、文章與社群內容，在桌面畫面中並排呈現。'},
  'media-generator':{introductions:mediaGenerator,illustration_alt:'影音點子轉成分鏡畫面，再整理成生成提示文件。'},
  'pos-pro':{introductions:posPro,illustration_alt:'小店收銀、商品庫存、收據與報表的工作流程。'},
  'security-scanner':{introductions:securityScanner,illustration_alt:'檢查指定的網站與程式，將發現整理成有優先順序的報告。'},
  'ai-sister':{introductions:aiSister,illustration_alt:'畫面資料經過辨識、存入記憶，再查回來源卡片的示意圖。'},
  'multi-ai-desktop':{introductions:multiAiDesktop,illustration_alt:'桌面視窗中的多組對話與檢查點，呈現多個 AI 協作。'},
  'multi-ai-chat':{introductions:multiAiChat,illustration_alt:'瀏覽器側欄將問題分送到多個對話，再彙整回答。'},
};

export function getSkillShareContent(bookId:string):SkillShareContent|null {
  if(!Object.hasOwn(content,bookId))return null;
  const entry=content[bookId];
  return {introductions:[...entry.introductions],illustration_url:`/brand/skill-illustrations/${bookId}.webp`,illustration_alt:entry.illustration_alt};
}

export const skillShareContentBookIds:readonly string[]=Object.keys(content);
