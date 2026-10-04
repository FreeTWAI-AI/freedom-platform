import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

// Server-internal transaction composition only. Never opens a transaction or
// returns an authorization context; callers retain all current authority locks.
export const refreshHandleHash = (handle: string) => createHash('sha256').update(JSON.stringify(['freedom.bootstrap-refresh/v1', 'handle', handle])).digest('hex');
export const refreshWireHash = (handle: string) => createHash('sha256').update(handle, 'ascii').digest('base64url');
export async function insertRefreshGeneration(q: PoolClient, familyId: string, generation: string, issuedAt: Date, expiresAt: Date) {
  const handle = randomBytes(32).toString('base64url');
  await q.query(`INSERT INTO bootstrap_refresh_generations(family_id,generation,parent_generation,handle_hash,handle_wire_hash,issued_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [familyId, generation, generation === '1' ? null : (BigInt(generation)-1n).toString(),
    refreshHandleHash(handle), refreshWireHash(handle), issuedAt]);
  return Object.freeze({ familyId, generation, handle, expiresAt: expiresAt.toISOString() });
}
export async function insertInitialRefreshFamily(q: PoolClient, connectionId: string, issuedAt: Date, connectionExpiry: Date) {
  const familyId = randomUUID(), expiresAt = new Date(Math.min(connectionExpiry.getTime(), issuedAt.getTime()+30*86400000));
  await q.query('INSERT INTO bootstrap_refresh_families(family_id,connection_id,issued_at,expires_at) VALUES($1,$2,$3,$4)',
    [familyId, connectionId, issuedAt, expiresAt]);
  return insertRefreshGeneration(q, familyId, '1', issuedAt, expiresAt);
}
