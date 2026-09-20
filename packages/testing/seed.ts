import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction,digest,journal } from '../db/index.js';
import { hashPassword,type Actor } from '../../modules/identity-membership/service.js';
import { voluntaryTerms } from '../../modules/opportunity-project-work/work.js';

export const DEMO_PASSWORD='freedom-local-demo';
export const DEMO_COMMUNITY='10000000-0000-4000-8000-000000000001';
export const DEMO_WORK='30000000-0000-4000-8000-000000000001';
export const DEMO_USERS=[
  {user_id:'20000000-0000-4000-8000-000000000001',email:'maker@local.test',display_name:'示範創作者',profession_membership_ref:'40000000-0000-4000-8000-000000000001'},
  {user_id:'20000000-0000-4000-8000-000000000002',email:'reviewer@local.test',display_name:'示範需求者',profession_membership_ref:'40000000-0000-4000-8000-000000000002'},
  {user_id:'20000000-0000-4000-8000-000000000003',email:'client@local.test',display_name:'示範合作方',profession_membership_ref:'40000000-0000-4000-8000-000000000003'}
];
export async function seedLocal(pool:Pool) {
  const passwords=DEMO_USERS.map(()=>hashPassword(DEMO_PASSWORD));
  return transaction(pool,async q=>{
    await q.query('SELECT pg_advisory_xact_lock(2026092001)');
    await q.query('INSERT INTO communities VALUES($1,$2) ON CONFLICT DO NOTHING',[DEMO_COMMUNITY,'Freedom 本機示範社群']);
    for(const [i,user] of DEMO_USERS.entries()) await q.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[user.user_id,DEMO_COMMUNITY,user.email,user.display_name,passwords[i],user.profession_membership_ref]);
    const owner={...DEMO_USERS[1],community_id:DEMO_COMMUNITY,session_hash:'seed-only',csrf_token:'seed-only'} satisfies Actor;
    const body={title:'把第一份作品整理成可重用說明',objective:'讓下一位成員能看懂作品解決的問題，並自行重用。',acceptance_criteria:'說明包含適用情境、三個操作步驟與一個合成範例；不含私人資料。',gain:'留下自己的作品說明與協作紀錄，不保證收入或後續案源。',estimated_minutes:30,maximum_minutes:60,claim_by:new Date(Date.now()+7*86400000).toISOString(),finish_by:new Date(Date.now()+14*86400000).toISOString(),will_review:true};
    const terms=voluntaryTerms(body,owner);
    const created=await q.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,participation_terms_sha256,claim_window_expires_at,due_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING work_item_id`,[DEMO_WORK,DEMO_COMMUNITY,owner.user_id,body.title,body.objective,body.acceptance_criteria,body.gain,terms,digest(terms),body.claim_by,body.finish_by]);
    if(created.rowCount) {
      await q.query('INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until) VALUES($1,$2,$3)',[DEMO_WORK,owner.user_id,terms.completion.feedback_due]);
      await journal(q,owner,'work_item',DEMO_WORK,1,'open',{fixture:true},'freedom.work.item.opened.v1');
    }
  });
}
