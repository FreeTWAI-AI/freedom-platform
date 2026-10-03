import { createHash } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { command,digest as commandDigest, type Command } from '../../packages/db/index.js';
import { socialThumbnailMemberCommand } from '../../packages/scoped-commands/index.js';
import { AssetStorageError,type ObjectStore } from '../../packages/asset-storage/index.js';
import { readDomainMedia,type DomainMediaSnapshot } from '../../packages/media-migration/domain-bridge.js';
import { socialThumbnailStorageMode,type SocialThumbnailAssetService } from '../assets/social-thumbnail.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { isOwnWorkshopHost, normalizeShareUrl, PLATFORM_LABELS, SOCIAL_PLATFORMS, type SocialPlatform } from '../../packages/shared/share-url.js';
import { normalizeSocialThumbnail } from '../skill-submissions/payload.js';
import { avatarUrl } from '../identity-membership/avatars.js';
import type { Actor } from '../identity-membership/service.js';
import { taipeiDayStart } from './promotion.js';
import type { LinkPreview } from './link-preview.js';
import { canHideMemberContent as canHideSocialPosts } from './moderation.js';
export { canHideSocialPosts };

export class SocialPostExists extends Error {
  readonly post_id: string;
  constructor(postId: string) { super('social_post_exists'); this.post_id = postId; }
}

const POST_CAP = 20;
const input = z.object({
  url: z.string().min(1).max(4096),
  title: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
}).strict();

type PostRow = {
  post_id: string; url: string; platform: SocialPlatform; title: string; note: string | null; created_at: Date | string;
  author_user_id: string; display_name: string; aggregate_version: string | null; has_avatar: boolean; test_account: boolean;
  has_thumbnail: boolean; total_points: number; my_points: number;
};

function view(row: PostRow, viewerId: string) {
  const created = new Date(row.created_at).toISOString();
  const showAvatar = row.has_avatar && (!row.test_account || row.author_user_id === viewerId);
  return {
    post_id: row.post_id, url: row.url, platform: row.platform, platform_label: PLATFORM_LABELS[row.platform] ?? '其他',
    title: row.title, note: row.note, created_at: created,
    author: { user_id: row.author_user_id, display_name: row.display_name, avatar_url: showAvatar ? avatarUrl(row.author_user_id, row.aggregate_version ?? 1, row.has_avatar) : null },
    thumbnail_url: row.has_thumbnail ? `/api/v1/social-posts/${row.post_id}/thumbnail` : null,
    total_points: Number(row.total_points) || 0, my_points: Number(row.my_points) || 0,
    mine: row.author_user_id === viewerId,
  };
}

const LIST = `SELECT p.post_id,p.url,p.platform,p.title,p.note,p.created_at,p.author_user_id,u.display_name,
  a.aggregate_version,a.present AS has_avatar,is_verification_test_account(u.user_id) AS test_account,t.post_id IS NOT NULL AS has_thumbnail,
  (SELECT count(*)::int FROM promotion_clicks c JOIN promotion_links l ON l.link_id=c.link_id WHERE l.kind='social_post' AND l.target_key=p.post_id::text) AS total_points,
  (SELECT count(*)::int FROM promotion_clicks c JOIN promotion_links l ON l.link_id=c.link_id WHERE l.kind='social_post' AND l.target_key=p.post_id::text AND l.user_id=$2) AS my_points
  FROM community_social_posts p
  JOIN users u ON u.user_id=p.author_user_id
  LEFT JOIN member_avatar_presence a ON a.user_id=u.user_id AND a.community_id=p.community_id
  LEFT JOIN community_social_post_thumbnails t ON t.post_id=p.post_id`;

function cursorOf(raw: string | undefined) {
  if (!raw) return null;
  let text = '';
  try { text = Buffer.from(raw, 'base64url').toString('utf8'); } catch { throw new Problem(422, 'invalid_cursor', '分頁標記不正確。'); }
  const split = text.split('\n');
  const createdAt = split[0] ?? '', id = split[1] ?? '';
  requireCondition(!Number.isNaN(Date.parse(createdAt)) && z.uuid().safeParse(id).success, 422, 'invalid_cursor', '分頁標記不正確。');
  return { createdAt, id };
}

