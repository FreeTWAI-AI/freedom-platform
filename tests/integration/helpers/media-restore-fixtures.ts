import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import sharp from 'sharp';
import {tokenHash,type Actor} from '../../../modules/identity-membership/service.js';
import {createPlatformApp} from '../../../apps/platform-api/src/platform-app.js';
import {nodeRuntime} from '../../../apps/platform-api/src/app.js';
import {createServiceCoverAssetService,resolveServiceCoverUploadPolicy} from '../../../modules/assets/media-domain.js';
import {createEventBannerAssetService,resolveEventBannerUploadPolicy} from '../../../modules/assets/event-banner.js';
import {createEventVideoAssetService,resolveEventVideoUploadPolicy} from '../../../modules/assets/event-video.js';
import {createSkillImageAssetService} from '../../../modules/assets/skill-image.js';
import {createSocialThumbnailAssetService,resolveSocialThumbnailUploadPolicy} from '../../../modules/assets/social-thumbnail.js';
import {createEventHighlightAssetService,resolveEventHighlightUploadPolicy} from '../../../modules/assets/event-highlight.js';
import type {ObjectStore} from '../../../packages/asset-storage/index.js';

export const origin='http://127.0.0.1:4310';
export function mediaApp(pool:Pool,store:ObjectStore,community:string){
 return createPlatformApp(pool,origin,'local',{...nodeRuntime('local',origin),registrationCommunityId:()=>community,
  avatarAssetStore:store,
  serviceCoverAssets:createServiceCoverAssetService(pool,{store,resolvePolicy:resolveServiceCoverUploadPolicy}),serviceCoverAssetStore:store,
  eventBannerAssets:createEventBannerAssetService(pool,{store,resolvePolicy:resolveEventBannerUploadPolicy}),eventBannerAssetStore:store,
  eventVideoAssets:createEventVideoAssetService(pool,{store,resolvePolicy:resolveEventVideoUploadPolicy}),eventVideoAssetStore:store,
  skillImageAssets:createSkillImageAssetService(pool,{store}),skillImageAssetStore:store,
  socialThumbnailAssets:createSocialThumbnailAssetService(pool,{store,resolvePolicy:resolveSocialThumbnailUploadPolicy}),socialThumbnailAssetStore:store,
  eventHighlightAssets:createEventHighlightAssetService(pool,{store,resolvePolicy:resolveEventHighlightUploadPolicy}),eventHighlightAssetStore:store,
  linkPreviewFetch:async()=>{throw Error('restore_fixture_must_not_fetch_outbound');},
 });
}
export interface RestoreMember {actor:Actor;token:string}
export async function restoreMember(pool:Pool,community:string):Promise<RestoreMember>{
 const id=randomUUID(),token=randomBytes(32).toString('base64url'),session=tokenHash(token);
 const user=(await pool.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic restore owner','not-a-login',$4) RETURNING *",[id,community,id+'@restore.invalid',randomUUID()])).rows[0];
 await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[session,id]);
 return {actor:{...user,session_hash:session,csrf_token:'synthetic'} as Actor,token};
}
export function memberHeaders(member:RestoreMember){return {Origin:origin,Cookie:'freedom_local_session='+member.token,'X-CSRF-Token':'synthetic'};}
export interface RestoredMediaRead {purpose:string;path:string;publicPath?:string;bytes:Buffer;dtoPath?:string;dto?:unknown}
export async function sevenMediaFixtures(owner:Pool,runtime:Pool,store:ObjectStore){
 const community=randomUUID();await owner.query("INSERT INTO communities VALUES($1,'Synthetic seven-media restore')",[community]);
 const member=await restoreMember(owner,community),other=await restoreMember(owner,community),app=mediaApp(runtime,store,community);
 await owner.query("UPDATE avatar_storage_policy SET mode='bridge',policy_revision='synthetic-restore-v1',persistence_allowed=true,retained_byte_limit=67108864");
 await owner.query("UPDATE domain_media_storage_policy SET mode='bridge',policy_revision='synthetic-restore-v1',persistence_allowed=true,retained_byte_limit=67108864");
 const png=await sharp({create:{width:30,height:40,channels:3,background:'purple'}}).png().toBuffer(),reads:RestoredMediaRead[]=[];
 async function command(path:string,body:BodyInit,type='application/json',method='POST',expected?:number,extra:Record<string,string>={},status=200){
  const result=await app.request(origin+path,{method,headers:{...memberHeaders(member),'Content-Type':type,'Idempotency-Key':randomUUID(),...(expected===undefined?{}:{'If-Match':'"'+expected+'"'}),...extra},body});
  assert.equal(result.status,status,await result.clone().text());return await result.json() as Record<string,any>;
 }
 async function capture(purpose:string,path:string,publicPath?:string,dtoPath?:string){
  const result=await app.request(origin+path,{headers:memberHeaders(member)});assert.equal(result.status,200,await result.clone().text());const bytes=Buffer.from(await result.arrayBuffer());
  let dto:unknown;if(dtoPath){const view=await app.request(origin+dtoPath,{headers:memberHeaders(member)});assert.equal(view.status,200,dtoPath+' '+await view.clone().text());dto=await view.json();}
  reads.push({purpose,path,publicPath,bytes,dtoPath,dto});
 }
 const avatar=await command('/api/v1/me/avatar',new Uint8Array(png),'image/png','POST',1);assert.equal(avatar.avatar_url,'/api/v1/members/'+member.actor.user_id+'/avatar?v=2');await capture('member.avatar',avatar.avatar_url,undefined,'/api/v1/me/avatar');
 const service=await command('/api/v1/member-services',JSON.stringify({title:'Synthetic restore service',category:'hair_beauty',summary:'Synthetic',description:'Owned fixture only',price_text:'Fixture',area_text:'Fixture',service_mode:'online',contacts:[{label:'Fixture',url:'https://example.invalid/contact'}]}),'application/json','POST',undefined,{},201);
 const cover=await command('/api/v1/member-services/'+service.service_id+'/cover',new Uint8Array(png),'image/png','PUT',1);assert.equal(cover.cover_url,'/api/v1/member-services/'+service.service_id+'/cover?v=2');await capture('member.service-cover',cover.cover_url,'/api/v1/public/member-services/'+service.service_id+'/cover','/api/v1/member-services/mine');
 const event=await command('/api/v1/events',JSON.stringify({title:'Synthetic restore event',description:'Owned fixture only',starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString(),mode:'online',location:'Synthetic',online_url:'https://example.invalid/event',event_kind:'other',visibility:'open',capacity:null}),'application/json','POST',undefined,{},201);
 const banner=await command('/api/v1/events/'+event.event_id+'/banner',new Uint8Array(png),'image/png','POST',1,{'X-Poster-Orientation':'portrait'});assert.equal(banner.banner_url,'/api/v1/events/'+event.event_id+'/banner?v=2');
 // Signature-only 20 MiB WebM fixture: storage/range/restore proof, not playback.
 const video=Buffer.alloc(20*1024*1024,0x31);video.set([0x1a,0x45,0xdf,0xa3]);
 const savedVideo=await command('/api/v1/events/'+event.event_id+'/video',new Uint8Array(video),'video/webm','POST',2);assert.equal(savedVideo.video_url,'/api/v1/events/'+event.event_id+'/video?v=3');
 await owner.query("UPDATE community_events SET state='published' WHERE event_id=$1",[event.event_id]);
 await capture('community.event-banner','/api/v1/events/'+event.event_id+'/banner?v=3','/api/v1/public/events/'+event.event_id+'/banner','/api/v1/events/'+event.event_id);
 await capture('community.event-video',savedVideo.video_url,'/api/v1/public/events/'+event.event_id+'/video','/api/v1/events/'+event.event_id);
 const draft=await command('/api/v1/me/skill-submissions','{}','application/json','POST',undefined,{},201),id=draft.submission.submission_id;
 const payload={repository_url:'https://github.com/example/project',title:'Synthetic restore skill',description:'Owned fixture',use_notes:'Read README',demo_url:null,relationship:'author',share_introductions:Array.from({length:100},(_,i)=>'Synthetic introduction number '+(i+1)),cover_image:{mime_type:'image/png',data_base64:png.toString('base64')}};
 const uploaded=await app.request(origin+'/agent-api/v1/skill-submissions/'+id,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+draft.upload_grant.token},body:JSON.stringify(payload)});assert.equal(uploaded.status,200,await uploaded.clone().text());
 await capture('skill.submission-image','/api/v1/me/skill-submissions/'+id+'/illustration',undefined,'/api/v1/me/skill-submissions/'+id);
 const socialId=randomUUID();await owner.query("INSERT INTO community_social_posts(post_id,community_id,author_user_id,url,platform,title,note,state) VALUES($1,$2,$3,'https://example.org/restore','other','Synthetic restore','Owned fixture','active')",[socialId,community,member.actor.user_id]);
 const social=await command('/api/v1/social-posts/'+socialId+'/thumbnail',new Uint8Array(png),'image/png','PUT');assert.equal(social.thumbnail_url,'/api/v1/social-posts/'+socialId+'/thumbnail');await capture('community.social-thumbnail',social.thumbnail_url,'/api/v1/public/social-posts/'+socialId+'/thumbnail','/api/v1/social-posts');
 const ended=randomUUID();await owner.query("INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'Synthetic ended','Owned fixture',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day','online','Synthetic','published','open','other')",[ended,community,other.actor.user_id]);
 const highlight=await command('/api/v1/event-highlights/'+ended+'/photos',new Uint8Array(png),'image/png','POST',undefined,{'X-Photo-Orientation':'landscape','X-Media-Title':'Synthetic restore pair'},201);
 assert.equal(highlight.image_url,'/api/v1/public/event-highlights/media/'+highlight.media_id+'/image');assert.equal(highlight.thumb_url,'/api/v1/public/event-highlights/media/'+highlight.media_id+'/thumb');
 await capture('community.event-highlight',highlight.image_url,highlight.image_url,'/api/v1/event-highlights/'+ended);await capture('community.event-highlight.thumbnail',highlight.thumb_url,highlight.thumb_url);
 assert.equal(reads.length,8);assert.equal(reads.find(r=>r.purpose==='community.event-video')!.bytes.length,20*1024*1024);
 const rows=(await owner.query("SELECT a.asset_id,a.purpose,a.scope_kind,a.community_ref,o.variant,o.profile_id,o.content_sha256,o.byte_size,o.object_key FROM assets a JOIN asset_objects o USING(asset_id) WHERE a.owner_user_id=$1 ORDER BY a.asset_id",[member.actor.user_id])).rows;
 assert.equal(rows.length,8);assert.deepEqual([...new Set(rows.map(r=>r.purpose))].sort(),['member.avatar','member.service-cover','community.event-banner','community.event-video','skill.submission-image','community.social-thumbnail','community.event-highlight'].sort());
 const pair=rows.filter(r=>r.purpose==='community.event-highlight').sort((a,b)=>a.variant.localeCompare(b.variant));assert.deepEqual(pair.map(r=>[r.variant,r.profile_id]),[['image','community.event-highlight'],['thumb','community.event-highlight.thumbnail']]);
 for(const read of reads){const purpose=read.purpose==='community.event-highlight.thumbnail'?'community.event-highlight':read.purpose;assert(rows.some(r=>r.purpose===purpose&&r.content_sha256===createHash('sha256').update(read.bytes).digest('hex')));}
 return {community,member,other,reads,rows};
}
