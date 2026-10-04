import {
  createHash,randomUUID
} from 'node:crypto';
import {
  z
} from 'zod';
import type {
  Pool,PoolClient
} from 'pg';
import {
  validateInventoryTarget,type InventoryTarget
} from './inventory.js';
import {
  objectKey,prepareLegacyMediaRepresentation,writeVerifiedObject,verifyObject,type ObjectStore,type ObjectMetadata
} from '../asset-storage/index.js';
const uuid=z.string().uuid(),name=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const input=z.object({
  target:z.unknown(),jobId:uuid,logicalStore:z.literal('MEDIA'),storeBindingId:name,migrationId:name.min(8),purpose:z.enum(['member.service-cover','community.event-video']),maxRows:z.number().int().min(1).max(16),maxBytes:z.number().int().min(3145728).max(134217728),leaseSeconds:z.number().int().min(1).max(60)
}).strict();
export interface OperatorBackfillPlan {
  target:InventoryTarget;
  jobId:string;
  logicalStore:'MEDIA';
  storeBindingId:string;
  migrationId:string;
  purpose:'member.service-cover'|'community.event-video';
  maxRows:number;
  maxBytes:number;
  leaseSeconds:number;
  planSha256:string
}
async function bounded<T>(operation:Promise<T>,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([operation,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new OperatorBackfillError()),ms);
    })]);
  }finally{
    clearTimeout(timer);
  }
}
/** Timed GET cancels late/blocked bodies; immutable PUT may finish late and
 * remains unknown, therefore the durable common-intent fence is still required. */
function deadlineStore(store:ObjectStore,deadline:number):ObjectStore {
  const remaining=()=>{const ms=deadline-Date.now();require(ms>0);return ms;};
  return {
    putImmutable:(key,value)=>bounded(store.putImmutable(key,value),remaining()),
    async get(key,range){
      require(range===undefined);
      const request=store.get(key);let object;
      try{object=await bounded(request,remaining());}
      catch{void request.then(o=>o?.body.cancel()).catch(()=>{});throw new OperatorBackfillError();}
      if(!object)return null;
      const reader=object.body.getReader();
      const body=new ReadableStream<Uint8Array>({
        async pull(controller){
          try{const part=await bounded(reader.read(),remaining());if(part.done){controller.close();reader.releaseLock();}else controller.enqueue(part.value);}
          catch{await reader.cancel().catch(()=>{});controller.error(new OperatorBackfillError());}
        },
        cancel:()=>reader.cancel(),
      },{highWaterMark:0});
      return {...object,body};
    },
    head:key=>bounded(store.head(key),remaining()),
    async delete(){throw new OperatorBackfillError();},
  };
}
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export class OperatorBackfillError extends Error{
  constructor(){
    super('operator media backfill is unavailable');
    this.name='OperatorBackfillError';
  }
}
const require:(condition:unknown)=>asserts condition=(condition:unknown)=>{
  if(!condition)throw new OperatorBackfillError();
};
export function planOperatorBackfill(raw:unknown):OperatorBackfillPlan{
  try{
    const p=input.parse(raw),target=validateInventoryTarget(p.target);
    require(p.purpose==='member.service-cover'?p.maxBytes<=8388608:p.maxRows===1&&p.maxBytes>=125829120);
    require(/^(fp_media_migrator_[a-z0-9_]+|freedom_media_migrator)$/.test(target.role));
    const canonical={
      target,jobId:p.jobId,logicalStore:p.logicalStore,storeBindingId:p.storeBindingId,migrationId:p.migrationId,purpose:p.purpose,maxRows:p.maxRows,maxBytes:p.maxBytes,leaseSeconds:p.leaseSeconds
    };
    return Object.freeze({
      ...canonical,planSha256:hash(JSON.stringify(canonical))
    });
  }catch{
    throw new OperatorBackfillError();
  }
}
const commonTables=['media_backfill_operator_policy','media_backfill_jobs','media_backfill_items','media_backfill_audit','users','principals','resource_scopes','domain_media_storage_policy','assets','asset_objects','asset_upload_intents'];
const profiles=Object.freeze({
 'member.service-cover':Object.freeze({max:524288,variant:'cover',scope:'personal',domain:'member_services',id:'service_id',bytesTable:'member_service_covers',bytesColumn:'image_bytes',targetTable:'member_service_cover_asset_targets',intentTarget:'target_service_id',cursor:'after_service_id',item:'service_id',consent:'lock_media_backfill_cover_consent',publish:'publish_media_backfill_cover'}),
 'community.event-video':Object.freeze({max:20971520,variant:'video',scope:'community',domain:'community_events',id:'event_id',bytesTable:'community_event_videos',bytesColumn:'media_bytes',targetTable:'community_event_video_asset_targets',intentTarget:'target_video_event_id',cursor:'after_event_id',item:'event_id',consent:'lock_media_backfill_video_consent',publish:'publish_media_backfill_video'}),
});
type Lease={
  fence:string;
  token:string
};
type Source={target_id:string;owner_user_id:string;community_id:string;state:string;aggregate_version:string;bytes:Buffer;content_type:'image/webp'|'video/mp4'|'video/webm';storage_source:string;principal_id:string;scope_id:string;source_sha256:string;binding:string};
/** Trusted host installation only. No member Actor/session/receipt is constructed.
 * Every publication uses the existing typed target, intent and immutable object.
 * Each SQL phase is a fresh transaction; no transaction spans ObjectStore I/O. */
