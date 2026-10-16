import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {canonicalJSON} from '../../checkout/terms.js';
import {shippingSettingsCommand,shippingSettingsRead,ShippingSettingsProblem,nextSettingsVersion,type SettingsActor,type ShippingFieldError} from './command.js';
import {logisticsAvailability,type ShippingEnvironment} from './logistics.js';
export type {ShippingEnvironment} from './logistics.js';
export type ShippingDocument=z.infer<typeof wire.ShippingProfileDocumentSchema>;
export async function currentShippingProfile(q:PoolClient,instanceId:string):Promise<{version:string;document:ShippingDocument;created_at:Date}|null>{
  return (await q.query('SELECT version::text,document,created_at FROM commerce_shipping_profile_versions WHERE instance_id=$1 ORDER BY version DESC LIMIT 1',[instanceId])).rows[0]??null;
}
export function profileReferences(document:ShippingDocument|null,id:string):string[]{
  if(!document)return [];const paths:string[]=[];
  document.services.forEach((service,index)=>{if(service.ship_from_location_id===id)paths.push(`services.${index}.ship_from_location_id`);});
  if(document.drop_ship?.return_location_id===id)paths.push('drop_ship.return_location_id');return paths;
}
export async function shippingProfileView(q:PoolClient,instanceId:string,environment:ShippingEnvironment){
  const current=await currentShippingProfile(q,instanceId),availability=await logisticsAvailability(q,{instanceId,environment});
  return wire.ShippingProfileViewSchema.parse({version:current?.version??null,profile:current?.document??null,saved_at:current?.created_at.toISOString()??null,environment,logistics:availability.logistics});
}
export function readShippingProfile(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,environment:ShippingEnvironment){
  return shippingSettingsRead(pool,actor,tenantId,instanceId,true,q=>shippingProfileView(q,instanceId,environment));
}
export async function validateShippingProfile(q:PoolClient,tenantId:string,instanceId:string,environment:ShippingEnvironment,input:ShippingDocument):Promise<ShippingDocument>{
  const fields:ShippingFieldError[]=[];
  const duplicates=(values:readonly unknown[],path:(index:number)=>string)=>{const seen=new Set();values.forEach((value,index)=>{if(seen.has(value))fields.push({path:path(index),code:'duplicate'});seen.add(value);});};
  duplicates(input.working_days,i=>`working_days.${i}`);
  duplicates(input.services.map(s=>s.service_key),i=>`services.${i}.service_key`);
  duplicates(input.delivery_options.map(s=>s.method),i=>`delivery_options.${i}.method`);
  duplicates(input.drop_ship?.fees.map(s=>s.service_key)??[],i=>`drop_ship.fees.${i}.service_key`);
  input.services.forEach((service,index)=>{if(service.service_key==='ecpay.logistics.home.post'&&service.outlying_islands==='allowed')fields.push({path:`services.${index}.outlying_islands`,code:'post_mainland_only'});});
  if(input.drop_ship){
    input.drop_ship.fees.forEach((fee,index)=>{if(!input.services.some(service=>service.service_key===fee.service_key))fields.push({path:`drop_ship.fees.${index}.service_key`,code:'not_in_services'});});
    if(input.drop_ship.offered&&!input.drop_ship.fees.length)fields.push({path:'drop_ship.fees',code:'fees_required'});
  }
  if(fields.length)throw new ShippingSettingsProblem(422,'shipping_input_invalid',fields);
  const refs=input.services.map((s,i)=>({id:s.ship_from_location_id,path:`services.${i}.ship_from_location_id`,role:'ships'}));
  if(input.drop_ship)refs.push({id:input.drop_ship.return_location_id,path:'drop_ship.return_location_id',role:'receives_returns'});
  const locations=(await q.query('SELECT location_id,retired_at,ships,receives_returns FROM commerce_ship_from_locations WHERE tenant_id=$1 AND instance_id=$2 AND location_id=ANY($3::uuid[])',[tenantId,instanceId,refs.map(ref=>ref.id)])).rows;
  for(const ref of refs){const row=locations.find(row=>row.location_id===ref.id);const code=!row?'not_found':row.retired_at?'retired':!row[ref.role]?'role_required':null;if(code)fields.push({path:ref.path,code});}
  if(fields.length)throw new ShippingSettingsProblem(409,'ship_from_location_unavailable',fields);
  const availability=await logisticsAvailability(q,{instanceId,environment});
  input.services.forEach((service,index)=>{if(!availability.profileServiceKeys.has(service.service_key))fields.push({path:`services.${index}.service_key`,code:'not_activated'});});
  if(fields.length)throw new ShippingSettingsProblem(409,'logistics_service_unavailable',fields);
  return {...input,working_days:[...input.working_days].sort((a,b)=>a-b)};
}
export async function insertShippingProfile(q:PoolClient,tenantId:string,instanceId:string,version:number,document:ShippingDocument,principalId:string){
  const hash=createHash('sha256').update(canonicalJSON(document)).digest('hex');
  await q.query(`INSERT INTO commerce_shipping_profile_versions(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,instanceId,version,document,hash,principalId]);
}
export function saveShippingProfile(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,raw:unknown,key:string,expected:string|undefined,environment:ShippingEnvironment){
  const input=wire.ShippingProfileInputSchema.parse(raw);
  return shippingSettingsCommand(pool,actor,tenantId,instanceId,'store:manage','commerce.shipping_profile.save',{kind:'commerce_shipping_profile',id:instanceId},input,key,expected,async(q,ctx)=>{
    const document=await validateShippingProfile(q,tenantId,instanceId,environment,input),old=await currentShippingProfile(q,instanceId);
    const version=nextSettingsVersion(old?.version??null,expected);await insertShippingProfile(q,tenantId,instanceId,version,document,ctx.tenant.principal_id);return {id:String(version)};
  },q=>shippingProfileView(q,instanceId,environment));
}
