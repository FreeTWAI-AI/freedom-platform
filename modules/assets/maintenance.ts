import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../../packages/db/transaction.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { objectKey, type ObjectStore } from '../../packages/asset-storage/index.js';

const id = z.uuid();
const version = z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && !/[\r\n]/.test(value) && BigInt(value) <= 9223372036854775807n);
const lease = z.object({ assetId: id, attempt: version, leaseToken: id }).strict();
export type AssetDeletionLease = z.infer<typeof lease>;
interface Policy {
  enabled: boolean; domain_media_enabled:boolean; revision: string; delete_lease_seconds: number; capture_seconds: number; pin_seconds: number; max_capture_objects: number;
}
interface Asset { asset_id: string; scope_id: string; representation_id: string; owner_user_id: string; purpose:string }
interface Capture { capture_id: string; state: string; capture_expires_at: Date; pin_expires_at: Date | null; reference_count: number | null }

/** Closed trusted maintenance port, not member/service HTTP authorization.
 * Both this explicit opt-in and complete DB policy are required. No scheduling,
 * environment lookup, bucket LIST, backup copy, restore or default retention. */
export function createAssetMaintenance(pool: Pool, dependencies: { store: ObjectStore; enabled?: boolean; domainMediaEnabled?:boolean }) {
  const { store } = dependencies, enabled = dependencies.enabled === true;
  const active = () => requireCondition(enabled, 503, 'asset_maintenance_disabled', '資產維運尚未啟用。');
  async function policy(q: PoolClient, lock: '' | 'SHARE' | 'UPDATE' = '', purpose?:string): Promise<Policy> {
    const row = (await q.query<Policy>('SELECT * FROM asset_maintenance_policy WHERE singleton' + (lock ? ' FOR ' + lock : ''))).rows[0];
    requireCondition(row?.enabled === true, 503, 'asset_maintenance_disabled', '資產維運尚未啟用。');
    if(purpose&&purpose!=='member.avatar')requireCondition(dependencies.domainMediaEnabled===true&&row.domain_media_enabled===true,503,'asset_domain_maintenance_disabled','內容維運尚未啟用。');
    return row;
  }
  async function claimDelete(assetId: string): Promise<AssetDeletionLease> {
    active(); assetId = id.parse(assetId);
    return transaction(pool, async q => {
      const initial = (await q.query<Asset>('SELECT asset_id,scope_id,representation_id,owner_user_id,purpose FROM assets WHERE asset_id=$1', [assetId])).rows[0];
      requireCondition(initial, 404, 'asset_not_found', '找不到資產。');
      // Exactly the upload owner order. Never hold the global gate while waiting
      // on these rows; backup begin only touches that gate and a new capture.
      requireCondition(initial.purpose==='member.avatar'||dependencies.domainMediaEnabled===true,503,'asset_domain_maintenance_disabled','內容維運尚未啟用。');
      await q.query('SELECT lock_asset_deletion_domain($1)',[assetId]);
      const current = await policy(q, 'SHARE',initial.purpose);
      const existing = (await q.query('SELECT * FROM asset_deletion_tombstones WHERE asset_id=$1 FOR UPDATE', [assetId])).rows[0];
      const token = randomUUID();
      if (!existing) {
        // The database independently enforces retention, live references,
        // capture barriers and pins before permanently changing asset tuple.
        await q.query(`INSERT INTO asset_deletion_tombstones(asset_id,policy_revision,lease_token,lease_expires_at)
          VALUES($1,$2,$3,clock_timestamp()+make_interval(secs=>$4))`, [assetId, current.revision, token, current.delete_lease_seconds]);
        return { assetId, attempt: '1', leaseToken: token };
      }
      const next = (await q.query(`UPDATE asset_deletion_tombstones SET attempt=attempt+1,lease_token=$2,
        lease_expires_at=clock_timestamp()+make_interval(secs=>$3)
        WHERE asset_id=$1 AND lease_expires_at<=clock_timestamp() RETURNING attempt`, [assetId, token, current.delete_lease_seconds])).rows[0];
      requireCondition(next, 409, 'asset_delete_lease_active', '已有進行中的清理租約。');
      return { assetId, attempt: next.attempt as string, leaseToken: token };
    });
  }
  async function deleteObject(raw: AssetDeletionLease) {
    active(); const input = lease.parse(raw);
    const identity = await transaction(pool, async q => {
      const row = (await q.query<Asset>(`SELECT a.asset_id,a.scope_id,a.representation_id,a.owner_user_id,a.purpose FROM assets a
        JOIN asset_deletion_tombstones t USING(asset_id) WHERE a.asset_id=$1 AND a.deletion_fence=1
        AND t.attempt=$2 AND t.lease_token=$3 AND t.lease_expires_at>clock_timestamp()`, [input.assetId, input.attempt, input.leaseToken])).rows[0];
      requireCondition(row, 409, 'asset_delete_lease_stale', '清理租約已失效。'); await policy(q,'',row.purpose);return row;
    });
    const key = objectKey({ scopeId: identity.scope_id, assetId: identity.asset_id, representationId: identity.representation_id });
    let observation: 'missing' | 'present' | 'unknown';
    try {
      await store.delete(key); // No database row locks survive into either I/O.
      observation = await store.head(key) ? 'present' : 'missing';
    } catch { observation = 'unknown'; } // Never persist upstream exception/key/content.
    await transaction(pool, async q => {
      const result = await q.query(`UPDATE asset_deletion_tombstones SET observation=$4,observed_at=clock_timestamp(),lease_expires_at=clock_timestamp()
        WHERE asset_id=$1 AND attempt=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp()`,
      [input.assetId, input.attempt, input.leaseToken, observation]);
      requireCondition(result.rowCount === 1, 409, 'asset_delete_lease_stale', '清理租約已失效。');
    });
    // This is an observation, never a permanent absence or erasure certificate.
    return { assetId: input.assetId, attempt: input.attempt, observation };
  }
  async function beginCapture(raw: { sourceRelease: string; sourceSchema: string }) {
    active(); const input = z.object({ sourceRelease: z.string().regex(/^[0-9a-f]{40}$/).length(40), sourceSchema: z.string().min(1).max(80) }).strict().parse(raw);
    return transaction(pool, async q => {
      const current = await policy(q, 'UPDATE'), captureId = randomUUID();
      // Commit this barrier BEFORE the reference snapshot starts. Its trigger
      // advances a real gate tuple, fencing old RR snapshots as well as RC.
      const row = (await q.query(`INSERT INTO asset_backup_captures(capture_id,source_release,source_schema,capture_expires_at)
        VALUES($1,$2,$3,clock_timestamp()+make_interval(secs=>$4)) RETURNING capture_expires_at`,
      [captureId, input.sourceRelease, input.sourceSchema, current.capture_seconds])).rows[0];
      return { captureId, captureExpiresAt: row.capture_expires_at.toISOString() as string };
    });
  }
  async function captureReferences(captureId: string, options?: { snapshotId: string }) {
    active(); captureId = id.parse(captureId);
    // A trusted backup host keeps the exporting transaction open until both
    // this reference capture and pg_dump finish. Never accept a SQL fragment.
    const imported = options === undefined ? undefined : z.object({ snapshotId: z.string()
      .regex(/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/) }).strict().parse(options).snapshotId;
    const q = await pool.connect();
    try {
      await q.query(imported ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
      if (imported) await q.query(`SET TRANSACTION SNAPSHOT '${imported}'`);
      const current = await policy(q);
      const capture = (await q.query<Capture>(`SELECT *,capture_expires_at>clock_timestamp() live FROM asset_backup_captures WHERE capture_id=$1`, [captureId])).rows[0] as Capture & { live: boolean };
      requireCondition(capture?.state === 'capturing' && capture.live, 409, 'asset_capture_expired', '參照集合擷取已失效。');
      // Conservatively capture ALL persisted, unfenced representations in this
      // one DB snapshot, including retired versions, not caller-selected IDs.
      const observed = (await q.query(`WITH refs AS MATERIALIZED (
        SELECT o.asset_id,o.scope_id,o.representation_id,o.policy_revision,o.byte_size,o.content_sha256
        FROM asset_objects o JOIN assets a USING(asset_id) WHERE a.deletion_fence=0 ORDER BY o.asset_id LIMIT $1)
        SELECT pg_current_snapshot()::text snapshot,COALESCE(jsonb_agg(to_jsonb(refs) ORDER BY asset_id),'[]'::jsonb) refs FROM refs`,
      [current.max_capture_objects + 1])).rows[0];
      const refs = observed.refs as { asset_id: string; scope_id: string; representation_id: string; policy_revision: string; byte_size: number; content_sha256: string }[];
      requireCondition(refs.length <= current.max_capture_objects, 409, 'asset_capture_limit', '參照集合超過本次擷取上限。');
      const snapshot = observed.snapshot;
      // Asset FK locks are obtained in UUID order. Do not lock the gate or the
      // capture row while waiting on assets; the committed barrier protects us.
      for (const ref of refs) await q.query(`INSERT INTO asset_backup_pins(capture_id,asset_id,scope_id,representation_id,policy_revision,byte_size,content_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [captureId, ref.asset_id, ref.scope_id, ref.representation_id, ref.policy_revision, ref.byte_size, ref.content_sha256]);
      const pinned = await q.query(`UPDATE asset_backup_captures SET state='pinned',reference_snapshot=$2,reference_count=$3,
        pin_expires_at=clock_timestamp()+make_interval(secs=>$4) WHERE capture_id=$1 AND state='capturing' AND capture_expires_at>clock_timestamp()`,
      [captureId, snapshot, refs.length, current.pin_seconds]);
      requireCondition(pinned.rowCount === 1, 409, 'asset_capture_expired', '參照集合擷取已失效。');
      await q.query('COMMIT');
      return { captureId, referenceCount: refs.length }; // Not a completed backup.
    } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  }
  async function readReferences(captureId: string) {
    active(); captureId = id.parse(captureId);
    return transaction(pool, async q => {
      const capture = (await q.query(`SELECT * FROM asset_backup_captures WHERE capture_id=$1 AND state='pinned' AND pin_expires_at>clock_timestamp() FOR SHARE`, [captureId])).rows[0];
      requireCondition(capture, 409, 'asset_capture_expired', '備份參照已失效。');
      const references = (await q.query(`SELECT asset_id,scope_id,representation_id,policy_revision,byte_size,content_sha256
        FROM asset_backup_pins WHERE capture_id=$1 ORDER BY asset_id`, [captureId])).rows;
      await policy(q, 'SHARE');
      requireCondition((await q.query('SELECT pin_expires_at>clock_timestamp() live FROM asset_backup_captures WHERE capture_id=$1', [captureId])).rows[0].live,
        409, 'asset_capture_expired', '備份參照已失效。');
      return { captureId, referenceSnapshot: capture.reference_snapshot as string, sourceRelease: capture.source_release as string,
        sourceSchema: capture.source_schema as string, references };
    });
  }
  async function renewProtection(captureId: string) {
    active(); captureId = id.parse(captureId);
    return transaction(pool, async q => {
      const capture = (await q.query<Capture>('SELECT * FROM asset_backup_captures WHERE capture_id=$1 FOR UPDATE', [captureId])).rows[0];
      requireCondition(capture?.state === 'capturing' || capture?.state === 'pinned', 409, 'asset_capture_expired', '備份保護已失效。');
      const current = await policy(q), column = capture.state === 'capturing' ? 'capture_expires_at' : 'pin_expires_at';
      const updated = (await q.query(`UPDATE asset_backup_captures SET ${column}=clock_timestamp()+make_interval(secs=>$2)
        WHERE capture_id=$1 AND ${column}>clock_timestamp() RETURNING ${column} expires_at`,
      [captureId, capture.state === 'capturing' ? current.capture_seconds : current.pin_seconds])).rows[0];
      requireCondition(updated, 409, 'asset_capture_expired', '已過期的備份保護不能續期。');
      return { captureId, expiresAt: updated.expires_at.toISOString() as string };
    });
  }
  async function releaseProtection(captureId: string, reason: 'abort' | 'release') {
    active(); captureId = id.parse(captureId); reason = z.enum(['abort', 'release']).parse(reason);
    return transaction(pool, async q => {
      const result = await q.query(`UPDATE asset_backup_captures SET state=$2 WHERE capture_id=$1 AND state IN ('capturing','pinned')
        AND ($2='failed' OR state='pinned')`, [captureId, reason === 'abort' ? 'failed' : 'released']);
      requireCondition(result.rowCount === 1, 409, 'asset_capture_state', '備份保護狀態已改變。');
      return { captureId, state: reason === 'abort' ? 'failed' : 'released' };
    });
  }
  return Object.freeze({ claimDelete, deleteObject, beginCapture, captureReferences, readReferences, renewProtection, releaseProtection });
}
