import {digest} from '../../packages/db/index.js';
import {Problem} from '../../packages/shared/problem.js';

/** Question copy version. A wording change bumps this and every guild hash. */
export const GUILD_ENTRY_QUESTIONS_VERSION='guild-entry-v1';
export const GUILD_ANSWERS_INVALID='請回答這個公會的每一題，並使用題目提供的選項。';

export type GuildQuestionOption={id:string;label:string};
export type GuildQuestion={id:string;prompt:string;options:GuildQuestionOption[]};
export type GuildQuestionSet={version:string;sha256:string;questions:GuildQuestion[]};
export type StoredGuildAnswer={question_id:string;prompt:string;option_id:string;label:string};
export type GuildAnswerRow={question_set_version:string;question_set_sha256:string;answers:Record<string,string>;aggregate_version:string|number;updated_at:Date|string};

const question=(id:string,prompt:string,options:[string,string][]):GuildQuestion=>({id,prompt,options:options.map(([optionId,label])=>({id:optionId,label}))});
const familiarity=(prompt:string,options:[string,string][])=>question('familiarity',prompt,options);
const intent=(options:[string,string][])=>question('intent','你想先在這個公會做什麼？',options);
const weekly=question('weekly_time','每週大概能投入多少時間？',[
  ['weekly_under_1','一週不到 1 小時'],['weekly_1_3','大約 1-3 小時'],['weekly_4_8','大約 4-8 小時'],['weekly_over_8','8 小時以上'],
]);
const participation=question('participation','你比較想怎麼參與？',[
  ['part_read','先讀技能書'],['part_follow','跟著別人做'],['part_share','分享做過的事'],['part_help','幫新手起步'],['part_watch','先看看再決定'],
]);
// Every option is a valid way to begin. These are not skill tests or credentials.
const builtIn:Record<string,GuildQuestion[]>={
  guild_talent_direction:[familiarity('你對探索方向有多熟？',[['talent_familiar_new','還沒想過方向'],['talent_familiar_looking','正在摸索'],['talent_familiar_card','寫過方向卡'],['talent_familiar_often','常陪別人想']]),intent([['talent_intent_card','寫一張方向卡'],['talent_intent_walk','看看別人怎麼走'],['talent_intent_coach','陪別人找方向'],['talent_intent_watch','先觀察再決定']]),weekly,participation],
  guild_product_quality_supply:[familiarity('你對商品與供貨有多熟？',[['product_familiar_new','還沒碰過商品'],['product_familiar_seen','看過別人整理'],['product_familiar_draft','做過商品草稿'],['product_familiar_often','常處理供貨']]),intent([['product_intent_draft','建一件商品草稿'],['product_intent_supply','整理可供條件'],['product_intent_quality','核對品質資訊'],['product_intent_watch','先看看怎麼做']]),weekly,participation],
  guild_commerce_sales:[familiarity('你對選貨與銷售有多熟？',[['sales_familiar_new','還沒賣過'],['sales_familiar_seen','看過商店經營'],['sales_familiar_plan','整理過銷售計畫'],['sales_familiar_often','常服務買家']]),intent([['sales_intent_pick','選一件商品'],['sales_intent_plan','寫一份銷售計畫'],['sales_intent_buyer','練習服務買家'],['sales_intent_watch','先觀察再動手']]),weekly,participation],
  guild_marketing:[familiarity('你對內容與行銷有多熟？',[['marketing_familiar_new','還沒做過內容'],['marketing_familiar_seen','看過別人怎麼寫'],['marketing_familiar_draft','寫過行銷草稿'],['marketing_familiar_often','常觀察成效']]),intent([['marketing_intent_draft','寫一份行銷草稿'],['marketing_intent_event','設計一個小活動'],['marketing_intent_result','一起看成效'],['marketing_intent_examples','先收集例子']]),weekly,participation],
  guild_media_automation:[familiarity('你對影片與字幕有多熟？',[['media_familiar_new','還沒剪過片'],['media_familiar_seen','看過製作流程'],['media_familiar_asset','整理過素材'],['media_familiar_often','常做重複流程']]),intent([['media_intent_asset','整理一段素材'],['media_intent_edit','寫清剪輯需求'],['media_intent_caption','做字幕小練習'],['media_intent_watch','先看別人怎麼做']]),weekly,participation],
  guild_member_operations:[familiarity('你對會員交流有多熟？',[['members_familiar_new','剛加入社群'],['members_familiar_seen','參加過幾次交流'],['members_familiar_faq','整理過新人問題'],['members_familiar_often','常幫人找下一步']]),intent([['members_intent_faq','整理新人常見問題'],['members_intent_welcome','幫忙歡迎新會員'],['members_intent_next','一起找下一步'],['members_intent_watch','先觀察交流方式']]),weekly,participation],
  guild_opportunity_partnership:[familiarity('你對合作媒合有多熟？',[['partner_familiar_new','還沒寫過需求'],['partner_familiar_seen','看過別人怎麼連'],['partner_familiar_need','寫過合作需求'],['partner_familiar_often','常在找夥伴']]),intent([['partner_intent_need','寫清一個需求'],['partner_intent_result','列預期成果'],['partner_intent_intro','幫忙牽線'],['partner_intent_watch','先看合作例子']]),weekly,participation],
  guild_platform_engineering:[familiarity('你對平台維護有多熟？',[['platform_familiar_new','還沒碰過程式'],['platform_familiar_seen','看過問題紀錄'],['platform_familiar_repro','重現過一個問題'],['platform_familiar_often','常在修整合']]),intent([['platform_intent_repro','重現一個問題'],['platform_intent_note','寫下可修正紀錄'],['platform_intent_data','一起看資料流'],['platform_intent_read','先讀維護說明']]),weekly,participation],
  guild_commerce_settlement:[familiarity('你對收款對帳有多熟？',[['settle_familiar_new','還沒對過帳'],['settle_familiar_seen','看過核對步驟'],['settle_familiar_payment','整理過一筆付款'],['settle_familiar_often','常在做對帳']]),intent([['settle_intent_payment','整理一筆付款核對'],['settle_intent_steps','寫下核對步驟'],['settle_intent_diff','幫忙看差異'],['settle_intent_read','先讀對帳說明']]),weekly,participation],
  guild_ai_vibe:[familiarity('你對做開源作品有多熟？',[['vibe_familiar_new','還沒做過專案'],['vibe_familiar_seen','看過別人的說明'],['vibe_familiar_readme','寫過使用說明'],['vibe_familiar_often','常做可重用作品']]),intent([['vibe_intent_project','貼一個小專案'],['vibe_intent_readme','寫可重現說明'],['vibe_intent_together','一起改一個作品'],['vibe_intent_example','先讀範例再試']]),weekly,participation],
  guild_ai_field:[familiarity('你對試用與回饋有多熟？',[['field_familiar_new','還沒試過作品'],['field_familiar_used','用過但沒寫回饋'],['field_familiar_note','留過使用回饋'],['field_familiar_often','常幫人試用']]),intent([['field_intent_try','試用一個作品'],['field_intent_note','留下使用回饋'],['field_intent_help','幫忙其他人試'],['field_intent_deploy','先看怎麼部署']]),weekly,participation],
  guild_ai_project:[familiarity('你對拆需求有多熟？',[['project_familiar_new','還沒拆過需求'],['project_familiar_seen','看過別人怎麼拆'],['project_familiar_done','寫過完成條件'],['project_familiar_often','常在協調範圍']]),intent([['project_intent_steps','把需求拆成小步'],['project_intent_done','寫清完成條件'],['project_intent_scope','幫忙對一下範圍'],['project_intent_watch','先看協作例子']]),weekly,participation],
  guild_security:[familiarity('你對安全檢查有多熟？',[['security_familiar_new','還沒做過檢查'],['security_familiar_seen','看過檢查清單'],['security_familiar_scope','記錄過授權範圍'],['security_familiar_often','常核對自己的系統']]),intent([['security_intent_scope','記下授權範圍'],['security_intent_result','整理可重現結果'],['security_intent_book','讀掃描技能書'],['security_intent_flow','先了解檢查流程']]),weekly,participation],
  guild_music_mv:[familiarity('你對歌曲與 MV 有多熟？',[['music_familiar_new','還沒做過歌'],['music_familiar_seen','看過製作例子'],['music_familiar_plan','寫過歌曲企劃'],['music_familiar_often','常在做音樂影像']]),intent([['music_intent_plan','寫一份歌曲企劃'],['music_intent_source','列清素材來源'],['music_intent_story','整理 MV 構想'],['music_intent_book','先讀入門手冊']]),weekly,participation],
  guild_commercial_production:[familiarity('你對廣告拍攝有多熟？',[['commercial_familiar_new','還沒拍過廣告'],['commercial_familiar_seen','看過拍攝流程'],['commercial_familiar_brief','寫過拍攝說明'],['commercial_familiar_often','常在做交付版本']]),intent([['commercial_intent_brief','寫一份拍攝說明'],['commercial_intent_storyboard','畫一張簡單分鏡'],['commercial_intent_delivery','列交付清單'],['commercial_intent_book','先讀入門手冊']]),weekly,participation],
  guild_event_space:[familiarity('你對活動與場地有多熟？',[['event_familiar_new','還沒辦過活動'],['event_familiar_been','參加過幾次聚會'],['event_familiar_brief','寫過活動說明'],['event_familiar_often','常在安排現場']]),intent([['event_intent_brief','填一份活動說明'],['event_intent_roles','安排流程與角色'],['event_intent_backup','想一個備援做法'],['event_intent_watch','先看場地例子']]),weekly,participation],
  guild_projection_mapping:[familiarity('你對光影與投影有多熟？',[['projection_familiar_new','還沒做過投影'],['projection_familiar_seen','看過展演播放'],['projection_familiar_survey','寫過場勘紀錄'],['projection_familiar_often','常在排播放']]),intent([['projection_intent_survey','整理一份場勘'],['projection_intent_zones','畫投影分區'],['projection_intent_cues','排一張播放表'],['projection_intent_watch','先看別人的案子']]),weekly,participation],
  guild_human_design:[familiarity('你對人類圖共讀有多熟？',[['human_familiar_new','還沒讀過'],['human_familiar_seen','看過一些資料'],['human_familiar_note','寫過共讀筆記'],['human_familiar_often','常在查來源']]),intent([['human_intent_note','寫匿名共讀筆記'],['human_intent_source','附上資料來源'],['human_intent_limits','列出限制與問題'],['human_intent_views','先聽不同觀點']]),weekly,participation],
};
const fallback:GuildQuestion[]=[
  familiarity('你對這個公會的主題有多熟？',[['familiar_new','還沒接觸過'],['familiar_seen','看過一些'],['familiar_tried','做過幾次'],['familiar_often','常常在做']]),
  question('intent','你想先在這裡做什麼？',[['intent_learn','先了解再參與'],['intent_try','做一件小事'],['intent_share','分享做過的事'],['intent_help','幫新手起步']]),
  weekly,
];
export const BUILTIN_GUILD_QUESTION_KEYS=Object.keys(builtIn);