export async function listSocialPosts(pool: Pool, actor: Actor, query: { platform?: string; cursor?: string }) {
  const platform = query.platform ?? '';
  requireCondition(platform === '' || (SOCIAL_PLATFORMS as readonly string[]).includes(platform), 422, 'validation_failed', '平台篩選不正確。');
  const cursor = cursorOf(query.cursor);
  const platforms = platform === 'other' ? ['threads', 'tiktok', 'x', 'other'] : platform ? [platform] : null;
  const rows = (await pool.query(`${LIST}
    WHERE p.community_id=$1 AND p.state='active'
      AND ($3::text[] IS NULL OR p.platform=ANY($3::text[]))
      AND ($4::timestamptz IS NULL OR (p.created_at,p.post_id)<($4::timestamptz,$5::uuid))
    ORDER BY p.created_at DESC,p.post_id DESC LIMIT 25`, [actor.community_id, actor.user_id, platforms, cursor?.createdAt ?? null, cursor?.id ?? null])).rows as PostRow[];
  const page = rows.slice(0, 24).map(row => view(row, actor.user_id));
  const last = page.at(-1);
  return { items: page, next_cursor: rows.length > 24 && last ? Buffer.from(`${last.created_at}\n${last.post_id}`).toString('base64url') : null, can_hide: await canHideSocialPosts(pool, actor) };
}

export function socialPostDraft(raw: unknown, publicOrigin: string) {
  const body = input.parse(raw);
  const normalized = normalizeShareUrl(body.url);
  requireCondition(normalized.ok, 422, 'social_post_url', '這個網址不能分享。');
  requireCondition(!isOwnWorkshopHost(normalized.host, publicOrigin), 422, 'social_post_url', '請分享社群平台上的貼文。');
  const submitted = body.title?.trim() ?? '';
  requireCondition(submitted.length <= 120, 422, 'validation_failed', '標題請在 120 字以內。');
  requireCondition(!/[\u0000-\u001f\u007f]/.test(submitted), 422, 'validation_failed', '標題含有無法使用的字元。');
  const note = body.note?.trim() ? body.note.trim() : null;
  requireCondition(!note || note.length <= 500, 422, 'validation_failed', '說明請在 500 字以內。');
  return { normalized, submitted, note };
}

export async function activeSocialPostId(pool: Pool, communityId: string, url: string) {
  const row = (await pool.query(`SELECT post_id FROM community_social_posts WHERE community_id=$1 AND url=$2 AND state='active'`, [communityId, url])).rows[0];
  return (row?.post_id as string | undefined) ?? null;
}

function prepared(raw: unknown, preview: LinkPreview, publicOrigin: string) {
  const draft = socialPostDraft(raw, publicOrigin);
  const title = (draft.submitted || preview.title || draft.normalized.host).slice(0, 120);
  requireCondition(title.length >= 1, 422, 'validation_failed', '請填寫標題。');
  return { normalized: draft.normalized, title, note: draft.note };
}

export async function createSocialPost(pool: Pool, inputCommand: Command, preview: LinkPreview, now = new Date(), publicOrigin = 'https://freetwai.com') {
  const draft = prepared(inputCommand.body, preview, publicOrigin);
  try {
    return await command(pool, inputCommand, async () => {}, async q => {
      const existing = (await q.query(`SELECT post_id FROM community_social_posts WHERE community_id=$1 AND url=$2 AND state='active'`, [inputCommand.actor.community_id, draft.normalized.url])).rows[0];
      if (existing) throw new SocialPostExists(existing.post_id as string);
      const used = (await q.query('SELECT count(*)::int AS n FROM community_social_posts WHERE author_user_id=$1 AND created_at>=$2', [inputCommand.actor.user_id, taipeiDayStart(now)])).rows[0].n as number;
      requireCondition(used < POST_CAP, 429, 'social_post_limit', '今天分享的貼文已達上限。');
      const row = (await q.query(`INSERT INTO community_social_posts(community_id,author_user_id,url,platform,title,note,state,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'active',$7,$7) RETURNING post_id,created_at`, [inputCommand.actor.community_id, inputCommand.actor.user_id, draft.normalized.url, draft.normalized.platform, draft.title, draft.note, now])).rows[0];
      if (preview.image && preview.source) await q.query(`INSERT INTO community_social_post_thumbnails(post_id,image_bytes,source,updated_at) VALUES($1,$2,$3,$4)`, [row.post_id, preview.image, preview.source, now]);
      const loaded = (await q.query(`${LIST} WHERE p.community_id=$1 AND p.post_id=$3`, [inputCommand.actor.community_id, inputCommand.actor.user_id, row.post_id])).rows[0] as PostRow;
      return view(loaded, inputCommand.actor.user_id);
    });
  } catch (error) {
    if (error instanceof SocialPostExists) throw error;
    const pg = error as { code?: string };
    if (pg.code === '23505') {
      const existing = (await pool.query(`SELECT post_id FROM community_social_posts WHERE community_id=$1 AND url=$2 AND state='active'`, [inputCommand.actor.community_id, draft.normalized.url])).rows[0];
      if (existing) throw new SocialPostExists(existing.post_id as string);
    }
    throw error;
  }
}

