import type {PoolClient} from 'pg';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
export interface SkillUploadGrant {readonly user_id:string;readonly community_id:string;readonly grant_hash:string;readonly submission_id:string;}
export const invalidSkillUploadGrant=()=>new Problem(401,'upload_grant_invalid','上傳授權無效、已過期、已撤銷或不屬於這份草稿。請會員按「重新產生指令」重新產生授權，不要重送同一個授權，改用新指令裡的 Authorization: Bearer fpg_…。');
/** Original owner/key/grant authority. No session Actor or generic machine scope. */
export async function lockSkillUploadGrant(q:PoolClient,grant:SkillUploadGrant){
 const member=(await q.query('SELECT active,active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AS ready FROM users WHERE user_id=$1 AND community_id=$2 FOR SHARE',[grant.user_id,grant.community_id])).rows[0];
 if(!member?.active)throw invalidSkillUploadGrant();requireCondition(member.ready,403,'onboarding_required','帳號尚未選擇主要公會，完成加入後才能上傳技能。');
 const peek=(await q.query('SELECT grant_key_id FROM skill_submissions WHERE submission_id=$1 AND grant_hash=$2',[grant.submission_id,grant.grant_hash])).rows[0];if(!peek)throw invalidSkillUploadGrant();
 if(peek.grant_key_id){const key=await q.query('SELECT 1 FROM skill_upload_keys WHERE key_id=$1 AND user_id=$2 AND community_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',[peek.grant_key_id,grant.user_id,grant.community_id]);if(key.rowCount!==1)throw invalidSkillUploadGrant();}
 const row=(await q.query('SELECT submission_id,status,aggregate_version,grant_key_id,grant_hash,grant_revoked_at,grant_expires_at>clock_timestamp() AS grant_live,grant_consumed_at,payload_sha256,seed FROM skill_submissions WHERE submission_id=$1 AND grant_hash=$2 AND owner_ref=$3 AND community_id=$4 FOR UPDATE',[grant.submission_id,grant.grant_hash,grant.user_id,grant.community_id])).rows[0];
 if(!row||row.grant_revoked_at||!row.grant_live||row.status==='revoked'||row.grant_key_id!==peek.grant_key_id)throw invalidSkillUploadGrant();return row;
}
/** Recheck actual decision clock after waits on policy/asset rows. */
export async function assertSkillUploadGrantClock(q:PoolClient,grant:SkillUploadGrant){
 const row=(await q.query(`SELECT 1 FROM skill_submissions s JOIN users u ON u.user_id=s.owner_ref AND u.community_id=s.community_id WHERE s.submission_id=$1 AND s.grant_hash=$2 AND s.owner_ref=$3 AND s.community_id=$4 AND s.grant_revoked_at IS NULL AND s.grant_expires_at>clock_timestamp() AND s.status<>'revoked' AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND (s.grant_key_id IS NULL OR EXISTS(SELECT 1 FROM skill_upload_keys k WHERE k.key_id=s.grant_key_id AND k.user_id=u.user_id AND k.community_id=u.community_id AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp()))`,[grant.submission_id,grant.grant_hash,grant.user_id,grant.community_id])).rows[0];if(!row)throw invalidSkillUploadGrant();
}
