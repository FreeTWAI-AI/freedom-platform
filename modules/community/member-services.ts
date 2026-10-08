import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { checkVersion, command, digest, type Command } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { SERVICE_CATEGORY_LABELS, SERVICE_LIMIT, SERVICE_MODE_LABELS, validateMemberService, type ServiceCategory, type ServiceContact, type ServiceMode } from '../../packages/shared/member-service.js';
import { AssetStorageError,snapshotBoundedBytes,type ObjectStore } from '../../packages/asset-storage/index.js';
import { serviceCoverMemberCommand } from '../../packages/scoped-commands/index.js';
import { serviceCoverStorageMode,type ServiceCoverAssetService } from '../assets/media-domain.js';
import { readDomainMedia,type DomainMediaSnapshot } from '../../packages/media-migration/domain-bridge.js';
import { normalizeServiceCover } from '../skill-submissions/payload.js';
import { avatarUrl } from '../identity-membership/avatars.js';
import type { Actor } from '../identity-membership/service.js';
import { canHideMemberContent } from './moderation.js';
import { serviceDetailHtml, serviceListHtml, serviceMissingHtml, type PublicServiceCard, type PublicServicePage } from './member-service-pages.js';

const MEMBER_PAGE = 24;
const PUBLIC_PAGE = 12;
type Db = Pool | PoolClient;
type Owned = { service_id: string; state: string; aggregate_version: string };
type Row = {
  service_id: string; title: string; category: ServiceCategory; summary: string; description: string | null;
  price_text: string | null; area_text: string | null; service_mode: ServiceMode; contacts: ServiceContact[];
  state: string; aggregate_version: string; updated_at: Date | string; updated_cursor: string; owner_user_id: string; display_name: string;
  avatar_version: string | null; has_avatar: boolean; test_account: boolean; has_cover: boolean; total_points: number; my_points: number;
};

// Date.toISOString() drops microseconds, and cover publication writes clock_timestamp(). The keyset must keep them or the next page skips rows inside that millisecond.
const UPDATED_CURSOR = `to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_cursor`;
const LIST = `SELECT s.service_id,s.title,s.category,s.summary,s.description,s.price_text,s.area_text,s.service_mode,s.contacts,s.state,
  s.aggregate_version::text AS aggregate_version,s.updated_at,${UPDATED_CURSOR},s.owner_user_id,u.display_name,
  a.aggregate_version::text AS avatar_version,a.present AS has_avatar,
  is_verification_test_account(u.user_id) AS test_account,c.service_id IS NOT NULL AS has_cover,
  (SELECT count(*)::int FROM promotion_clicks k JOIN promotion_links l ON l.link_id=k.link_id WHERE l.kind='member_service' AND l.target_key=s.service_id::text) AS total_points,
  (SELECT count(*)::int FROM promotion_clicks k JOIN promotion_links l ON l.link_id=k.link_id WHERE l.kind='member_service' AND l.target_key=s.service_id::text AND l.user_id=$2) AS my_points
  FROM member_services s
  JOIN users u ON u.user_id=s.owner_user_id
  LEFT JOIN member_avatar_presence a ON a.user_id=u.user_id AND a.community_id=s.community_id
  LEFT JOIN member_service_covers c ON c.service_id=s.service_id`;
const PUBLIC_VISIBLE = `s.state='active' AND u.active AND NOT is_verification_test_account(u.user_id)`;

