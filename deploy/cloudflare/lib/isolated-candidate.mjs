import { createHash } from 'node:crypto';
import { MEDIA_WORKER_FEATURES } from './media-wrangler.mjs';
import { validateManifest } from './manifest.mjs';
import { createReadOnlyClient } from './cloudflare.mjs';
import { redactDeep } from './redact.mjs';

const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
const placeholder = value => typeof value === 'string' && (/^REPLACE_/.test(value) || /^0+$/.test(value) || value.endsWith('.invalid'));
const physicalHost = value => typeof value === 'string' ? value.toLowerCase().replace(/\.$/,'') : null;
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const remaining = [
  'approved_resource_names', 'new_empty_synthetic_database_branch',
  'provider_physical_database_branch_identity', 'private_new_r2_bucket_and_no_public_domains',
  'hyperdrive_cache_disabled_and_origin_identity', 'exact_current_database_and_runtime_roles',
  'canonical_policy_and_consent', 'fresh_candidate_only_keys_and_recovery_ports',
  'installed_release_capabilities_and_schema_floor', 'remote_worker_media_bytes_and_acl',
  'remote_operator_atomicity_and_unknown_put', 'remote_cache_and_session_acceptance',
];
const hdBindings = { main: 'HYPERDRIVE', cipher: 'CIPHER_HYPERDRIVE', executor: 'EXECUTOR_HYPERDRIVE', operator: 'OPERATOR_HYPERDRIVE' };