export function createOperatorMediaBackfill(pool:Pool,installation:{
  store:ObjectStore;
  logicalStore:'MEDIA';
  storeBindingId:string
}){
  async function tx<T>(p:OperatorBackfillPlan,fn:(q:PoolClient,policy:any)=>Promise<T>,proof:{job?:Lease;intent?:{intent_id:string;fence:string;lease_token:string};allowExpiredJob?:boolean}={}):Promise<T>{
    const q=await pool.connect();
    try{
      await q.query('BEGIN');
      await q.query("SELECT set_config('search_path',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','5000',true)",[p.target.schema]);
      const identity=(await q.query('SELECT current_database() AS db,current_schema() AS schema,current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      require(identity?.db===p.target.database&&identity.schema===p.target.schema&&identity.role===p.target.role&&!identity.rolsuper&&!identity.rolbypassrls);
      const profile=profiles[p.purpose],tables=[...commonTables,profile.domain,profile.bytesTable,profile.targetTable];
      const shapes=(await q.query("SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p') AND NOT c.relrowsecurity",[p.target.schema,tables])).rows;
      require(shapes.length===tables.length);
      const policy=(await q.query(`SELECT * FROM lock_media_backfill_operator_approval($9) WHERE role_name=current_user AND environment=$1 AND database_name=$2 AND schema_name=$3 AND release_sha=$4 AND logical_store=$5 AND store_binding_id=$6 AND migration_id=$7 AND purpose=$8 AND approved_plan_sha256=$9 AND allowed AND expires_at>clock_timestamp()`,[p.target.environment,p.target.database,p.target.schema,p.target.releaseSha,p.logicalStore,p.storeBindingId,p.migrationId,p.purpose,p.planSha256])).rows[0];
      require(policy&&installation.logicalStore===p.logicalStore&&installation.storeBindingId===p.storeBindingId);
      const result=await fn(q,policy);
      await q.query('SET CONSTRAINTS ALL IMMEDIATE');
      // Last SQL decision clock: no publication/audit lock wait may occur after
      // this check. All referenced approval/job/intent rows are already locked.
      const output=result as {fence?:string;token?:string;lease?:{intent_id:string;fence:string;lease_token:string}}|null;
      const jobProof=proof.job??(output?.fence&&output.token?{fence:output.fence,token:output.token}:undefined);
      const intentProof=proof.intent??output?.lease;
      const clock=(await q.query(`SELECT p.allowed AND p.expires_at>clock_timestamp()
        AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM media_backfill_jobs j WHERE j.job_id=$2 AND j.policy_id=p.policy_id AND j.plan_sha256=$3 AND j.fence=$4 AND j.lease_token=$5 AND ($9::boolean OR j.lease_expires_at>clock_timestamp())))
        AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM asset_upload_intents i WHERE i.intent_id=$6 AND i.fence=$7 AND i.lease_token=$8 AND i.expires_at>clock_timestamp() AND i.lease_expires_at>clock_timestamp())) AS live
        FROM media_backfill_operator_policy p WHERE p.policy_id=$1`,[policy.policy_id,jobProof?p.jobId:null,p.planSha256,jobProof?.fence??null,jobProof?.token??null,intentProof?.intent_id??null,intentProof?.fence??null,intentProof?.lease_token??null,proof.allowExpiredJob===true])).rows[0];
      require(clock?.live);
      await q.query('COMMIT');
      return result;
    }catch{
      await q.query('ROLLBACK').catch(()=>{
      });
      throw new OperatorBackfillError();
    }finally{
      q.release();
    }
  }
  async function job(q:PoolClient,p:OperatorBackfillPlan,lease:Lease){
    const row=(await q.query('SELECT * FROM media_backfill_jobs WHERE job_id=$1 AND plan_sha256=$2 AND fence=$3 AND lease_token=$4 AND lease_expires_at>clock_timestamp() FOR UPDATE',[p.jobId,p.planSha256,lease.fence,lease.token])).rows[0];
    require(row&&!row.completed);
    return row;
  }
  async function audit(q:PoolClient,p:OperatorBackfillPlan,l:Lease,event:string,id:string|null=null){
    await q.query(`INSERT INTO media_backfill_audit(job_id,${profiles[p.purpose].item},event,operator_role,job_fence) VALUES($1,$2,$3,current_user,$4)`,[p.jobId,id,event,l.fence]);
  }
  async function source(q:PoolClient,id:string,p:OperatorBackfillPlan):Promise<Source|null>{
    const video=p.purpose==='community.event-video',profile=profiles[p.purpose];
    const hint=(await q.query(video?'SELECT organizer_ref AS owner_user_id FROM community_events WHERE event_id=$1':'SELECT owner_user_id FROM member_services WHERE service_id=$1',[id])).rows[0];if(!hint)return null;
    const authority=(await q.query(video?'SELECT * FROM lock_media_backfill_video_organizer($1,$2)':'SELECT * FROM lock_media_backfill_cover_owner($1,$2)',[p.planSha256,video?id:hint.owner_user_id])).rows[0];if(!authority)return null;
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset.quota/v1/${authority.scope_id}/${p.purpose}`]);
    const row=(await q.query(video?'SELECT event_id AS target_id,organizer_ref AS owner_user_id,community_id,state,aggregate_version FROM community_events WHERE event_id=$1 AND organizer_ref=$2 FOR UPDATE':"SELECT service_id AS target_id,owner_user_id,community_id,state,aggregate_version FROM member_services WHERE service_id=$1 AND owner_user_id=$2 AND state IN ('active','paused') FOR UPDATE",[id,hint.owner_user_id])).rows[0];if(!row)return null;
    const content=(await q.query(video?"SELECT CASE WHEN octet_length(media_bytes) BETWEEN 1 AND 20971520 THEN media_bytes END AS bytes,mime_type AS content_type,storage_source FROM community_event_videos WHERE event_id=$1 FOR UPDATE":"SELECT CASE WHEN octet_length(image_bytes) BETWEEN 1 AND 524288 THEN image_bytes END AS bytes,'image/webp'::text AS content_type,storage_source FROM member_service_covers WHERE service_id=$1 FOR UPDATE",[id])).rows[0];if(!content?.bytes)return null;
    if(video&&(content.content_type==='video/mp4'?content.bytes.length<12||content.bytes.toString('ascii',4,8)!=='ftyp':content.content_type!=='video/webm'||content.bytes.length<4||!content.bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))))return null;
    const sha=hash(content.bytes),fields=[row.target_id,row.owner_user_id,row.community_id,row.state,row.aggregate_version,authority.principal_id,authority.scope_id,sha,content.bytes.length];if(video)fields.push(content.content_type);
    return {...row,...content,principal_id:authority.principal_id,scope_id:authority.scope_id,source_sha256:sha,binding:hash(fields.join('|'))};
  }
  async function consent(q:PoolClient,p:OperatorBackfillPlan,pinned?:string){
    const policy=(await q.query(`SELECT * FROM ${profiles[p.purpose].consent}($1)`,[p.planSha256])).rows[0];
    require(policy?.mode==='bridge'&&policy.persistence_allowed&&policy.policy_revision&&policy.retained_byte_limit&&(!pinned||policy.policy_revision===pinned));
    return policy;
  }
  async function capacity(q:PoolClient,p:OperatorBackfillPlan,s:Source,policy:any,reserve=0){const profile=profiles[p.purpose],video=p.purpose==='community.event-video';
    const used=(await q.query(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,${profile.max})::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE ${video?'a.scope_id':'a.owner_user_id'}=$1 AND a.purpose=$2`,[video?s.scope_id:s.owner_user_id,p.purpose])).rows[0];
    const legacy=(await q.query(video?'SELECT COALESCE(sum(octet_length(c.media_bytes)),0) AS used FROM community_event_videos c JOIN community_events e USING(event_id) WHERE e.community_id=$1':'SELECT COALESCE(sum(octet_length(c.image_bytes)),0) AS used FROM member_service_covers c JOIN member_services s USING(service_id) WHERE s.owner_user_id=$1',[video?s.community_id:s.owner_user_id])).rows[0];require(BigInt(used.used)+BigInt(legacy.used)+BigInt(reserve)<=BigInt(policy.retained_byte_limit));
  }
  async function matches(q:PoolClient,item:any,p:OperatorBackfillPlan){
    const s=await source(q,item.target_id,p);
    return s&&s.storage_source==='legacy'&&s.aggregate_version===item.source_version&&s.bytes.length===item.source_size&&s.source_sha256===item.source_sha256&&s.binding===item.source_binding_sha256&&s.content_type===item.source_content_type?s:null;
  }
  async function finishStale(q:PoolClient,p:OperatorBackfillPlan,l:Lease,item:any){
    await q.query("UPDATE media_backfill_items SET outcome='stale',finished_at=clock_timestamp() WHERE job_id=$1 AND target_id=$2 AND outcome='pending'",[p.jobId,item.target_id]);
    await q.query(`UPDATE media_backfill_jobs SET ${profiles[p.purpose].cursor}=$2 WHERE job_id=$1`,[p.jobId,item.target_id]);
    await audit(q,p,l,'stale',item.target_id);
  }
  async function outcomes(p:OperatorBackfillPlan){return tx(p,async q=>{const row=(await q.query("SELECT count(*) FILTER(WHERE event='blocked_source')::int AS blocked,count(*) FILTER(WHERE event='stale')::int AS stale FROM media_backfill_audit WHERE job_id=$1",[p.jobId])).rows[0],profile=profiles[p.purpose];const remaining=(await q.query(`SELECT EXISTS(SELECT 1 FROM ${profile.bytesTable} WHERE storage_source='legacy') AS remaining`)).rows[0].remaining;return {blocked:Number(row.blocked),stale:Number(row.stale),remainingLegacy:remaining===true};});}
  async function run(raw:unknown){
    let p:OperatorBackfillPlan;
    try{
      const candidate=raw as OperatorBackfillPlan;
      if(candidate?.planSha256){
        const {
          planSha256,...body
        }=candidate;
        p=planOperatorBackfill(body);
        require(p.planSha256===planSha256);
      }else p=planOperatorBackfill(raw);
    }catch{
      throw new OperatorBackfillError();
    }try{
      const claimed=await tx(p,async(q,policy)=>{
        await q.query('INSERT INTO media_backfill_jobs(job_id,policy_id,plan_sha256,max_rows,max_bytes,purpose) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[p.jobId,policy.policy_id,p.planSha256,p.maxRows,p.maxBytes,p.purpose]);
        const row=(await q.query('SELECT * FROM media_backfill_jobs WHERE job_id=$1 FOR UPDATE',[p.jobId])).rows[0];
        require(row?.plan_sha256===p.planSha256&&row.policy_id===policy.policy_id);
        if(row.completed)return null;
        const updated=(await q.query('UPDATE media_backfill_jobs SET fence=fence+1,lease_token=$2,lease_expires_at=clock_timestamp()+make_interval(secs=>$3) WHERE job_id=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING fence,lease_token',[p.jobId,randomUUID(),p.leaseSeconds])).rows[0];
        require(updated);
        const l={
          fence:updated.fence,token:updated.lease_token
        };
        await audit(q,p,l,'claimed');
        return l;
      });
      if(!claimed){const counts=await outcomes(p);return {status:counts.blocked?'blocked':'complete',jobId:p.jobId,linked:0,...counts,allSourcesMigrated:counts.blocked===0&&counts.stale===0&&!counts.remainingLegacy,sourcePreserved:true};}
      const l=claimed;
      let linked=0,stale=0,bytes=0,complete=false;
      for(let n=0;
      n<Math.min(p.maxRows,Math.floor(p.maxBytes/(profiles[p.purpose].max*6)));
      n++){
        const next=await tx(p,async(q)=>{
          const j=await job(q,p,l);
          const pending=(await q.query("SELECT * FROM media_backfill_items WHERE job_id=$1 AND outcome='pending' ORDER BY target_id LIMIT 1",[p.jobId])).rows[0];
          if(pending)return pending;
          const profile=profiles[p.purpose],video=p.purpose==='community.event-video';
          const candidate=(await q.query(`SELECT s.${profile.id} AS target_id FROM ${profile.domain} s JOIN ${profile.bytesTable} c USING(${profile.id}) WHERE c.storage_source='legacy' AND ($1::uuid IS NULL OR s.${profile.id}>$1) ORDER BY s.${profile.id} LIMIT 1`,[j[profile.cursor]])).rows[0];
          if(!candidate){await q.query('UPDATE media_backfill_jobs SET completed=true WHERE job_id=$1',[p.jobId]);await audit(q,p,l,'complete');return null;}
          const s=await source(q,candidate.target_id,p);
          if(!s&&video){await q.query(`UPDATE media_backfill_jobs SET ${profile.cursor}=$2 WHERE job_id=$1`,[p.jobId,candidate.target_id]);await audit(q,p,l,'blocked_source',candidate.target_id);return {blocked:true,target_id:candidate.target_id};}
          require(s&&s.storage_source==='legacy');
          const policy=await consent(q,p);
          await capacity(q,p,s,policy,profile.max);
          const asset=randomUUID(),intent=randomUUID(),representation=randomUUID();
          await q.query(`INSERT INTO ${profile.targetTable}(${profile.id},scope_id,owner_principal_id,owner_user_id${video?',community_id':''}) VALUES($1,$2,$3,$4${video?',$5':''}) ON CONFLICT DO NOTHING`,video?[s.target_id,s.scope_id,s.principal_id,s.owner_user_id,s.community_id]:[s.target_id,s.scope_id,s.principal_id,s.owner_user_id]);
          const pointer=(await q.query(`SELECT * FROM ${profile.targetTable} WHERE ${profile.id}=$1 FOR UPDATE`,[s.target_id])).rows[0];require(pointer?.scope_id===s.scope_id&&pointer.owner_principal_id===s.principal_id&&pointer.owner_user_id===s.owner_user_id&&!pointer.asset_id);
          await q.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,purpose,scope_kind${video?',community_ref':''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8${video?',$9':''})`,video?[asset,s.scope_id,s.principal_id,s.owner_user_id,policy.policy_revision,representation,p.purpose,profile.scope,s.community_id]:[asset,s.scope_id,s.principal_id,s.owner_user_id,policy.policy_revision,representation,p.purpose,profile.scope]);
          await q.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at,purpose,reserved_bytes,target_kind,${profile.intentTarget}${video?',target_community_id':''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$15,$9,$10,$11,clock_timestamp()+interval '24 hours',$13,$14,$13,$12${video?',$16':''})`,[intent,asset,representation,s.scope_id,s.principal_id,s.owner_user_id,policy.policy_revision,hash(p.planSha256+s.target_id),s.bytes.length,s.source_sha256,s.aggregate_version,s.target_id,p.purpose,profile.max,s.content_type,...(video?[s.community_id]:[])]);
          const item=(await q.query(`INSERT INTO media_backfill_items(job_id,${profile.item},intent_id,asset_id,source_version,source_size,source_sha256,source_binding_sha256,source_content_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[p.jobId,s.target_id,intent,asset,s.aggregate_version,s.bytes.length,s.source_sha256,s.binding,s.content_type])).rows[0];
          await audit(q,p,l,'prepared',s.target_id);
          return item;
        },{job:l});
        if(!next){
          complete=true;
          break;
        }if(next.blocked)continue;
        if(bytes+next.source_size*6>p.maxBytes)break;
        bytes+=next.source_size*6;
        const prepared=await tx(p,async q=>{
          await job(q,p,l);
          const s=await matches(q,next,p);
          if(!s){
            await finishStale(q,p,l,next);
            return null;
          }const intent=(await q.query('SELECT * FROM asset_upload_intents WHERE intent_id=$1 FOR UPDATE',[next.intent_id])).rows[0];
          const policy=await consent(q,p,intent.policy_revision);await capacity(q,p,s,policy);
          const asset=(await q.query('SELECT state,deletion_fence FROM assets WHERE asset_id=$1 FOR UPDATE',[next.asset_id])).rows[0];
          require(asset?.state==='pending'&&asset.deletion_fence==='0');
          const lease=(await q.query("UPDATE asset_upload_intents SET fence=fence+1,lease_token=$2,lease_expires_at=LEAST(expires_at,clock_timestamp()+make_interval(secs=>$3)),state=CASE WHEN state='stored' THEN 'stored' ELSE 'processing' END WHERE intent_id=$1 AND expires_at>clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *",[next.intent_id,randomUUID(),p.leaseSeconds])).rows[0];
          require(lease);
          return {
            s,lease,policy
          };
        },{job:l});
        if(!prepared){
          stale++;
          continue;
        }const {
          s,lease,policy
        }=prepared;
        const value=await prepareLegacyMediaRepresentation(new ReadableStream({
          start(c){
            c.enqueue(s.bytes);
            c.close();
          }
        }),s.content_type,p.purpose,{
          revision:policy.policy_revision,platformPersistenceAllowed:true
        });
        const key=objectKey({
          scopeId:lease.scope_id,assetId:lease.asset_id,representationId:lease.representation_id
        });
        const io=deadlineStore(installation.store,Date.now()+p.leaseSeconds*1000);
        try{
          await bounded(lease.state!=='stored'?writeVerifiedObject(io,key,value,{
            revision:policy.policy_revision,platformPersistenceAllowed:true
          }):verifyObject(io,key,value.metadata),p.leaseSeconds*1000);
        }catch{
          await tx(p,async q=>{
            const current=(await q.query('SELECT 1 FROM media_backfill_jobs WHERE job_id=$1 AND fence=$2 AND lease_token=$3 FOR UPDATE',[p.jobId,l.fence,l.token])).rowCount;
            if(current)await audit(q,p,l,'object_outcome_unknown',next.target_id);
          },{job:l,allowExpiredJob:true}).catch(()=>{
          });
          throw new OperatorBackfillError();
        }
        const result=await tx(p,async q=>{
          await job(q,p,l);
          const fresh=await matches(q,next,p);
          if(!fresh){
            await finishStale(q,p,l,next);
            return false;
          }const currentPolicy=await consent(q,p,lease.policy_revision);await capacity(q,p,fresh,currentPolicy);
          const i=(await q.query('SELECT * FROM asset_upload_intents WHERE intent_id=$1 FOR UPDATE',[next.intent_id])).rows[0];
          const live=(await q.query('SELECT lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() AS live FROM asset_upload_intents WHERE intent_id=$1',[next.intent_id])).rows[0];
          require(i.fence===lease.fence&&i.lease_token===lease.lease_token&&live.live);
          const a=(await q.query('SELECT state,deletion_fence FROM assets WHERE asset_id=$1 FOR UPDATE',[next.asset_id])).rows[0];
          require(a.state==='pending'&&a.deletion_fence==='0');
          const m:ObjectMetadata=value.metadata,profile=profiles[p.purpose];
          await q.query("INSERT INTO asset_objects(asset_id,scope_id,representation_id,variant,content_type,byte_size,content_sha256,transform_version,policy_revision,profile_id,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",[next.asset_id,i.scope_id,i.representation_id,profile.variant,m.contentType,m.byteSize,m.sha256,m.transformVersion,m.policyRevision,m.profileId,p.purpose]);
          await q.query("UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1",[next.intent_id]);await audit(q,p,l,'stored',next.target_id);
          await q.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1",[next.asset_id]);
          const saved=(await q.query(`UPDATE ${profile.domain} SET aggregate_version=aggregate_version+1,updated_at=clock_timestamp() WHERE ${profile.id}=$1 AND aggregate_version=$2 RETURNING aggregate_version`,[next.target_id,next.source_version])).rows[0];require(saved);
          await q.query(`UPDATE ${profile.targetTable} SET asset_id=$2,linked_at_version=$3 WHERE ${profile.id}=$1`,[next.target_id,next.asset_id,saved.aggregate_version]);
          require((await q.query(`SELECT * FROM ${profile.publish}($1,$2,$3,$4,$5)`,[p.planSha256,p.jobId,next.target_id,l.fence,l.token])).rowCount===1);
          await q.query("UPDATE asset_upload_intents SET state='finalized',finalized_at=clock_timestamp() WHERE intent_id=$1",[next.intent_id]);
          await q.query("UPDATE media_backfill_items SET outcome='linked',finished_at=clock_timestamp() WHERE job_id=$1 AND target_id=$2",[p.jobId,next.target_id]);
          await q.query(`UPDATE media_backfill_jobs SET ${profiles[p.purpose].cursor}=$2 WHERE job_id=$1`,[p.jobId,next.target_id]);
          await audit(q,p,l,'linked',next.target_id);
          return true;
        },{job:l,intent:lease});
        if(result)linked++;
        else stale++;
      }
      if(!complete)await tx(p,async q=>{
        await job(q,p,l);
        await q.query('UPDATE media_backfill_jobs SET lease_expires_at=clock_timestamp() WHERE job_id=$1',[p.jobId]);
      },{job:l,allowExpiredJob:true});
      const counts=await outcomes(p);
      return {
        status:counts.blocked?'blocked':complete?'complete':'partial',jobId:p.jobId,linked,stale,blocked:counts.blocked,remainingLegacy:counts.remainingLegacy,staleTotal:counts.stale,allSourcesMigrated:complete&&counts.blocked===0&&counts.stale===0&&!counts.remainingLegacy,contentReadUpperBound:bytes,sourcePreserved:true,releaseBinding:'operator_declared_not_runtime_verified',cleanup:'domain_media_gc_not_installed',profiles:[p.purpose]
      };
    }catch{
      throw new OperatorBackfillError();
    }
  }
  return Object.freeze({
    run
  });
}

/** Compatibility installation retains its original closed cover-only boundary. */
export function createOperatorCoverBackfill(...args:Parameters<typeof createOperatorMediaBackfill>){const host=createOperatorMediaBackfill(...args);return Object.freeze({async run(raw:unknown){require((raw as {purpose?:unknown})?.purpose==='member.service-cover');return host.run(raw);}});}
