import { purposeBuckets } from './r2-purposes.mjs';
import {readFileSync} from 'node:fs';
import {parseJsonc} from './wrangler.mjs';

/** Static candidate checks only. This never creates provider/SQL/release authority. */
export function checkBrokerWranglerConfig(path,manifest){
  const config=parseJsonc(readFileSync(path,'utf8')),errors=[],blockers=[],mapping={},seen=new Map();
  if(config.workers_dev!==false||config.preview_urls!==false)errors.push('Broker must explicitly disable public previews and workers.dev.');
  if(Object.keys(config.env??{}).some(environment=>!['staging-next','next'].includes(environment)))errors.push('Only canonical broker environment profiles are allowed.');
  if(config.main!=='apps/credential-broker/src/worker.ts')errors.push('Broker must use the independent Worker entry.');
  if(config.compatibility_date!==manifest.runtime.compatibility_date)errors.push('Broker compatibility date differs from canonical runtime.');
  for(const flag of manifest.runtime.compatibility_flags)if(!(config.compatibility_flags??[]).includes(flag))errors.push('Broker requires canonical runtime compatibility flags.');
  if(config.alias?.['./model-step-node-transport.js']!=='./apps/credential-broker/src/worker-provider-transport.ts')errors.push('Broker must select native provider transport.');
  if(config.vars?.FREEDOM_BROKER_ENABLED!=='false')errors.push('Default broker must remain disabled.');
  for(const [label,block] of [['default',config],...Object.entries(config.env??{})]){
    if(block.workers_dev===true||block.preview_urls===true||(block.routes??[]).length||block.route)errors.push(`${label}: public broker ingress is forbidden.`);
    for(const key of Object.keys(block.vars??{}))if(/(?:KEY|KEKS|SECRET|TOKEN|PASSWORD)$/.test(key))errors.push(`${label}: broker secret must not be a plain var.`);
  }
  for(const environment of ['staging-next','next']){
    const canonical=manifest.environments[environment],block=config.env?.[environment];if(!block){errors.push(`${environment}: missing environment profile.`);continue;}
    const origin=`https://${canonical.hostname}`,database=canonical.database.dbname,bindings={CIPHER_HYPERDRIVE:database+'_broker',EXECUTOR_HYPERDRIVE:database+'_broker_executor'};
    if(block.vars?.FREEDOM_BROKER_ENVIRONMENT!==environment||block.vars?.APP_ORIGIN!==origin)errors.push(`${environment}: exact canonical environment/origin correspondence is required.`);
    if(!['false','true'].includes(block.vars?.FREEDOM_BROKER_ENABLED))errors.push(`${environment}: explicit broker enable flag is required.`);
    const hyperdrives=block.hyperdrive??[];if(hyperdrives.length!==2||Object.keys(bindings).some(binding=>hyperdrives.filter(item=>item.binding===binding).length!==1))errors.push(`${environment}: exactly separate cipher and executor Hyperdrive bindings are required.`);
    mapping[environment]={origin,database,hyperdrives:[],media_bucket:purposeBuckets(canonical).MEDIA.name};
    for(const item of hyperdrives){
      if(!/^[0-9a-f]{32}$/.test(item.id??''))errors.push(`${environment}: invalid Hyperdrive identifier.`);
      else if(/^0{32}$/.test(item.id))blockers.push(`${environment}/${item.binding}: placeholder Hyperdrive is unprovisioned.`);
      else {if(seen.has(item.id))errors.push(`${environment}: Hyperdrive ID is shared across broker roles/environments.`);seen.set(item.id,environment+'/'+item.binding);}
      mapping[environment].hyperdrives.push({binding:item.binding,id:item.id,expected_database:database,expected_role:bindings[item.binding],required_caching_disabled:true,provider_cache_readback:'not_run',provider_role_database_readback:'not_run'});
    }
    const media=block.r2_buckets??[];if(media.length!==1||media[0].binding!=='MEDIA')errors.push(`${environment}: existing private MEDIA binding is required.`);
    else if(media[0].bucket_name!==mapping[environment].media_bucket){if(/^replace-existing-/.test(media[0].bucket_name??''))blockers.push(`${environment}: existing MEDIA bucket identity is not installed.`);else errors.push(`${environment}: MEDIA must reference the canonical existing private bucket.`);}
    const services=block.services??[],readiness=services.filter(item=>item.binding==='CREDENTIAL_INGEST_READINESS');
    if(services.length!==2+readiness.length||readiness.length>1||services.some(item=>!['CREDENTIAL_RECOVERY_STATE','CREDENTIAL_RECOVERY_FLOOR','CREDENTIAL_INGEST_READINESS'].includes(item.binding))
      ||['CREDENTIAL_RECOVERY_STATE','CREDENTIAL_RECOVERY_FLOOR'].some(binding=>services.filter(item=>item.binding===binding).length!==1)||new Set(services.map(item=>item.service)).size!==services.length)errors.push(`${environment}: distinct native recovery state and floor bindings (plus optional distinct ingest readiness) are required.`);
    if(readiness.length)blockers.push(`${environment}: optional CREDENTIAL_INGEST_READINESS authority, setup Custom Domain and capture-disabled operation are not verified by static checks; a signed readiness statement is not capture evidence.`);
    blockers.push(`${environment}: remote Hyperdrive cache-off, exact origin database/role, private native recovery identities, KEK/signer injection and release authority are not verified by static checks.`);
  }
  return {schema:'freedom.broker-worker-candidate/v1',status:'candidate_only',structural:errors.length===0,static_checks_pass:errors.length===0&&blockers.length===0,remote_cloud:'not_run',deployment_ready:false,enabled_by_this_tool:false,mapping,errors,blockers};
}