export function entryQuestionsForGuild(guildKey:string):GuildQuestionSet{
  // An unexpected catalog row must not take down the whole directory.
  const questions=builtIn[guildKey]??fallback;
  return {version:GUILD_ENTRY_QUESTIONS_VERSION,sha256:digest({version:GUILD_ENTRY_QUESTIONS_VERSION,guild_key:guildKey,questions}),questions};
}
export function sampleGuildAnswers(guildKey:string):Record<string,string>{
  return Object.fromEntries(entryQuestionsForGuild(guildKey).questions.map(item=>[item.id,item.options[0].id]));
}
export function assertGuildAnswers(guildKey:string,raw:unknown):Record<string,string>{
  const invalid=():never=>{throw new Problem(422,'guild_answers_invalid',GUILD_ANSWERS_INVALID);};
  const set=entryQuestionsForGuild(guildKey);
  if(!raw||typeof raw!=='object'||Array.isArray(raw))invalid();
  const source=raw as Record<string,unknown>;
  if(Object.keys(source).length!==set.questions.length)invalid();
  const answers:Record<string,string>={};
  for(const item of set.questions){
    const value=source[item.id];
    const optionId=typeof value==='string'&&item.options.some(option=>option.id===value)?value:invalid();
    answers[item.id]=optionId;
  }
  return answers;
}
export function presentGuildAnswers(guildKey:string,name:string,row:GuildAnswerRow|null){
  const current=entryQuestionsForGuild(guildKey);
  if(!row)return {guild_key:guildKey,name,question_set_version:current.version,outdated:false,answers:null,aggregate_version:null,updated_at:null};
  const stored=row.answers??{},known=new Set(current.questions.map(item=>item.id));
  const answers:StoredGuildAnswer[]=[
    ...current.questions.filter(item=>Object.prototype.hasOwnProperty.call(stored,item.id)).map(item=>{
      const optionId=String(stored[item.id]);
      return {question_id:item.id,prompt:item.prompt,option_id:optionId,label:item.options.find(option=>option.id===optionId)?.label??optionId};
    }),
    ...Object.entries(stored).filter(([id])=>!known.has(id)).map(([questionId,optionId])=>({question_id:questionId,prompt:questionId,option_id:String(optionId),label:String(optionId)})),
  ];
  return {guild_key:guildKey,name,question_set_version:row.question_set_version,outdated:row.question_set_sha256!==current.sha256,answers,aggregate_version:Number(row.aggregate_version),updated_at:new Date(row.updated_at).toISOString()};
}
