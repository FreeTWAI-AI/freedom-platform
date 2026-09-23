import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';

export interface Actor {
  user_id: string; community_id: string; email: string; display_name: string;
  profession_membership_ref: string; session_hash: string; csrf_token: string;
  onboarding_required?: boolean; onboarding_completed_at?: string|null;
}
export const tokenHash = (raw: string) => createHash('sha256').update(raw).digest('hex');
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
const derive = (password:string,salt:string):Promise<Buffer> => new Promise((resolve,reject)=>scrypt(password,salt,64,(error,key)=>error?reject(error):resolve(key)));
export async function hashPasswordAsync(password:string) {
  const salt=randomBytes(16).toString('hex');return `${salt}:${(await derive(password,salt)).toString('hex')}`;
}
async function matches(password: string, saved: string) {
  const [salt,expected] = saved.split(':');
  const actual = await derive(password,salt);
  const other = Buffer.from(expected,'hex');
  return other.length===actual.length && timingSafeEqual(other,actual);
}
const DUMMY_HASH = hashPassword(randomBytes(24).toString('hex'));
export async function login(pool: Pool, email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const attemptKey = tokenHash(normalized);
  const result = await transaction(pool,async q => {
    await q.query(`INSERT INTO login_attempts VALUES($1,0,now()) ON CONFLICT DO NOTHING`,[attemptKey]);
    const attempt = (await q.query('SELECT * FROM login_attempts WHERE attempt_key=$1 FOR UPDATE',[attemptKey])).rows[0];
    if (Date.now()-new Date(attempt.window_start).getTime()>15*60*1000) {
      await q.query('UPDATE login_attempts SET failures=0,window_start=now() WHERE attempt_key=$1',[attemptKey]); attempt.failures=0;
    }
    if (attempt.failures>=10) return {blocked:true} as const;
    const user = (await q.query('SELECT * FROM users WHERE email=$1 FOR SHARE',[normalized])).rows[0];
    const valid = await matches(password,user?.password_hash ?? DUMMY_HASH);
    if (!valid || !user?.active) {
      await q.query('UPDATE login_attempts SET failures=failures+1 WHERE attempt_key=$1',[attemptKey]);
      return {invalid:true} as const;
    }
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await q.query(`INSERT INTO sessions VALUES($1,$2,$3,now()+interval '8 hours',NULL)`,[tokenHash(token),user.user_id,csrf]);
    await q.query('UPDATE login_attempts SET failures=0 WHERE attempt_key=$1',[attemptKey]);
    return {token,actor:{...user,session_hash:tokenHash(token),csrf_token:csrf} as Actor};
  });
  if ('blocked' in result) throw new Problem(429,'login_rate_limited','登入嘗試過多，請稍後再試。');
  if ('invalid' in result) throw new Problem(401,'invalid_credentials','帳號或密碼不正確。');
  return result;
}
export async function authenticate(pool: Pool, raw: string | undefined): Promise<Actor> {
  requireCondition(raw && /^[A-Za-z0-9_-]{43}$/.test(raw),401,'login_required','請先登入。');
  const result = await pool.query(`SELECT u.user_id,u.community_id,u.email,u.display_name,u.profession_membership_ref,u.onboarding_required,u.onboarding_completed_at,
    s.token_hash AS session_hash,s.csrf_token FROM sessions s JOIN users u USING(user_id)
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active`,[tokenHash(raw)]);
  requireCondition(result.rowCount===1,401,'session_expired','登入已到期，請重新登入。');
  return result.rows[0];
}
export function sessionView(actor: Actor) {
  return {user:{user_id:actor.user_id,email:actor.email,display_name:actor.display_name,profession_membership_ref:actor.profession_membership_ref},csrf_token:actor.csrf_token};
}
