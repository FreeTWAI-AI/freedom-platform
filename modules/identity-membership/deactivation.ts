import type { Pool } from 'pg';
import { z } from 'zod';
import { checkVersion, journal, type Command } from '../../packages/db/index.js';
import { runCommandCore } from '../../packages/db/command-core.js';
import { legacyMemberReceiptPorts } from '../../packages/db/member-command.js';
import { lockMemberSession } from '../../packages/db/member-session.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { authRateLimit } from './members.js';
import { verifyMemberPassword } from './service.js';

export async function deactivateAccount(pool: Pool, input: Command) {
  const body=z.object({password:z.string().min(1).max(200)}).strict().parse(input.body);
  requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
  await authRateLimit(pool,'account-deactivation',input.actor.user_id,10);
  const ports=legacyMemberReceiptPorts<{deactivated:boolean}>(input);
  return runCommandCore(pool,{
    ...ports,
    async authenticateAndLock(q) { await lockMemberSession(q,input.actor,true); },
    async writeReceipt(q,hash,response) {
      // The command adapter checks the session after receipt waits. Revoke only
      // after that final check, on the same transaction, including our session.
      await ports.writeReceipt(q,hash,response);
      await q.query('UPDATE users SET active=false WHERE user_id=$1',[input.actor.user_id]);
      await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[input.actor.user_id]);
    },
  },async q=>{
    requireCondition(await verifyMemberPassword(q,input.actor.user_id,body.password),422,'password_incorrect','密碼不正確，帳號尚未停用。');
  },async q=>{
    await q.query('INSERT INTO member_accounts(user_id,community_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.actor.user_id,input.actor.community_id]);
    const account=(await q.query('SELECT aggregate_version FROM member_accounts WHERE user_id=$1 FOR UPDATE',[input.actor.user_id])).rows[0];
    checkVersion(account.aggregate_version,input.expected);
    const updated=(await q.query('UPDATE member_accounts SET aggregate_version=aggregate_version+1 WHERE user_id=$1 RETURNING aggregate_version',[input.actor.user_id])).rows[0];
    await journal(q,input.actor,'member_account',input.actor.user_id,updated.aggregate_version,'deactivate_account',{});
    return {deactivated:true};
  });
}