/** Closed installation request, not a replacement environment manifest or deployment authority. */
export function planIsolatedCandidate(request, manifest) {
  const errors = [], blockers = [];
  const foundation = request?.schema === 'freedom.isolated-foundation-request/v1';
  const workerKeys = foundation ? ['main','operator'] : ['main','broker','operator'];
  const driveKeys = foundation ? ['main','operator'] : ['main','cipher','executor','operator'];
  const remainingChecks = foundation ? remaining.map(check => check === 'fresh_candidate_only_keys_and_recovery_ports' ? 'fresh_candidate_only_sessions_and_operator_approval' : check) : remaining;
  const report = extra => redactDeep({ schema: 'freedom.isolated-candidate-admission/v1',
    status: errors.length ? 'invalid' : 'unavailable', structural: errors.length === 0,
    deployment_authority: false, execution_authority: false, restore_proof: false,
    provider_mutations: 0, database_connections: 0, remote_acceptance: 'not_run',
    errors, blockers, ...(foundation ? {profile:'foundation-media'} : {}), remaining_checks: remainingChecks.map(check_id => ({ check_id, status: 'not_run' })), ...extra });
  if (validateManifest(manifest).errors.length) { errors.push('canonical_manifest_invalid'); return report(); }
  if (!keys(request, ['schema','environment','releaseSha','hostname','workers','database','hyperdrive','bucket',...(foundation ? ['features'] : [])])) {
    errors.push('closed_request_shape_required'); return report();
  }
  if ((!foundation && request.schema !== 'freedom.isolated-candidate-request/v1') || request.environment !== 'staging-next') errors.push('isolated_staging_request_required');
  if (foundation && (!keys(request.features,['private_ai','broker','machine_execution']) ||
    Object.values(request.features).some(value => value !== 'false'))) errors.push('foundation_execution_features_must_be_off');
  if (!/^[a-f0-9]{40}$/.test(request.releaseSha ?? '')) errors.push('release_sha_invalid');
  else if (/^0+$/.test(request.releaseSha)) blockers.push('release_sha_placeholder');
  if (!keys(request.workers,workerKeys) || !keys(request.database,['branchId','originHost'])
    || !keys(request.hyperdrive,driveKeys)) errors.push('closed_resource_shape_required');
  if (errors.length) return report();
  const fields=[request.hostname,request.bucket,request.database.branchId,request.database.originHost,...Object.values(request.workers),...Object.values(request.hyperdrive)];
  if(fields.some(value=>typeof value!=='string'||value.length>253||!/^[-A-Za-z0-9._]+$/.test(value))){errors.push('bounded_resource_strings_required');return report();}
  const canonical = manifest.environments['staging-next'];
  const envs = Object.values(manifest.environments);
  const protectedWorkers = new Set(['freedom-platform','main',...envs.map(e => e.worker.name),
    'freedom-model-broker-staging-next','freedom-model-broker-next','freedom-media-operator-staging-next','freedom-media-operator-next']);
  const protectedHosts = new Set(['freetwai.com','staging.freetwai.com','next.freetwai.com','staging-next.freetwai.com',...envs.map(e => e.hostname)]);
  const protectedBuckets = new Set(envs.flatMap(e => e.r2_buckets.map(b => b.name)));
  const names = Object.values(request.workers);
  if (new Set(names).size !== workerKeys.length) errors.push('candidate_workers_must_be_distinct');
  for (const name of names) {
    if (placeholder(name)) blockers.push('worker_name_placeholder');
    else if (typeof name !== 'string' || !/^fp-base-candidate-[a-z0-9-]{1,35}-(?:main|broker|operator)$/.test(name) || protectedWorkers.has(name)) errors.push('operational_or_invalid_worker_name');
  }
  if (placeholder(request.hostname)) blockers.push('candidate_hostname_placeholder');
  else if (typeof request.hostname !== 'string' || !/^base-candidate-[a-z0-9-]{1,35}\.[a-z0-9.-]+$/.test(request.hostname) || protectedHosts.has(request.hostname)) errors.push('operational_or_invalid_hostname');
  if (placeholder(request.bucket)) blockers.push('private_bucket_placeholder');
  else if (typeof request.bucket !== 'string' || !/^fp-base-candidate-[a-z0-9-]{1,40}-media$/.test(request.bucket) || protectedBuckets.has(request.bucket)) errors.push('operational_or_invalid_bucket');
  if (placeholder(request.database.branchId)) blockers.push('physical_branch_placeholder');
  else if (typeof request.database.branchId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(request.database.branchId)) errors.push('physical_branch_invalid');
  if (placeholder(request.database.originHost)) blockers.push('physical_origin_placeholder');
  else if (typeof request.database.originHost !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(request.database.originHost)) errors.push('physical_origin_invalid');
  const ids = Object.values(request.hyperdrive);
  for (const value of ids) if (placeholder(value)) blockers.push('hyperdrive_placeholder'); else if (!id(value)) errors.push('hyperdrive_id_invalid');
  if (ids.filter(v => !placeholder(v)).length !== new Set(ids.filter(v => !placeholder(v))).size) errors.push('hyperdrive_roles_must_not_share_ids');
  // Never infer provider identity, private access or emptiness from these declarations.
  blockers.push('resource_names_not_approved','physical_isolation_not_observed');
  if (!foundation) blockers.push('broker_candidate_origin_unsupported');
  if (errors.length) return report();
  const origin = `https://${request.hostname}`;
  const shared = { compatibility_date:'2026-09-21',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,routes:[],triggers:{crons:[]} };
  const r2 = [{binding:'MEDIA',bucket_name:request.bucket}];
  const binding = key => ({binding:hdBindings[key],id:request.hyperdrive[key]});
  const mediaFlags = Object.fromEntries(MEDIA_WORKER_FEATURES.filter(f => f.flag).map(f => [f.flag,'false']));
  const configs = {
    main: {...shared,name:request.workers.main,main:'apps/platform-api/src/worker.ts',
      alias:{sharp:'./packages/shared/sharp-unavailable.ts','./model-step-node-transport.js':'./modules/agent-execution/model-step-worker-transport-unavailable.ts'},
      assets:{directory:'apps/portal-web/dist',binding:'ASSETS',run_worker_first:true,html_handling:'auto-trailing-slash',not_found_handling:'none'},
      vars:{FREEDOM_ENV:'staging',APP_ORIGIN:origin,FREEDOM_DATABASE_NAME:canonical.database.dbname,FREEDOM_RELEASE_SHA:request.releaseSha,FREEDOM_PRIVATE_AI_ENABLED:'false',...mediaFlags},
      hyperdrive:[binding('main')],images:{binding:'IMAGES'},r2_buckets:r2},
    ...(!foundation ? {broker:{...shared,name:request.workers.broker,main:'apps/credential-broker/src/worker.ts',
      alias:{'./model-step-node-transport.js':'./apps/credential-broker/src/worker-provider-transport.ts'},
      vars:{FREEDOM_BROKER_ENABLED:'false',FREEDOM_BROKER_ENVIRONMENT:'staging-next',APP_ORIGIN:origin},
      hyperdrive:[binding('cipher'),binding('executor')],r2_buckets:r2}} : {}),
    operator:{...shared,name:request.workers.operator,main:'apps/media-operator/src/worker.ts',
      vars:{FREEDOM_MEDIA_OPERATOR_ENABLED:'false',FREEDOM_MEDIA_OPERATOR_ENVIRONMENT:'staging',FREEDOM_MEDIA_OPERATOR_RELEASE_SHA:request.releaseSha},
      hyperdrive:[binding('operator')],r2_buckets:r2},
  };
  // SQL role contracts stay bare. PlanetScale's connection routing requires
  // this exact branch suffix; neither name is accepted as a caller override.
  const roles = {main:canonical.database.roles.runtime,...(!foundation ? {cipher:canonical.database.dbname+'_broker',executor:canonical.database.dbname+'_broker_executor'} : {}),operator:'freedom_media_migrator'};
  const connectionUsers = Object.fromEntries(Object.entries(roles).map(([key,role]) => [key,`${role}.${request.database.branchId}`]));
  return report({request_sha256:createHash('sha256').update(JSON.stringify(request)).digest('hex'), configs,
    planned_hostname:request.hostname, ingress:'none_until_separate_approved_installation',
    logical_database:canonical.database.dbname, schema_name:'public',
    expected_roles:roles, expected_connection_users:connectionUsers,
    media_mapping:MEDIA_WORKER_FEATURES.map(f => ({purpose:f.purpose,required_bindings:f.required_bindings,required_capabilities:f.required_capabilities,persistence_authorized:'not_run'})),
    runtime_constraints:{main:'current_database/non-superuser/optional initialized community; physical branch not checked by readiness',
      ...(!foundation ? {broker:'existing compose pins operational platformOrigin; candidate origin requires independently reviewed explicit contract before activation'} : {private_execution:'private AI/broker/machine execution excluded; no broker/recovery/service bindings generated'}),
      operator:'staging logical database/public schema/freedom_media_migrator remain exact; purpose activation depends on installed source version'},
  });
}