function iso(value: Date | string) { return new Date(value).toISOString(); }
function view(row: Row, viewerId: string, canHide: boolean) {
  const showAvatar = row.has_avatar && (!row.test_account || row.owner_user_id === viewerId);
  return {
    service_id: row.service_id, title: row.title, category: row.category, category_label: SERVICE_CATEGORY_LABELS[row.category],
    summary: row.summary, description: row.description, price_text: row.price_text, area_text: row.area_text,
    service_mode: row.service_mode, service_mode_label: SERVICE_MODE_LABELS[row.service_mode], contacts: row.contacts,
    state: row.state, aggregate_version: row.aggregate_version, updated_at: iso(row.updated_at),
    cover_url: row.has_cover ? `/api/v1/member-services/${row.service_id}/cover?v=${row.aggregate_version}` : null,
    owner: { user_id: row.owner_user_id, display_name: row.display_name, avatar_url: showAvatar ? avatarUrl(row.owner_user_id, row.avatar_version ?? 1, true) : null },
    public_path: `/services/${row.service_id}`, total_points: Number(row.total_points) || 0, my_points: Number(row.my_points) || 0,
    mine: row.owner_user_id === viewerId, can_hide: canHide,
  };
}
function cursorOf(raw: string | undefined, strict: boolean) {
  if (!raw) return null;
  try {
    const [updatedAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('\n');
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt)) || !z.uuid().safeParse(id ?? '').success) throw new Error('bad');
    return { updatedAt, id: id! };
  } catch (error) {
    if (error instanceof Problem) throw error;
    if (strict) throw new Problem(422, 'invalid_cursor', '分頁標記不正確。');
    return null;
  }
}
function encodeCursor(updatedAt: string, id: string) { return Buffer.from(`${updatedAt}\n${id}`).toString('base64url'); }
function categoryOf(raw: string | undefined, strict: boolean) {
  const value = raw ?? '';
  if (!value) return '';
  if (value in SERVICE_CATEGORY_LABELS) return value as ServiceCategory;
  if (strict) throw new Problem(422, 'validation_failed', '分類篩選不正確。');
  return '';
}
async function one(q: Db, communityId: string, viewerId: string, id: string) {
  return (await q.query(`${LIST} WHERE s.community_id=$1 AND s.service_id=$3`, [communityId, viewerId, id])).rows[0] as Row | undefined;
}
function draft(raw: unknown) {
  const parsed = validateMemberService(raw);
  if (!parsed.ok) throw new Problem(422, parsed.issues[0]?.code ?? 'validation_failed', parsed.issues[0]?.message ?? '請修正服務內容。');
  return parsed.value;
}
async function owned(q: Db, actor: Actor, id: string, lock = false): Promise<Owned> {
  const row = (await q.query(`SELECT service_id::text,owner_user_id::text,state,aggregate_version::text AS aggregate_version
    FROM member_services WHERE service_id=$1 AND community_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, actor.community_id])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這項服務。');
  requireCondition(row.owner_user_id === actor.user_id, 403, 'owner_required', '只能管理自己的服務。');
  return row as Owned;
}
function visibleToOwner(row: Owned) {
  requireCondition(row.state === 'active' || row.state === 'paused', 404, 'not_found', '找不到這項服務。');
}
async function shown(q: Db, actor: Actor, id: string) {
  return view((await one(q, actor.community_id, actor.user_id, id))!, actor.user_id, await canHideMemberContent(q, actor));
}

export async function listMemberServices(pool: Pool, actor: Actor, query: { category?: string; cursor?: string }) {
  const category = categoryOf(query.category, true);
  const cursor = cursorOf(query.cursor, true);
  const canHide = await canHideMemberContent(pool, actor);
  const rows = (await pool.query(`${LIST}
    WHERE s.community_id=$1 AND s.state='active'
      AND (s.owner_user_id=$2 OR (u.active AND NOT is_verification_test_account(u.user_id)))
      AND ($3::text IS NULL OR s.category=$3)
      AND ($4::timestamptz IS NULL OR (s.updated_at,s.service_id)<($4::timestamptz,$5::uuid))
    ORDER BY s.updated_at DESC,s.service_id DESC LIMIT 25`, [actor.community_id, actor.user_id, category || null, cursor?.updatedAt ?? null, cursor?.id ?? null])).rows as Row[];
  const pageRows = rows.slice(0, MEMBER_PAGE);
  const last = pageRows.at(-1);
  return { items: pageRows.map(row => view(row, actor.user_id, canHide)), next_cursor: rows.length > MEMBER_PAGE && last ? encodeCursor(last.updated_cursor, last.service_id) : null, can_hide: canHide };
}

export async function listMyMemberServices(pool: Pool, actor: Actor) {
  const canHide = await canHideMemberContent(pool, actor);
  const rows = (await pool.query(`${LIST} WHERE s.community_id=$1 AND s.owner_user_id=$2 AND s.state IN ('active','paused')
    ORDER BY s.updated_at DESC,s.service_id DESC`, [actor.community_id, actor.user_id])).rows as Row[];
  return { items: rows.map(row => view(row, actor.user_id, canHide)), can_hide: canHide, limit: SERVICE_LIMIT };
}

export async function createMemberService(pool: Pool, input: Command, now = new Date()) {
  const body = draft(input.body);
  return command(pool, input, async () => {}, async q => {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`member-service:${input.actor.user_id}`]);
    const used = (await q.query(`SELECT count(*)::int AS n FROM member_services WHERE owner_user_id=$1 AND state IN ('active','paused')`, [input.actor.user_id])).rows[0].n as number;
    requireCondition(used < SERVICE_LIMIT, 409, 'member_service_limit', '每位社員最多 5 項服務（含暫停）。');
    const inserted = (await q.query(`INSERT INTO member_services(community_id,owner_user_id,title,category,summary,description,price_text,area_text,service_mode,contacts,state,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'active',$11,$11) RETURNING service_id`,
    [input.actor.community_id, input.actor.user_id, body.title, body.category, body.summary, body.description, body.price_text, body.area_text, body.service_mode, JSON.stringify(body.contacts), now])).rows[0];
    return shown(q, input.actor, inserted.service_id as string);
  });
}

export async function editMemberService(pool: Pool, input: Command, id: string, now = new Date()) {
  const body = draft(input.body);
  return command(pool, input, q => owned(q, input.actor, id), async q => {
    const row = await owned(q, input.actor, id, true);
    visibleToOwner(row);
    checkVersion(row.aggregate_version, input.expected);
    await q.query(`UPDATE member_services SET title=$2,category=$3,summary=$4,description=$5,price_text=$6,area_text=$7,service_mode=$8,contacts=$9::jsonb,aggregate_version=aggregate_version+1,updated_at=$10 WHERE service_id=$1`,
      [id, body.title, body.category, body.summary, body.description, body.price_text, body.area_text, body.service_mode, JSON.stringify(body.contacts), now]);
    return shown(q, input.actor, id);
  });
}

async function setState(pool: Pool, input: Command, id: string, next: 'paused' | 'active', now: Date) {
  z.object({}).strict().parse(input.body ?? {});
  return command(pool, input, q => owned(q, input.actor, id), async q => {
    const row = await owned(q, input.actor, id, true);
    const from = next === 'paused' ? 'active' : 'paused';
    if (row.state !== from) {
      requireCondition(row.state === (next === 'paused' ? 'paused' : 'active'), 404, 'not_found', '找不到這項服務。');
      throw new Problem(409, 'member_service_state', '這項服務目前不能這樣變更。');
    }
    checkVersion(row.aggregate_version, input.expected);
    await q.query(`UPDATE member_services SET state=$2,aggregate_version=aggregate_version+1,updated_at=$3 WHERE service_id=$1`, [id, next, now]);
    return shown(q, input.actor, id);
  });
}
export const pauseMemberService = (pool: Pool, input: Command, id: string, now = new Date()) => setState(pool, input, id, 'paused', now);
export const resumeMemberService = (pool: Pool, input: Command, id: string, now = new Date()) => setState(pool, input, id, 'active', now);

export async function deleteMemberService(pool: Pool, input: Command, id: string, now = new Date()) {
  z.object({}).strict().parse(input.body ?? {});
  return command(pool, input, q => owned(q, input.actor, id), async q => {
    const row = await owned(q, input.actor, id, true);
    requireCondition(row.state !== 'hidden', 404, 'not_found', '找不到這項服務。');
    checkVersion(row.aggregate_version, input.expected);
    if (row.state !== 'deleted') {
      await q.query(`UPDATE member_services SET state='deleted',aggregate_version=aggregate_version+1,updated_at=$2 WHERE service_id=$1`, [id, now]);
      await q.query('DELETE FROM member_service_covers WHERE service_id=$1', [id]);
    }
    return view((await one(q, input.actor.community_id, input.actor.user_id, id))!, input.actor.user_id, false);
  });
}

export async function hideMemberService(pool: Pool, input: Command, id: string, now = new Date()) {
  z.object({}).strict().parse(input.body ?? {});
  const denied = async () => { requireCondition(await canHideMemberContent(pool, input.actor), 403, 'member_service_admin_required', '只有平台管理員能隱藏服務。'); };
  return command(pool, input, denied, async q => {
    requireCondition(await canHideMemberContent(q, input.actor), 403, 'member_service_admin_required', '只有平台管理員能隱藏服務。');
    const row = (await q.query(`SELECT state,aggregate_version::text AS aggregate_version FROM member_services WHERE service_id=$1 AND community_id=$2 FOR UPDATE`, [id, input.actor.community_id])).rows[0] as { state: string; aggregate_version: string } | undefined;
    requireCondition(row && row.state !== 'deleted', 404, 'not_found', '找不到這項服務。');
    checkVersion(row!.aggregate_version, input.expected);
    if (row!.state !== 'hidden') await q.query(`UPDATE member_services SET state='hidden',aggregate_version=aggregate_version+1,updated_at=$2 WHERE service_id=$1`, [id, now]);
    return shown(q, input.actor, id);
  });
}

export async function saveMemberServiceCover(pool: Pool, input: Command, id: string, file: { bytes: Buffer; mime: string }, now = new Date(), assets?:ServiceCoverAssetService) {
  const bytes=Buffer.from(snapshotBoundedBytes(file.bytes,4194304)),mime=file.mime;
  const sourceSha = createHash('sha256').update(bytes).digest('hex');
  const legacy={...input,actor:Object.freeze({...input.actor}),body:{sha256:sourceSha}};
  if(await serviceCoverStorageMode(pool)!=='legacy')return saveAssetCover(pool,legacy,id,{bytes,mime},assets);
  return command(pool, { ...input, body: { sha256: sourceSha } }, q => owned(q, input.actor, id), async q => {
    const row = await owned(q, input.actor, id, true);
    visibleToOwner(row);
    checkVersion(row.aggregate_version, input.expected);
    const image = await normalizeServiceCover(mime, bytes);
    await q.query(`INSERT INTO member_service_covers(service_id,image_bytes,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(service_id) DO UPDATE SET image_bytes=EXCLUDED.image_bytes,updated_at=EXCLUDED.updated_at`, [id, image, now]);
    await q.query('UPDATE member_services SET aggregate_version=aggregate_version+1,updated_at=$2 WHERE service_id=$1', [id, now]);
    return shown(q, input.actor, id);
  });
}

async function saveAssetCover(pool:Pool,input:Command,id:string,file:{bytes:Buffer;mime:string},assets?:ServiceCoverAssetService) {
 const authorize=async(q:PoolClient)=>{const row=await owned(q,input.actor,id);visibleToOwner(row);};
 const probe=async()=>{const miss=new Error('cover_receipt_miss');try{return await serviceCoverMemberCommand(pool,input,authorize,async()=>{throw miss;});}catch(error){if(error!==miss)throw error;return undefined;}};
 const replay=await probe();if(replay)return replay;
 requireCondition(assets,503,'media_upload_unavailable','內容上傳暫時無法使用。');
 if(input.expected===undefined)checkVersion('1',input.expected);
 const key=digest({operation:input.operation,key:input.key});
 try {
  const prepared=await assets!.prepare(input.actor,{key,targetServiceId:id,expectedVersion:input.expected!,contentType:file.mime as 'image/png'|'image/jpeg'|'image/webp',byteSize:file.bytes.length,sha256:(input.body as {sha256:string}).sha256});
  const lease=await assets!.resumeUpload(input.actor,{key,intentId:prepared.intentId});
  const binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  if(lease.state==='prepared'||lease.state==='processing')await assets!.write(input.actor,{...binding,key:digest({key,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(file.bytes);c.close();}}));
  let publicationClient:PoolClient;
  return await assets!.finalizeVia<Awaited<ReturnType<typeof shown>>>(input.actor,{...binding,key:digest({key,phase:'finalize'})},{operation:'member.service.cover.replace',
   execute:run=>serviceCoverMemberCommand(pool,input,authorize,async(q,context)=>{publicationClient=q;return run(q,context);}),
   validateIntent:row=>requireCondition(row.expected_version===input.expected&&row.target_service_id===id&&row.source_sha256===(input.body as {sha256:string}).sha256,409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),
   result:()=>shown(publicationClient,input.actor,id)});
 }catch(error){const committed=await probe();if(committed)return committed;if(error instanceof AssetStorageError)throw new Problem(503,'media_upload_unavailable','內容上傳暫時無法使用。');throw error;}
}

export async function removeMemberServiceCover(pool: Pool, input: Command, id: string, now = new Date()) {
  z.object({}).strict().parse(input.body ?? {});
  return command(pool, input, q => owned(q, input.actor, id), async q => {
    const row = await owned(q, input.actor, id, true);
    visibleToOwner(row);
    checkVersion(row.aggregate_version, input.expected);
    await q.query('DELETE FROM member_service_covers WHERE service_id=$1', [id]);
    await q.query('UPDATE member_services SET aggregate_version=aggregate_version+1,updated_at=$2 WHERE service_id=$1', [id, now]);
    return shown(q, input.actor, id);
  });
}

async function coverSnapshot(pool:Pool,communityId:string,id:string,actor?:Actor):Promise<DomainMediaSnapshot|undefined> {
 const row=(await pool.query(`SELECT s.aggregate_version::text AS version,s.state,u.active,is_verification_test_account(u.user_id) AS test_account,
 c.storage_source,c.image_bytes,t.asset_id,t.scope_id,o.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
 FROM member_service_covers c JOIN member_services s USING(service_id) JOIN users u ON u.user_id=s.owner_user_id
 LEFT JOIN member_service_cover_asset_targets t ON t.service_id=s.service_id AND t.linked_at_version<=s.aggregate_version
 LEFT JOIN assets a ON a.asset_id=t.asset_id AND a.state='ready' AND a.purpose='member.service-cover'
 LEFT JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='member.service-cover'
 WHERE s.service_id=$1 AND s.community_id=$2 AND ${actor?`((s.owner_user_id=$3 AND s.state IN ('active','paused')) OR (${PUBLIC_VISIBLE}))` : PUBLIC_VISIBLE}`,
 actor?[id,communityId,actor.user_id]:[id,communityId])).rows[0];
 if(!row)return undefined;
 return {purpose:'member.service-cover',targetId:id,variant:'cover',domainVersion:row.version,source:row.storage_source,
 authorizationVersion:JSON.stringify([row.state,row.active,row.test_account]),legacyBytes:row.image_bytes,
 assetId:row.asset_id,scopeId:row.scope_id,representationId:row.representation_id,
 metadata:row.representation_id?{contentType:row.content_type,byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision,profileId:row.profile_id}:null};
}
export async function readMemberCover(pool:Pool,actor:Actor,id:string,store?:ObjectStore) {
 return (await readDomainMedia(()=>coverSnapshot(pool,actor.community_id,id,actor),{purpose:'member.service-cover',targetId:id,variant:'cover'},store)).bytes;
}

export async function resolvePublicCommunity(pool: Pool, configured?: string) {
  if (configured && z.uuid().safeParse(configured).success) return configured;
  const rows = await pool.query('SELECT community_id::text AS id FROM communities ORDER BY community_id LIMIT 2');
  return rows.rowCount === 1 ? rows.rows[0].id as string : null;
}

export async function publicMemberCover(pool:Pool,communityId:string|null,id:string,store?:ObjectStore) {
 requireCondition(communityId&&z.uuid().safeParse(id).success,404,'not_found','找不到封面。');
 return (await readDomainMedia(()=>coverSnapshot(pool,communityId!,id),{purpose:'member.service-cover',targetId:id,variant:'cover'},store)).bytes;
}

export async function readMemberServiceShare(pool: Pool, communityId: string, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const row = (await pool.query(`SELECT s.title,s.summary,u.display_name AS owner_name,c.service_id IS NOT NULL AS has_cover
    FROM member_services s JOIN users u ON u.user_id=s.owner_user_id LEFT JOIN member_service_covers c ON c.service_id=s.service_id
    WHERE s.service_id=$1 AND s.community_id=$2 AND ${PUBLIC_VISIBLE}`, [id, communityId])).rows[0];
  return row ? { title: row.title as string, summary: row.summary as string, ownerName: row.owner_name as string, hasCover: Boolean(row.has_cover) } : null;
}

export async function readMemberServiceTitles(pool: Pool, communityId: string, ids: string[]) {
  const unique = [...new Set(ids.map(id => id.toLowerCase()))].filter(id => z.uuid().safeParse(id).success);
  if (!unique.length) return new Map<string, { title: string; available: boolean }>();
  const rows = (await pool.query(`SELECT s.service_id::text AS id,s.title,(s.state='active' AND u.active AND NOT is_verification_test_account(u.user_id)) AS available
    FROM member_services s JOIN users u ON u.user_id=s.owner_user_id WHERE s.community_id=$1 AND s.service_id=ANY($2::uuid[])`, [communityId, unique])).rows as { id: string; title: string; available: boolean }[];
  return new Map(rows.map(row => [row.id, { title: row.title, available: row.available }]));
}

const PUBLIC_LIST = `SELECT s.service_id::text,s.title,s.category,s.summary,s.price_text,s.area_text,u.display_name AS owner_name,
  c.service_id IS NOT NULL AS has_cover,s.updated_at,${UPDATED_CURSOR}
  FROM member_services s JOIN users u ON u.user_id=s.owner_user_id LEFT JOIN member_service_covers c ON c.service_id=s.service_id`;

function cardOf(row: { service_id: string; title: string; category: ServiceCategory; summary: string; price_text: string | null; area_text: string | null; owner_name: string; has_cover: boolean; updated_at: Date | string }): PublicServiceCard {
  return {
    service_id: row.service_id, title: row.title, category: row.category, summary: row.summary,
    price_text: row.price_text, area_text: row.area_text, owner_name: row.owner_name,
    has_cover: Boolean(row.has_cover), updated_at: iso(row.updated_at),
  };
}

export async function publicServiceListDocument(pool: Pool, communityId: string | null, origin: string, categoryRaw?: string, cursorRaw?: string, eligibleOnly=false) {
  const category = categoryOf(categoryRaw, false);
  const cursor = cursorOf(cursorRaw, false);
  if (!communityId) return serviceListHtml(origin, category, [], null, eligibleOnly);
  const rows = (await pool.query(`${PUBLIC_LIST} WHERE s.community_id=$1 AND ${PUBLIC_VISIBLE}${eligibleOnly?' AND u.community_id=s.community_id AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)':''}
    AND ($2::text IS NULL OR s.category=$2)
    AND ($3::timestamptz IS NULL OR (s.updated_at,s.service_id)<($3::timestamptz,$4::uuid))
    ORDER BY s.updated_at DESC,s.service_id DESC LIMIT 13`, [communityId, category || null, cursor?.updatedAt ?? null, cursor?.id ?? null])).rows as (Parameters<typeof cardOf>[0] & { updated_cursor: string })[];
  const pageRows = rows.slice(0, PUBLIC_PAGE);
  const last = pageRows.at(-1);
  return serviceListHtml(origin, category, pageRows.map(cardOf), rows.length > PUBLIC_PAGE && last ? encodeCursor(last.updated_cursor, last.service_id) : null, eligibleOnly);
}

export async function publicServiceDocument(pool: Pool, communityId: string | null, origin: string, id: string, discoveryEnabled=false) {
  const missing = { status: 404 as const, html: serviceMissingHtml(origin, discoveryEnabled) };
  if (!communityId || !z.uuid().safeParse(id).success) return missing;
  const row = (await pool.query(`SELECT s.service_id::text,s.title,s.category,s.summary,s.description,s.price_text,s.area_text,s.service_mode,s.contacts,
    u.display_name AS owner_name,c.service_id IS NOT NULL AS has_cover,s.updated_at
    FROM member_services s JOIN users u ON u.user_id=s.owner_user_id LEFT JOIN member_service_covers c ON c.service_id=s.service_id
    WHERE s.service_id=$1 AND s.community_id=$2 AND ${PUBLIC_VISIBLE}`, [id, communityId])).rows[0];
  if (!row) return missing;
  const service: PublicServicePage = { ...cardOf(row), description: row.description, service_mode: row.service_mode, contacts: row.contacts };
  return { status: 200 as const, html: serviceDetailHtml(origin, service, discoveryEnabled) };
}
