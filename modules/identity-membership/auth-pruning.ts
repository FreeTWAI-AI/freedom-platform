import type { Pool } from 'pg';

// Login-path tables grew without bound since 30-day sessions landed (#107):
// the newest session per user is preserved so members.ts last-seen stays correct.
// Rate-limit deletes repeat the age test outside the subquery so a row a concurrent login just reused is re-checked and kept;
// the readers insert with ON CONFLICT DO UPDATE, which locks an existing row before they SELECT it.
// Every candidate is locked with SKIP LOCKED, so the prune never waits on a request (no lock-order deadlock) and skips rows in use.

// Foreign keys to sessions without ON DELETE CASCADE: a session they still reference is kept,
// otherwise PostgreSQL rejects the whole batch. tests/runtime/auth-pruning.test.ts checks this list against pg_constraint.
export const SESSION_REFERENCES=[['credential_ingest_authorizations','original_session_hash'],['model_broker_authorizations','original_session_hash'],['tenant_high_risk_verifications','session_hash']] as const;
const identifier=/^[a-z_][a-z0-9_]*$/;
export async function pruneExpiredAuthRecords(pool:Pool,{batch=500,sessionReferences=SESSION_REFERENCES}:{batch?:number;sessionReferences?:readonly(readonly [string,string])[]}={}):Promise<{sessions:number;login_attempts:number;auth_rate_limits:number;password_reset_tokens:number}>{
  const unreferenced=sessionReferences.map(([table,column])=>{
    if(!identifier.test(table)||!identifier.test(column))throw new Error('invalid_session_reference');
    return `AND NOT EXISTS(SELECT 1 FROM ${table} r WHERE r.${column}=s.token_hash)`;
  }).join(' ');
  const arl=(await pool.query(`DELETE FROM auth_rate_limits WHERE bucket IN (SELECT bucket FROM auth_rate_limits WHERE window_start < now() - interval '1 day' LIMIT $1 FOR UPDATE SKIP LOCKED) AND window_start < now() - interval '1 day'`,[batch])).rowCount??0;
  const la=(await pool.query(`DELETE FROM login_attempts WHERE attempt_key IN (SELECT attempt_key FROM login_attempts WHERE window_start < now() - interval '1 day' LIMIT $1 FOR UPDATE SKIP LOCKED) AND window_start < now() - interval '1 day'`,[batch])).rowCount??0;
  const prt=(await pool.query(`DELETE FROM password_reset_tokens WHERE token_hash IN (SELECT token_hash FROM password_reset_tokens WHERE expires_at < now() - interval '1 day' LIMIT $1 FOR UPDATE SKIP LOCKED)`,[batch])).rowCount??0;
  // token_hash breaks ties (equal or missing timestamps) so exactly one newest row per user survives.
  const s=(await pool.query(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions s WHERE (expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day')
        AND EXISTS(SELECT 1 FROM sessions n WHERE n.user_id=s.user_id AND (coalesce(n.last_seen_at,n.created_at,'-infinity'),n.token_hash)>(coalesce(s.last_seen_at,s.created_at,'-infinity'),s.token_hash))
        ${unreferenced}
      LIMIT $1 FOR UPDATE OF s SKIP LOCKED
    )`,[batch])).rowCount??0;
  return {sessions:s,login_attempts:la,auth_rate_limits:arl,password_reset_tokens:prt};
}
