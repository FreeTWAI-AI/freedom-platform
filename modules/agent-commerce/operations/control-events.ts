import type {PoolClient} from 'pg';
export const CONTROL_EVENT_KINDS = ['storefront.upgraded','provider_account.created','provider_service.created',
  'provider_service.state_changed','provider_credential.rotated','provider_credential.retired','provider_credential.resealed',
  'logistics_service.created','logistics_service.state_changed','store_admission.admitted','store_admission.revoked',
  'offline_payment_settings.changed'] as const;
type Detail = Partial<Record<'service_key'|'purpose'|'profile'|'environment'|'from_state'|'to_state'|'credential_version'|'module_release_ref'|'settings_version'|'methods',string|number>>;
/** Call on the domain transaction's client. Never pass request objects here. */
export async function recordControlEvent(q:PoolClient,input:{tenantId:string;instanceId?:string|null;kind:typeof CONTROL_EVENT_KINDS[number];subjectId:string;detail:Detail;actorKind:'person'|'platform_admin'|'system';actorId:string}):Promise<void>{
  const allowed=['service_key','purpose','profile','environment','from_state','to_state','credential_version','module_release_ref','settings_version','methods'];
  let detail:string;
  try {
    if(!CONTROL_EVENT_KINDS.includes(input.kind)||!input.detail||typeof input.detail!=='object'||Array.isArray(input.detail)||Object.entries(input.detail).some(([key,value])=>
      !allowed.includes(key)||(typeof value!=='string'&&!(typeof value==='number'&&Number.isSafeInteger(value)&&value>=1))))throw new Error();
    detail=JSON.stringify(input.detail);if(Buffer.byteLength(detail)>1024)throw new Error();
  } catch {throw new Error('Invalid commerce control event.');}
  await q.query(`INSERT INTO commerce_control_events(tenant_id,instance_id,kind,subject_id,detail,actor_kind,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.tenantId,input.instanceId??null,input.kind,input.subjectId,detail,input.actorKind,input.actorId]);
}
