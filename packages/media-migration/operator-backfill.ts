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
  target:z.unknown(),jobId:uuid,logicalStore:z.literal('MEDIA'),storeBindingId:name,migrationId:name.min(8),purpose:z.literal('member.service-cover'),maxRows:z.number().int().min(1).max(16),maxBytes:z.number().int().min(3145728).max(8388608),leaseSeconds:z.number().int().min(1).max(60)
}).strict();
export interface OperatorBackfillPlan {
  target:InventoryTarget;
  jobId:string;
  logicalStore:'MEDIA';
  storeBindingId:string;
  migrationId:string;
  purpose:'member.service-cover';
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
const tables=['media_backfill_operator_policy','media_backfill_jobs','media_backfill_items','media_backfill_audit','users','principals','resource_scopes','member_services','member_service_covers','member_service_cover_asset_targets','domain_media_storage_policy','assets','asset_objects','asset_upload_intents'];
type Lease={
  fence:string;
  token:string
};
type Source={
  service_id:string;
  owner_user_id:string;
  community_id:string;
  state:string;
  aggregate_version:string;
  image_bytes:Buffer;
  storage_source:string;
  principal_id:string;
  scope_id:string;
  source_sha256:string;
  binding:string
};
/** Trusted host installation only. No member Actor/session/receipt is constructed.
 * Every publication uses the existing typed target, intent and immutable object.
 * Each SQL phase is a fresh transaction; no transaction spans ObjectStore I/O. */
export function createOperatorCoverBackfill(pool:Pool,installation:{
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
    await q.query('INSERT INTO media_backfill_audit(job_id,service_id,event,operator_role,job_fence) VALUES($1,$2,$3,current_user,$4)',[p.jobId,id,event,l.fence]);
  }
  async function source(q:PoolClient,id:string,planHash:string):Promise<Source|null>{
    const hint=(await q.query('SELECT owner_user_id FROM member_services WHERE service_id=$1',[id])).rows[0];
    if(!hint)return null;
    const authority=(await q.query('SELECT * FROM lock_media_backfill_cover_owner($1,$2)',[planHash,hint.owner_user_id])).rows[0];
    if(!authority)return null;
    const principal={
      principal_id:authority.principal_id
    },scope={
      scope_id:authority.scope_id
    };
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset.quota/v1/${scope.scope_id}/member.service-cover`]);
    const s=(await q.query("SELECT service_id,owner_user_id,community_id,state,aggregate_version FROM member_services WHERE service_id=$1 AND owner_user_id=$2 AND state IN ('active','paused') FOR UPDATE",[id,hint.owner_user_id])).rows[0];
    if(!s)return null;
    const c=(await q.query('SELECT CASE WHEN octet_length(image_bytes) BETWEEN 1 AND 524288 THEN image_bytes END AS image_bytes,storage_source FROM member_service_covers WHERE service_id=$1 FOR UPDATE',[id])).rows[0];
    if(!c?.image_bytes)return null;
    const sha=hash(c.image_bytes),binding=hash([s.service_id,s.owner_user_id,s.community_id,s.state,s.aggregate_version,principal.principal_id,scope.scope_id,sha,c.image_bytes.length].join('|'));
    return {
      ...s,...c,principal_id:principal.principal_id,scope_id:scope.scope_id,source_sha256:sha,binding
    };
  }
  async function consent(q:PoolClient,planHash:string,pinned?:string){
    const policy=(await q.query("SELECT * FROM lock_media_backfill_cover_consent($1)",[planHash])).rows[0];
    require(policy?.mode==='bridge'&&policy.persistence_allowed&&policy.policy_revision&&policy.retained_byte_limit&&(!pinned||policy.policy_revision===pinned));
    return policy;
  }
  async function matches(q:PoolClient,item:any,p:OperatorBackfillPlan){
    const s=await source(q,item.service_id,p.planSha256);
    return s&&s.storage_source==='legacy'&&s.aggregate_version===item.source_version&&s.image_bytes.length===item.source_size&&s.source_sha256===item.source_sha256&&s.binding===item.source_binding_sha256?s:null;
  }
  async function finishStale(q:PoolClient,p:OperatorBackfillPlan,l:Lease,item:any){
    await q.query("UPDATE media_backfill_items SET outcome='stale',finished_at=clock_timestamp() WHERE job_id=$1 AND service_id=$2 AND outcome='pending'",[p.jobId,item.service_id]);
    await q.query('UPDATE media_backfill_jobs SET after_service_id=$2 WHERE job_id=$1',[p.jobId,item.service_id]);
    await audit(q,p,l,'stale',item.service_id);
  }
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
        await q.query('INSERT INTO media_backfill_jobs(job_id,policy_id,plan_sha256,max_rows,max_bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[p.jobId,policy.policy_id,p.planSha256,p.maxRows,p.maxBytes]);
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
      if(!claimed)return {
        status:'complete',jobId:p.jobId,linked:0,stale:0,sourcePreserved:true
      };
      const l=claimed;
      let linked=0,stale=0,bytes=0,complete=false;
      for(let n=0;
      n<Math.min(p.maxRows,Math.floor(p.maxBytes/(524288*6)));
      n++){
        const next=await tx(p,async(q)=>{
          const j=await job(q,p,l);
          const pending=(await q.query("SELECT * FROM media_backfill_items WHERE job_id=$1 AND outcome='pending' ORDER BY service_id LIMIT 1",[p.jobId])).rows[0];
          if(pending)return pending;
          const candidate=(await q.query("SELECT s.service_id FROM member_services s JOIN member_service_covers c USING(service_id) WHERE c.storage_source='legacy' AND ($1::uuid IS NULL OR s.service_id>$1) ORDER BY s.service_id LIMIT 1",[j.after_service_id])).rows[0];
          if(!candidate){
            await q.query('UPDATE media_backfill_jobs SET completed=true WHERE job_id=$1',[p.jobId]);
            await audit(q,p,l,'complete');
            return null;
          }const s=await source(q,candidate.service_id,p.planSha256);
          require(s&&s.storage_source==='legacy');
          const policy=await consent(q,p.planSha256);
          const used=(await q.query("SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,524288)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.owner_user_id=$1 AND a.purpose='member.service-cover'",[s.owner_user_id])).rows[0];
          const legacy=(await q.query('SELECT COALESCE(sum(octet_length(c.image_bytes)),0) AS used FROM member_service_covers c JOIN member_services s USING(service_id) WHERE s.owner_user_id=$1',[s.owner_user_id])).rows[0];
          require(BigInt(used.used)+BigInt(legacy.used)+524288n<=BigInt(policy.retained_byte_limit));
          const asset=randomUUID(),intent=randomUUID(),representation=randomUUID();
          await q.query('INSERT INTO member_service_cover_asset_targets(service_id,scope_id,owner_principal_id,owner_user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s.service_id,s.scope_id,s.principal_id,s.owner_user_id]);
          const pointer=(await q.query('SELECT * FROM member_service_cover_asset_targets WHERE service_id=$1 FOR UPDATE',[s.service_id])).rows[0];
          require(pointer?.scope_id===s.scope_id&&pointer.owner_principal_id===s.principal_id&&pointer.owner_user_id===s.owner_user_id&&!pointer.asset_id);
          await q.query("INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,purpose,scope_kind) VALUES($1,$2,$3,$4,$5,$6,'member.service-cover','personal')",[asset,s.scope_id,s.principal_id,s.owner_user_id,policy.policy_revision,representation]);
          await q.query("INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at,purpose,reserved_bytes,target_kind,target_service_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'image/webp',$9,$10,$11,clock_timestamp()+interval '24 hours','member.service-cover',524288,'member.service-cover',$12)",[intent,asset,representation,s.scope_id,s.principal_id,s.owner_user_id,policy.policy_revision,hash(p.planSha256+s.service_id),s.image_bytes.length,s.source_sha256,s.aggregate_version,s.service_id]);
          const item=(await q.query('INSERT INTO media_backfill_items(job_id,service_id,intent_id,asset_id,source_version,source_size,source_sha256,source_binding_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[p.jobId,s.service_id,intent,asset,s.aggregate_version,s.image_bytes.length,s.source_sha256,s.binding])).rows[0];
          await audit(q,p,l,'prepared',s.service_id);
          return item;
        },{job:l});
        if(!next){
          complete=true;
          break;
        }if(bytes+next.source_size*6>p.maxBytes)break;
        bytes+=next.source_size*6;
        const prepared=await tx(p,async q=>{
          await job(q,p,l);
          const s=await matches(q,next,p);
          if(!s){
            await finishStale(q,p,l,next);
            return null;
          }const intent=(await q.query('SELECT * FROM asset_upload_intents WHERE intent_id=$1 FOR UPDATE',[next.intent_id])).rows[0];
          const policy=await consent(q,p.planSha256,intent.policy_revision);
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
            c.enqueue(s.image_bytes);
            c.close();
          }
        }),'image/webp','member.service-cover',{
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
            if(current)await audit(q,p,l,'object_outcome_unknown',next.service_id);
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
          }await consent(q,p.planSha256,lease.policy_revision);
          const i=(await q.query('SELECT * FROM asset_upload_intents WHERE intent_id=$1 FOR UPDATE',[next.intent_id])).rows[0];
          const live=(await q.query('SELECT lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() AS live FROM asset_upload_intents WHERE intent_id=$1',[next.intent_id])).rows[0];
          require(i.fence===lease.fence&&i.lease_token===lease.lease_token&&live.live);
          const a=(await q.query('SELECT state,deletion_fence FROM assets WHERE asset_id=$1 FOR UPDATE',[next.asset_id])).rows[0];
          require(a.state==='pending'&&a.deletion_fence==='0');
          const m:ObjectMetadata=value.metadata;
          await q.query("INSERT INTO asset_objects(asset_id,scope_id,representation_id,variant,content_type,byte_size,content_sha256,transform_version,policy_revision,profile_id,purpose) VALUES($1,$2,$3,'cover',$4,$5,$6,$7,$8,$9,'member.service-cover') ON CONFLICT DO NOTHING",[next.asset_id,i.scope_id,i.representation_id,m.contentType,m.byteSize,m.sha256,m.transformVersion,m.policyRevision,m.profileId]);
          await q.query("UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1",[next.intent_id]);
          await audit(q,p,l,'stored',next.service_id);
          await q.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1",[next.asset_id]);
          const saved=(await q.query('UPDATE member_services SET aggregate_version=aggregate_version+1,updated_at=clock_timestamp() WHERE service_id=$1 AND aggregate_version=$2 RETURNING aggregate_version',[next.service_id,next.source_version])).rows[0];
          require(saved);
          await q.query('UPDATE member_service_cover_asset_targets SET asset_id=$2,linked_at_version=$3 WHERE service_id=$1',[next.service_id,next.asset_id,saved.aggregate_version]);
          require((await q.query('SELECT * FROM publish_media_backfill_cover($1,$2,$3,$4,$5)',[p.planSha256,p.jobId,next.service_id,l.fence,l.token])).rowCount===1);
          await q.query("UPDATE asset_upload_intents SET state='finalized',finalized_at=clock_timestamp() WHERE intent_id=$1",[next.intent_id]);
          await q.query("UPDATE media_backfill_items SET outcome='linked',finished_at=clock_timestamp() WHERE job_id=$1 AND service_id=$2",[p.jobId,next.service_id]);
          await q.query('UPDATE media_backfill_jobs SET after_service_id=$2 WHERE job_id=$1',[p.jobId,next.service_id]);
          await audit(q,p,l,'linked',next.service_id);
          return true;
        },{job:l,intent:lease});
        if(result)linked++;
        else stale++;
      }
      if(!complete)await tx(p,async q=>{
        await job(q,p,l);
        await q.query('UPDATE media_backfill_jobs SET lease_expires_at=clock_timestamp() WHERE job_id=$1',[p.jobId]);
      },{job:l,allowExpiredJob:true});
      return {
        status:complete?'complete':'partial',jobId:p.jobId,linked,stale,contentReadUpperBound:bytes,sourcePreserved:true,releaseBinding:'operator_declared_not_runtime_verified',cleanup:'cover_gc_not_installed',profiles:['member.service-cover']
      };
    }catch{
      throw new OperatorBackfillError();
    }
  }
  return Object.freeze({
    run
  });
}
