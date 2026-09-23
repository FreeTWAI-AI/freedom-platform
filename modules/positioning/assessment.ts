import { digest } from '../../packages/db/index.js';

export const ASSESSMENT_VERSION='freedom-orientation-v1';
export const guildTitles:Record<string,string>={
  guild_talent_direction:'方向陪跑者',guild_product_quality_supply:'商品供應者',guild_commerce_sales:'選品經營者',
  guild_marketing:'內容推廣者',guild_media_automation:'影音創作者',guild_member_operations:'社群連結者',
  guild_opportunity_partnership:'合作開發者',guild_platform_engineering:'平台建造者',guild_commerce_settlement:'交易整合者',
  guild_ai_vibe:'AI 開發者',guild_ai_field:'AI 實踐者',guild_ai_project:'專案推進者',
};
type Option={id:string;label:string;weights:Record<string,number>};
type Question={id:string;kind:'preference'|'ability';prompt:string;options:Option[];explanation?:string};
const o=(id:string,label:string,...guilds:string[]):Option=>({id,label,weights:Object.fromEntries(guilds.map(g=>['guild_'+g,3]))});
const a=(id:string,label:string,correct:boolean,...guilds:string[]):Option=>({id,label,weights:correct?Object.fromEntries(guilds.map(g=>['guild_'+g,1])):{}});
// Original preference and practical-scenario questions. This is not a diagnostic or qualification test.
export const assessmentQuestions:Question[]=[
 {id:'preferred_result',kind:'preference',prompt:'這個月，你最想親手完成哪種成果？',options:[o('product','把一件實體商品的規格與供貨條件整理好','product_quality_supply'),o('store','經營自己的選品商店','commerce_sales'),o('content','寫內容、做設計或讓更多人看見作品','marketing'),o('video','剪出影片、製作字幕或整理影音流程','media_automation'),o('software','把點子做成程式或自動化工具','ai_vibe','platform_engineering')]},
 {id:'team_contribution',kind:'preference',prompt:'小隊剛開始合作，你比較想先做哪件事？',options:[o('listen','聽懂大家的需要，幫忙找到方向','talent_direction','member_operations'),o('connect','找合適的客戶或合作夥伴','opportunity_partnership','commerce_sales'),o('organize','拆清楚目標、範圍與完成條件','ai_project'),o('try','親自試用工具，重現問題再回報','ai_field','platform_engineering')]},
 {id:'work_material',kind:'preference',prompt:'你最喜歡整理哪一類材料？',options:[o('specifications','產品規格、品質、成本與供貨資訊','product_quality_supply','commerce_settlement'),o('stories','文字、圖片、故事與受眾回饋','marketing','media_automation'),o('systems','程式、資料與重複作業流程','ai_vibe','platform_engineering'),o('people','人的背景、需求與學習進度','talent_direction','member_operations')]},
 {id:'help_style',kind:'preference',prompt:'朋友說「卡住了」，你通常比較想怎麼幫忙？',options:[o('coach','一起提問，找出可以開始的一小步','talent_direction','ai_project'),o('introduce','介紹可能幫得上忙的人或資源','opportunity_partnership','member_operations'),o('demonstrate','示範操作，測試做法能不能重現','ai_field','ai_vibe'),o('explain','把重點寫成易懂的圖文或短片','marketing','media_automation')]},
 {id:'business_focus',kind:'preference',prompt:'如果一起做一個小生意，你最想照顧哪個部分？',options:[o('supply','品質、庫存與供貨承諾','product_quality_supply'),o('customer','選品、介紹商品與買家服務','commerce_sales','opportunity_partnership'),o('account','核對商家自己的付款與訂單紀錄','commerce_settlement','platform_engineering'),o('delivery','安排進度、協作與完成交付','ai_project','ai_field')]},
 {id:'learning_focus',kind:'preference',prompt:'接下來你願意多花時間學習哪件事？',options:[o('community','帶新人、辦交流與支持他人學習','member_operations','talent_direction'),o('media','剪輯、字幕、視覺與內容推廣','media_automation','marketing'),o('integration','API、部署、測試與資料整合','platform_engineering','ai_vibe','ai_field'),o('commerce','商店營運、合作、對帳與供應流程','commerce_sales','product_quality_supply','commerce_settlement','opportunity_partnership')]},
 {id:'ability_supply',kind:'ability',prompt:'合作店家問「這個商品能不能下週到？」你會先做什麼？',explanation:'先核對庫存、供貨條件與交期，再給出能負責的承諾。',options:[a('check','先核對可供數量、出貨條件與交期',true,'product_quality_supply','commerce_sales'),a('promise','先承諾，之後再想辦法',false),a('learn','還不熟悉，我想學習這個流程',false)]},
 {id:'ability_content',kind:'ability',prompt:'要幫一件商品做第一篇介紹，哪個起點比較完整？',explanation:'先釐清對象、可驗證資訊與使用素材的權利，才能寫出有根據的內容。',options:[a('audience','先定對象、核對商品事實與素材授權',true,'marketing','media_automation'),a('copy','直接照抄熱門貼文的圖片與宣稱',false),a('learn','還不熟悉，我想學習內容製作',false)]},
 {id:'ability_support',kind:'ability',prompt:'新成員說「我什麼都不會」，你會怎麼開始？',explanation:'先聽需求，協助本人選擇可以完成的小步；不替對方定義能力上限。',options:[a('listen','先問他想做什麼，再一起選一個小任務',true,'talent_direction','member_operations'),a('label','替他貼上固定的能力標籤',false),a('learn','還不熟悉，我想學習如何陪跑',false)]},
 {id:'ability_delivery',kind:'ability',prompt:'夥伴說「做一個網站」，下一步最有幫助的是？',explanation:'把使用者、範圍與驗收例子寫清楚，可以讓雙方對成果有共同理解。',options:[a('scope','確認使用者、範圍與具體完成例子',true,'ai_project','opportunity_partnership'),a('start','不問需求，直接承諾全部功能',false),a('learn','還不熟悉，我想學習需求整理',false)]},
 {id:'ability_debug',kind:'ability',prompt:'工具在你電腦上失敗了，哪種回報最能幫助作者？',explanation:'可重現步驟、預期與實際結果、去除秘密的環境資訊，有助於定位問題。',options:[a('reproduce','提供重現步驟、結果及去除秘密的環境資訊',true,'ai_field','ai_vibe','platform_engineering'),a('secret','把帳號密碼與完整私密資料貼到公開區',false),a('learn','還不熟悉，我想學習測試回報',false)]},
 {id:'ability_reconcile',kind:'ability',prompt:'訂單標示完成，但付款資料對不上，應該怎麼處理？',explanation:'分開記錄回報與已核實的付款事實，由商家查核自己的付款來源。平台不代收款。',options:[a('verify','請商家核對訂單與外部付款證據，先標待核實',true,'commerce_settlement','platform_engineering'),a('assume','只要有人說付了就標成銀行實收',false),a('learn','還不熟悉，我想學習對帳',false)]},
];
export const ASSESSMENT_SHA256=digest({version:ASSESSMENT_VERSION,questions:assessmentQuestions,titles:guildTitles});
export function publicAssessmentDefinition(){return {assessment_version:ASSESSMENT_VERSION,assessment_sha256:ASSESSMENT_SHA256,questions:assessmentQuestions.map(({id,kind,prompt,options})=>({id,kind,prompt,options:options.map(({id,label})=>({id,label}))}))};}
export function evaluateAssessment(answers:Record<string,string>) {
 const scores=Object.fromEntries(Object.keys(guildTitles).map(key=>[key,0]));
 const reasons:Record<string,string[]>={};
 for(const question of assessmentQuestions){
   const option=question.options.find(option=>option.id===answers[question.id]);
   if(!option)throw new Error(`Incomplete or invalid assessment question: ${question.id}`);
   for(const [key,weight] of Object.entries(option.weights)){
     scores[key]+=weight;
     if(question.kind==='preference')(reasons[key]??=[]).push(option.label);
   }
 }
 const recommendations=Object.keys(scores).sort((x,y)=>scores[y]-scores[x]||x.localeCompare(y)).slice(0,3).map(guild_key=>({guild_key,title:guildTitles[guild_key],reason:reasons[guild_key]?.length?`你選擇「${reasons[guild_key].slice(0,2).join('」、「')}」，可以從這個公會開始探索。`:'可從這個公會的入門技能包開始探索。'}));
 return {assessment_version:ASSESSMENT_VERSION,assessment_sha256:ASSESSMENT_SHA256,recommendations,ability_feedback:assessmentQuestions.filter(q=>q.kind==='ability').map(q=>({question_id:q.id,explanation:q.explanation}))};
}
