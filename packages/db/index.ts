import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { Problem, requireCondition } from '../shared/problem.js';
import type { Actor } from '../../modules/identity-membership/service.js';
export { digest } from './legacy-digest.js';
export { afterRollback, transaction } from './transaction.js';
export { memberCommand, memberCommand as command, type Command } from './member-command.js';

export const LOCAL_DATABASE_URL = 'postgresql://freedom_local:local-development-only@127.0.0.1:54339/freedom_local';
export function createPool(connectionString = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL) {
  return new Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000 });
}
/**
 * One pool per Worker request, built from the explicit Hyperdrive connection
 * string. Hyperdrive already pools origin connections, so each request keeps a
 * small client budget and the caller must end the pool when the request settles.
 * Never share it across requests: Workers sockets belong to one request.
 */
export function createRequestPool(connectionString: string) {
  if (!connectionString) throw new Error('A request database connection is required.');
  return new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
}
export async function journal(q: PoolClient, actor: Actor, type: string, id: string, version: string | number, operation: string, data: unknown = {}, eventType?: string) {
  const transition = randomUUID();
  await q.query('INSERT INTO transition_journal VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())',[transition,actor.community_id,type,id,version,operation,actor.user_id,JSON.stringify(data)]);
  if (eventType) await q.query('INSERT INTO outbox VALUES($1,$2,$3,$4,now())',[randomUUID(),transition,eventType,JSON.stringify({aggregate_id:id,aggregate_version:String(version),community_id:actor.community_id,data})]);
}
export function checkVersion(actual: string, expected?: string) {
  if (!expected) throw new Problem(428,'version_required','請提供 If-Match 版本。');
  requireCondition(actual===expected,412,'version_conflict','資料已更新，請重新整理後再操作。');
}
