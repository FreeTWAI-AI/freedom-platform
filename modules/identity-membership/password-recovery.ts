import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { createMemberSession, hashPasswordAsync, tokenHash, type Actor } from './service.js';

export type PasswordEmailSender=(to:string,url:string)=>Promise<void>;
const RESET_LIFETIME_MINUTES=30;

export async function requestPasswordReset(pool:Pool,email:string,origin:string,send:PasswordEmailSender){
  const normalized=email.trim().toLowerCase();
  // The response is identical for registered and unregistered addresses.
  const user=(await pool.query('SELECT user_id FROM users WHERE email=$1 AND active',[normalized])).rows[0];
  if(!user)return;
  const token=randomBytes(32).toString('base64url');
  const hash=tokenHash(token);
  await pool.query(`INSERT INTO password_reset_tokens(token_hash,user_id,expires_at)
    VALUES($1,$2,now()+interval '30 minutes')`,[hash,user.user_id]);
  const url=`${origin}/#reset-password/${token}`;
  try{await send(normalized,url);}
  catch(error){
    await pool.query('DELETE FROM password_reset_tokens WHERE token_hash=$1',[hash]).catch(()=>{});
    // Never log recipient, token, URL, provider response body, or raw error.
    const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]{1,60}$/.test(error.code)?error.code:'unknown';
    console.error('password_reset_send_failed',code);
  }
}

export async function confirmPasswordReset(pool:Pool,rawToken:string,password:string){
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(rawToken),422,'reset_link_invalid','重設連結無效或已過期，請重新申請。');
  requireCondition(password.length>=12&&password.length<=128,422,'password_length','新密碼需為 12 到 128 個字元。');
  const passwordHash=await hashPasswordAsync(password);
  return transaction(pool,async q=>{
    const candidate=(await q.query<{email:string;user_id:string}>(`SELECT u.email,u.user_id FROM password_reset_tokens r JOIN users u ON u.user_id=r.user_id
      WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.expires_at>clock_timestamp() AND u.active`,[tokenHash(rawToken)])).rows[0];
    requireCondition(candidate,422,'reset_link_invalid','重設連結無效或已過期，請重新申請。');
    // Match login's attempt → user lock order; serialize all reset links before
    // locking tokens so invalidating a competing link cannot deadlock.
    const attemptKey=tokenHash(candidate.email);
    await q.query('INSERT INTO login_attempts VALUES($1,0,now()) ON CONFLICT DO NOTHING',[attemptKey]);
    await q.query('SELECT 1 FROM login_attempts WHERE attempt_key=$1 FOR UPDATE',[attemptKey]);
    // Match authenticated password changes: lock the user before any proof.
    // A joined FOR UPDATE OF r,u does not specify row-lock acquisition order.
    const current=await q.query('SELECT user_id FROM users WHERE user_id=$1 AND email=$2 AND active FOR UPDATE',[candidate.user_id,candidate.email]);
    requireCondition(current.rowCount===1,422,'reset_link_invalid','重設連結無效或已過期，請重新申請。');
    const token=(await q.query<Omit<Actor,'session_hash'|'csrf_token'>>(`SELECT u.* FROM password_reset_tokens r JOIN users u ON u.user_id=r.user_id
      WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.expires_at>clock_timestamp() AND u.active AND u.email=$2 FOR UPDATE OF r`,[tokenHash(rawToken),candidate.email])).rows[0];
    requireCondition(token,422,'reset_link_invalid','重設連結無效或已過期，請重新申請。');
    await q.query('UPDATE users SET password_hash=$2,email_verified_at=COALESCE(email_verified_at,now()) WHERE user_id=$1',[token.user_id,passwordHash]);
    await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[token.user_id]);
    await q.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE token_hash=$1',[tokenHash(rawToken)]);
    await q.query('DELETE FROM password_reset_tokens WHERE user_id=$1 AND token_hash<>$2',[token.user_id,tokenHash(rawToken)]);
    await q.query('UPDATE login_attempts SET failures=0,window_start=now() WHERE attempt_key=$1',[attemptKey]);
    const session=await createMemberSession(q,token);
    return {reset:true as const,expires_after_minutes:RESET_LIFETIME_MINUTES,...session};
  });
}
