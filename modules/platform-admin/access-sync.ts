import type { Pool } from 'pg';
import { z } from 'zod';

export type AccessSyncConfig = { accountId:string; appId:string; policyId:string; domain:string; token:string };
const policyName = 'Nominated Freedom super administrators';
type AdminRevision = {admin_id:string;email:string;active:boolean;aggregate_version:string|number;access_synced_version:string|number|null};

/** Operational worker only. The public API never receives the Cloudflare token.
 * API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/methods/update/
 */
export async function syncAdminAccess(pool:Pool, config:AccessSyncConfig, options:{fetcher?:typeof fetch;force?:boolean}={}) {
  z.string().regex(/^[a-f0-9]{32}$/).parse(config.accountId);
  z.uuid().parse(config.appId); z.uuid().parse(config.policyId);
  z.string().regex(/^[a-z0-9.-]+\/admin$/).parse(config.domain);
  if(!config.token)throw Error('Access sync credentials are missing.');
  const fetcher=options.fetcher??fetch;
  const base=`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/access/apps/${config.appId}`;
  async function call(suffix:string, method='GET', body?:unknown) {
    const response=await fetcher(base+suffix,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok)throw Error(`Access sync provider request failed (${response.status}).`);
    const value=await response.json() as {success?:boolean;result?:any;result_info?:{total_pages?:number}};
    if(!value.success||!value.result)throw Error('Access sync provider returned an incomplete result.');
    if((value.result_info?.total_pages??1)>1)throw Error('Unexpected paginated admin policy set.');
    return value.result;
  }
  const q=await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query("SET LOCAL lock_timeout='5s'");
    const communities=(await q.query('SELECT community_id FROM communities')).rows;
    if(communities.length!==1)throw Error('Access sync requires an explicit single-community database.');
    const community=communities[0].community_id;
    // Same lock and ordering as appointments/revocations: a stale snapshot must
    // not replace a newer role change at the edge or mark it synchronized.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`admin-roles/${community}`]);
    const rows=(await q.query('SELECT admin_id,email,active,aggregate_version,access_synced_version FROM platform_admins WHERE community_id=$1 ORDER BY admin_id FOR UPDATE',[community])).rows as AdminRevision[];
    const pending=rows.some(row=>row.access_synced_version===null||String(row.access_synced_version)!==String(row.aggregate_version));
    if(!pending&&!options.force){await q.query('COMMIT');return {checked:false,updated:false,active_admins:rows.filter(row=>row.active).length};}
    const emails=rows.filter(row=>row.active).map(row=>z.email().parse(row.email)).sort();
    if(!emails.length||new Set(emails).size!==emails.length)throw Error('Access sync requires at least one distinct active administrator.');
    const app=await call('');
    if(app.id!==config.appId||app.domain!==config.domain||app.type!=='self_hosted')throw Error('Access sync application scope mismatch.');
    const policies=await call('/policies?per_page=100');
    if(!Array.isArray(policies)||policies.length!==1||policies[0].id!==config.policyId)throw Error('Unexpected admin access policies; no policy was changed.');
    const prior=policies[0];
    if(prior.name!==policyName||prior.decision!=='allow'||(prior.require??[]).length||(prior.exclude??[]).length)throw Error('Unexpected admin policy constraints; no policy was changed.');
    const includes=emails.map(email=>({email:{email}}));
    const equal=(value:any)=>Array.isArray(value)&&value.length===includes.length&&value.every((rule:any)=>rule&&Object.keys(rule).length===1&&rule.email&&Object.keys(rule.email).length===1&&emails.includes(rule.email.email))&&new Set(value.map((r:any)=>r.email.email)).size===includes.length;
    const updated=!equal(prior.include);
    if(updated)await call('/policies/'+config.policyId,'PUT',{name:policyName,decision:'allow',include:includes,exclude:[],require:[],precedence:1});
    // A write response alone is not evidence that a new administrator can pass
    // the edge. Read back the exact allowlist before advancing sync revisions.
    const verified=await call('/policies/'+config.policyId);
    if(verified.id!==config.policyId||verified.decision!=='allow'||!equal(verified.include)||(verified.require??[]).length||(verified.exclude??[]).length)throw Error('Admin access policy read-back did not match; synchronization remains pending.');
    await q.query('UPDATE platform_admins SET access_synced_version=aggregate_version,access_synced_at=now() WHERE community_id=$1',[community]);
    await q.query('COMMIT');
    return {checked:true,updated,active_admins:emails.length};
  } catch(error){await q.query('ROLLBACK');throw error;}
  finally{q.release();}
}
