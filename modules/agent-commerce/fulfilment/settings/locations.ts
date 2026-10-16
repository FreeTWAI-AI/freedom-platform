import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives.js';
import {Problem,requireCondition} from '../../../../packages/shared/problem.js';
import {validateHomeRecipient} from '../rules/recipient.js';
import {ShippingSettingsProblem,shippingSettingsCommand,shippingSettingsRead,type SettingsActor,type ShippingFieldError} from './command.js';
import {currentShippingProfile,profileReferences,validateShippingProfile,insertShippingProfile,type ShippingEnvironment} from './profile.js';

async function location(q:PoolClient,tenantId:string,instanceId:string,id:string){
  const row=(await q.query('SELECT * FROM commerce_ship_from_locations WHERE tenant_id=$1 AND instance_id=$2 AND location_id=$3',[tenantId,instanceId,id])).rows[0];
  requireCondition(row,404,'ship_from_location_not_found','找不到出貨地址。');return row;
}
async function locationView(q:PoolClient,tenantId:string,instanceId:string,id:string){
  const l=await location(q,tenantId,instanceId,id),p=await currentShippingProfile(q,instanceId);
  return wire.ShipFromLocationSchema.parse({location_id:l.location_id,label:l.label,sender_name:l.sender_name,mobile:l.mobile,postal_code:l.postal_code,address:l.address,ships:l.ships,receives_returns:l.receives_returns,replaces_location_id:l.replaces_location_id,in_use:profileReferences(p?.document??null,id).length>0,created_at:l.created_at.toISOString(),retired_at:l.retired_at?.toISOString()??null});
}
export function listShipFromLocations(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string){
  return shippingSettingsRead(pool,actor,tenantId,instanceId,true,async q=>{
    const rows=(await q.query('SELECT location_id FROM commerce_ship_from_locations WHERE tenant_id=$1 AND instance_id=$2 AND retired_at IS NULL ORDER BY created_at,location_id',[tenantId,instanceId])).rows;
    const items=[];for(const row of rows)items.push(await locationView(q,tenantId,instanceId,row.location_id));return wire.ShipFromLocationPageSchema.parse({items});
  });
}
export function readShipFromLocation(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,id:string){
  OpaqueId.parse(id);return shippingSettingsRead(pool,actor,tenantId,instanceId,true,q=>locationView(q,tenantId,instanceId,id));
}
export function createShipFromLocation(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,raw:unknown,key:string,environment:ShippingEnvironment){
  const input=wire.ShipFromLocationInputSchema.parse(raw);
  return shippingSettingsCommand(pool,actor,tenantId,instanceId,'store:manage','commerce.ship_from_location.create',{kind:'commerce_ship_from_location',id:instanceId},input,key,undefined,async(q,ctx)=>{
    const fields:ShippingFieldError[]=[],label=input.label.trim();
    if(!label)fields.push({path:'label',code:'required'});
    if([...label].length>40)fields.push({path:'label',code:'too_long'});
    if(/[\u0000-\u001F\u007F-\u009F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label))fields.push({path:'label',code:'format'});
    const validated=validateHomeRecipient({name:input.sender_name,mobile:input.mobile,postal_code:input.postal_code,address:input.address});
    if(!validated.ok)fields.push(...validated.errors.map(e=>({path:e.field==='name'?'sender_name':e.field,code:e.code})));
    if(!input.ships&&!input.receives_returns)fields.push({path:'ships',code:'required'});
    if(fields.length)throw new ShippingSettingsProblem(422,'shipping_input_invalid',fields);
    if(!validated.ok)throw new Problem(422,'shipping_input_invalid','配送資料無效。');
    const current=await currentShippingProfile(q,instanceId);
    if(input.replaces_location_id){
      const old=await location(q,tenantId,instanceId,input.replaces_location_id);
      requireCondition(!old.retired_at,409,'ship_from_location_retired','這個出貨地址已停用。');
      const missing=profileReferences(current?.document??null,old.location_id).filter(path=>path.startsWith('services.')?!input.ships:!input.receives_returns);
      if(missing.length)throw new ShippingSettingsProblem(409,'ship_from_location_role_required',missing.map(path=>({path,code:'role_required'})));
    }else{
      const count=(await q.query('SELECT count(*)::int n FROM commerce_ship_from_locations WHERE tenant_id=$1 AND instance_id=$2 AND retired_at IS NULL',[tenantId,instanceId])).rows[0].n;
      requireCondition(count<20,409,'ship_from_location_limit','出貨地址最多可設定二十筆。');
    }
    const id=randomUUID(),r=validated.recipient;
    await q.query(`INSERT INTO commerce_ship_from_locations(location_id,tenant_id,instance_id,label,sender_name,mobile,postal_code,address,ships,receives_returns,replaces_location_id,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,tenantId,instanceId,label,r.name,r.mobile,r.postal_code,r.address,input.ships,input.receives_returns,input.replaces_location_id??null,ctx.tenant.principal_id]);
    if(input.replaces_location_id){
      await q.query('UPDATE commerce_ship_from_locations SET retired_at=clock_timestamp(),retired_by_principal_id=$2 WHERE location_id=$1',[input.replaces_location_id,ctx.tenant.principal_id]);
      if(current&&profileReferences(current.document,input.replaces_location_id).length){
        const document=structuredClone(current.document);
        for(const service of document.services)if(service.ship_from_location_id===input.replaces_location_id)service.ship_from_location_id=id;
        if(document.drop_ship?.return_location_id===input.replaces_location_id)document.drop_ship.return_location_id=id;
        const canonical=await validateShippingProfile(q,tenantId,instanceId,environment,document);
        await insertShippingProfile(q,tenantId,instanceId,Number(current.version)+1,canonical,ctx.tenant.principal_id);
      }
    }
    return {id};
  },(q,_ctx,id)=>locationView(q,tenantId,instanceId,id));
}
export function retireShipFromLocation(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,id:string,raw:unknown,key:string){
  OpaqueId.parse(id);const input=wire.ShipFromLocationRetireInputSchema.parse(raw);
  return shippingSettingsCommand(pool,actor,tenantId,instanceId,'store:manage','commerce.ship_from_location.retire',{kind:'commerce_ship_from_location',id},input,key,undefined,async(q,ctx)=>{
    const old=await location(q,tenantId,instanceId,id);requireCondition(!old.retired_at,409,'ship_from_location_retired','這個出貨地址已停用。');
    const current=await currentShippingProfile(q,instanceId),paths=profileReferences(current?.document??null,id);
    if(paths.length)throw new ShippingSettingsProblem(409,'ship_from_location_in_use',paths.map(path=>({path,code:'role_required'})));
    await q.query('UPDATE commerce_ship_from_locations SET retired_at=clock_timestamp(),retired_by_principal_id=$2 WHERE location_id=$1',[id,ctx.tenant.principal_id]);return {id};
  },q=>locationView(q,tenantId,instanceId,id));
}