/** Optional trusted-host read adapter. CLI never installs this adapter or reads credentials. */
export function createCandidateProviderReader(options) {
  const client = createReadOnlyClient(options);
  return Object.freeze({get:client.get});
}

/** Read-only provider checks never grant deployment or prove SQL/bytes/private bucket access. */
export async function inspectCandidateProvider(request, manifest, {client,accountId}) {
  const planned = planIsolatedCandidate(request,manifest);
  const checks = [];
  const result = () => ({...planned,configs:undefined,provider_checks:checks,provider_isolation_status:checks.some(c=>c.status==='rejected')?'rejected':checks.some(c=>c.status==='observed')?'partial_observation':'unavailable',remote_acceptance:'not_run',deployment_authority:false,provider_mutations:0});
  if (!planned.structural || planned.blockers.some(b => b.endsWith('_placeholder'))) return result();
  if (!id(accountId) || !client || typeof client.get !== 'function') { checks.push({check_id:'provider_reader',status:'unavailable'}); return result(); }
  try {
    const list = await client.get(`/accounts/${accountId}/hyperdrive/configs`);
    // Absence on a partial list is never isolation evidence.
    if (!list.success || list.http !== 200 || !Array.isArray(list.result) || list.result.length>256 || !Number.isInteger(list.result_info?.total_count) || list.result_info.total_count !== list.result.length) {
      checks.push({check_id:'hyperdrive_complete_inventory',status:'unavailable'});return result();
    }
    const protectedNames = Object.values(manifest.environments).map(e => e.hyperdrive.name);
    const protectedConfigs = [];
    for (const name of protectedNames) {
      const matches=list.result.filter(c=>c?.name===name);
      if(matches.length!==1||!id(matches[0].id)){checks.push({check_id:'operational_hyperdrive_baseline',status:'unavailable'});return result();}
      const detail=await client.get(`/accounts/${accountId}/hyperdrive/configs/${matches[0].id}`);
      if(!detail.success||detail.http!==200||detail.result?.id!==matches[0].id||!detail.result?.origin?.host){checks.push({check_id:'operational_hyperdrive_baseline',status:'unavailable'});return result();}
      protectedConfigs.push(detail.result);
    }
    let valid=true;
    const connectionUsers=planned.expected_connection_users;
    for(const [key,value] of Object.entries(request.hyperdrive)){
      if(protectedConfigs.some(c=>c.id===value)){valid=false;continue;}
      const detail=await client.get(`/accounts/${accountId}/hyperdrive/configs/${value}`),c=detail.result;
      if(!detail.success||detail.http!==200||c?.id!==value||c?.caching?.disabled!==true||physicalHost(c?.origin?.host)!==physicalHost(request.database.originHost)
        ||c?.origin?.database!==planned.logical_database||c?.origin?.user!==connectionUsers[key]||protectedConfigs.some(p=>physicalHost(p.origin.host)===physicalHost(c?.origin?.host)))valid=false;
    }
    checks.push({check_id:'hyperdrive_physical_origin_cache_and_declared_roles',status:valid?'observed':'rejected'});
  } catch {checks.push({check_id:'provider_reader',status:'unavailable'});}
  return result();
}
