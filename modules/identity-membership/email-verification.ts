import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../packages/db/index.js';
import { lockMemberSession, assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { requireCondition } from '../../packages/shared/problem.js';
import type { EventEmailSender } from '../community/events.js';
import { authRateLimitInTransaction } from './members.js';
import { tokenHash, type Actor } from './service.js';

export async function requestEmailVerification(pool:Pool,actor:Actor,origin:string,send:EventEmailSender){
  const token=randomBytes(32).toString('base64url'),hash=tokenHash(token);
  const email=await transaction(pool,async q=>{
    await lockMemberSession(q,actor,true);
    const user=(await q.query('SELECT email,email_verified_at FROM users WHERE user_id=$1',[actor.user_id])).rows[0];
    requireCondition(!user.email_verified_at,409,'email_already_verified','此登入信箱已完成驗證。');
    await authRateLimitInTransaction(q,'email-verification-member',actor.user_id,3,3600);
    // Bind proof to the address at issuance; changing login email invalidates it.
    await q.query(`INSERT INTO email_verification_tokens(token_hash,user_id,email,expires_at)
      VALUES($1,$2,$3,now()+interval '30 minutes')`,[hash,actor.user_id,user.email]);
    await assertCurrentSessionClock(q,actor);
    return user.email as string;
  });
  try{
    await send(email,'自由工坊：驗證登入信箱',`請在 30 分鐘內開啟以下連結並確認驗證登入信箱：\n${origin}/#verify-email/${token}\n\n若不是你提出申請，請忽略此信。`);
  }catch{
    await pool.query('DELETE FROM email_verification_tokens WHERE token_hash=$1',[hash]);
    requireCondition(false,503,'email_verification_send_failed','驗證信寄送失敗，請稍後重試。');
  }
  return {requested:true};
}

export async function confirmEmailVerification(pool:Pool,rawToken:string){
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(rawToken),422,'email_verification_link_invalid','驗證連結無效或已過期，請回帳號頁重新寄送。');
  const hash=tokenHash(rawToken);
  return transaction(pool,async q=>{
    const candidate=(await q.query('SELECT user_id FROM email_verification_tokens WHERE token_hash=$1',[hash])).rows[0];
    requireCondition(candidate,422,'email_verification_link_invalid','驗證連結無效或已過期，請回帳號頁重新寄送。');
    // All verification operations lock the user before tokens; concurrent links
    // cannot deadlock when consuming the other outstanding proofs.
    const user=(await q.query('SELECT email FROM users WHERE user_id=$1 AND active FOR UPDATE',[candidate.user_id])).rows[0];
    requireCondition(user,422,'email_verification_link_invalid','驗證連結無效或已過期，請回帳號頁重新寄送。');
    const proof=await q.query(`SELECT 1 FROM email_verification_tokens WHERE token_hash=$1 AND user_id=$2
      AND email=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,[hash,candidate.user_id,user.email]);
    requireCondition(proof.rowCount===1,422,'email_verification_link_invalid','驗證連結無效或已過期，請回帳號頁重新寄送。');
    await q.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE user_id=$1',[candidate.user_id]);
    await q.query('UPDATE email_verification_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[candidate.user_id]);
    return {verified:true};
  });
}