async function owned(q: Pick<Pool, 'query'>, actor: Actor, id: string, lock = false) {
  const row = (await q.query(`SELECT post_id,author_user_id,state,media_version FROM community_social_posts WHERE post_id=$1 AND community_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, actor.community_id])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這則貼文。');
  requireCondition(row.author_user_id === actor.user_id, 403, 'author_required', '只能管理自己分享的貼文。');
  return row as { post_id: string; state: string;media_version:string };
}

export async function authorizeSocialThumbnailWrite(q:Pick<Pool,'query'>,actor:Actor,id:string,lock=false){
 const row=await owned(q,actor,id,lock);requireCondition(row.state==='active',404,'not_found','找不到這則貼文。');return row;
}
async function shownSocial(q:Pick<Pool,'query'>,actor:Actor,id:string){const row=(await q.query(`${LIST} WHERE p.community_id=$1 AND p.post_id=$3`,[actor.community_id,actor.user_id,id])).rows[0] as PostRow;return view(row,actor.user_id);}
export async function deleteSocialPost(pool: Pool, inputCommand: Command, id: string, now = new Date()) {
  z.object({}).strict().parse(inputCommand.body ?? {});
  return command(pool, inputCommand, q => owned(q, inputCommand.actor, id), async q => {
    const row = await owned(q, inputCommand.actor, id, true);
    if (row.state !== 'deleted') await q.query(`UPDATE community_social_posts SET state='deleted',updated_at=$2 WHERE post_id=$1`, [id, now]);
    return { post_id: id, state: 'deleted' as const };
  });
}

export async function hideSocialPost(pool: Pool, inputCommand: Command, id: string, now = new Date()) {
  z.object({}).strict().parse(inputCommand.body ?? {});
  return command(pool, inputCommand, async () => { requireCondition(await canHideSocialPosts(pool, inputCommand.actor), 403, 'social_post_admin_required', '只有平台管理員能隱藏貼文。'); }, async q => {
    requireCondition(await canHideSocialPosts(pool, inputCommand.actor), 403, 'social_post_admin_required', '只有平台管理員能隱藏貼文。');
    const row = (await q.query(`SELECT post_id,state FROM community_social_posts WHERE post_id=$1 AND community_id=$2 FOR UPDATE`, [id, inputCommand.actor.community_id])).rows[0];
    requireCondition(row && row.state !== 'deleted', 404, 'not_found', '找不到這則貼文。');
    if (row.state !== 'hidden') await q.query(`UPDATE community_social_posts SET state='hidden',updated_at=$2 WHERE post_id=$1`, [id, now]);
    return { post_id: id, state: 'hidden' as const };
  });
}

export async function saveSocialThumbnail(pool: Pool, inputCommand: Command, id: string, file: { bytes: Buffer; mime: string }, now = new Date(),assets?:SocialThumbnailAssetService) {
  const bytes=Buffer.from(file.bytes);file={bytes,mime:file.mime};
  const digest = createHash('sha256').update(bytes).digest('hex');
  const commandInput = { ...inputCommand,actor:Object.freeze({...inputCommand.actor}), body: { sha256: digest } };
  if(await socialThumbnailStorageMode(pool)!=='legacy')return saveAssetSocialThumbnail(pool,commandInput,id,file,assets);
  return command(pool, commandInput, q => owned(q, inputCommand.actor, id), async q => {
    const row = await owned(q, inputCommand.actor, id, true);
    requireCondition(row.state === 'active', 404, 'not_found', '找不到這則貼文。');
    const image = await normalizeSocialThumbnail(file.mime, file.bytes);
    await q.query(`INSERT INTO community_social_post_thumbnails(post_id,image_bytes,source,updated_at) VALUES($1,$2,'upload',$3)
      ON CONFLICT(post_id) DO UPDATE SET image_bytes=EXCLUDED.image_bytes,source='upload',updated_at=EXCLUDED.updated_at`, [id, image, now]);
    const loaded = (await q.query(`${LIST} WHERE p.community_id=$1 AND p.post_id=$3`, [inputCommand.actor.community_id, inputCommand.actor.user_id, id])).rows[0] as PostRow;
    return view(loaded, inputCommand.actor.user_id);
  });
}

async function saveAssetSocialThumbnail(pool:Pool,input:Command,id:string,file:{bytes:Buffer;mime:string},assets?:SocialThumbnailAssetService){
 const authorize=(q:PoolClient)=>owned(q,input.actor,id);
 const probe=async()=>{const miss=new Error('social_thumbnail_receipt_miss');try{return await socialThumbnailMemberCommand(pool,input,authorize,async()=>{throw miss;});}catch(error){if(error!==miss)throw error;return undefined;}};
 const prior=await probe();if(prior)return prior;
 requireCondition(assets,503,'media_upload_unavailable','內容上傳暫時無法使用。');
 const key=commandDigest({operation:input.operation,key:input.key}),post=await authorizeSocialThumbnailWrite(pool,input.actor,id),expectedVersion=post.media_version;
 try{
  const prepared=await assets.prepare(input.actor,{key,targetPostId:id,expectedVersion,contentType:file.mime as 'image/png'|'image/jpeg'|'image/webp',byteSize:file.bytes.length,sha256:(input.body as {sha256:string}).sha256});
  const lease=await assets.resumeUpload(input.actor,{key,intentId:prepared.intentId}),binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  if(lease.state==='prepared'||lease.state==='processing')await assets.write(input.actor,{...binding,key:commandDigest({key,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(file.bytes);c.close();}}));
  let publicationClient:PoolClient;
  return await assets.finalizeVia<Awaited<ReturnType<typeof shownSocial>>>(input.actor,{...binding,key:commandDigest({key,phase:'finalize'})},{operation:'community.social.thumbnail.replace',
   execute:run=>socialThumbnailMemberCommand(pool,input,authorize,async(q,context)=>{publicationClient=q;return run(q,context);}),
   validateIntent:row=>requireCondition(row.target_post_id===id&&row.source_sha256===(input.body as {sha256:string}).sha256&&row.source_content_type===file.mime,409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),
   result:()=>shownSocial(publicationClient,input.actor,id)});
 }catch(error){const committed=await probe();if(committed)return committed;if(error instanceof AssetStorageError)throw new Problem(503,'media_upload_unavailable','內容上傳暫時無法使用。');throw error;}
}
async function socialThumbnailSnapshot(pool:Pool,id:string,actor?:Actor):Promise<DomainMediaSnapshot|undefined>{
 const row=(await pool.query(`SELECT p.media_version,p.state,p.community_id,t.storage_source,t.image_bytes,a.asset_id,a.scope_id,o.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
 FROM community_social_post_thumbnails t JOIN community_social_posts p USING(post_id)
 LEFT JOIN community_social_thumbnail_asset_targets a USING(post_id) LEFT JOIN asset_objects o ON o.asset_id=a.asset_id
 WHERE p.post_id=$1 AND p.state='active' AND ($5::boolean OR p.community_id=$2)
 AND ($5::boolean OR t.storage_source='legacy' OR EXISTS(SELECT 1 FROM sessions s JOIN users u USING(user_id) WHERE s.token_hash=$3 AND s.user_id=$4 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.active AND u.community_id=p.community_id))`,[id,actor?.community_id??null,actor?.session_hash??null,actor?.user_id??null,actor===undefined])).rows[0];
 if(!row)return;return {purpose:'community.social-thumbnail',targetId:id,variant:'thumbnail',domainVersion:row.media_version,authorizationVersion:JSON.stringify([row.state,row.community_id]),source:row.storage_source,legacyBytes:row.image_bytes,legacyContentType:'image/webp',assetId:row.asset_id,scopeId:row.scope_id,representationId:row.representation_id,metadata:row.profile_id?{profileId:row.profile_id,contentType:row.content_type,byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision}:null};
}
export async function readSocialThumbnail(pool:Pool,actor:Actor,id:string,store?:ObjectStore){
 try{return (await readDomainMedia(()=>socialThumbnailSnapshot(pool,id,actor),{purpose:'community.social-thumbnail',targetId:id,variant:'thumbnail'},store)).bytes;}catch(error){if(error instanceof Problem&&error.status===404&&error.code==='media_not_found')throw new Problem(404,'not_found','找不到縮圖。');throw error;}
}
export async function publicSocialThumbnail(pool:Pool,id:string,store?:ObjectStore){
 try{return (await readDomainMedia(()=>socialThumbnailSnapshot(pool,id),{purpose:'community.social-thumbnail',targetId:id,variant:'thumbnail'},store)).bytes;}catch(error){if(error instanceof Problem&&error.status===404&&error.code==='media_not_found')throw new Problem(404,'not_found','找不到縮圖。');throw error;}
}
