import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,beforeEach,describe,test} from 'node:test';
import {shippingSettingsHarness,type ShippingSettingsHarness} from './module-registry-harness.js';
import {currentItemShippingAttributes} from '../../modules/agent-commerce/fulfilment/settings/attributes.js';
import {ItemShippingAttributesSchema} from '../../contracts/guild-launchpad/v1/hosted-shipping.js';

describe('item shipping attributes',()=>{
  let h:ShippingSettingsHarness;
  before(async()=>{h=await shippingSettingsHarness('fp_ship_attrs');});beforeEach(async()=>h.reset());after(async()=>h?.stop());
  test('own-item saves have contiguous immutable versions, CAS and reference-only replay',async()=>{
    const s=await h.store(),path=`/products/${s.product.product_id}/shipping-attributes`,input=h.attributes(),key=randomUUID();
    let r=await h.request(s,'GET',path);assert.equal(r.status,200);ItemShippingAttributesSchema.parse(r.data);assert.equal(r.data.attributes,null);assert.equal(r.response.headers.get('ETag'),null);
    assert.equal((await h.request(s,'PUT',path,input,'1')).status,412);
    r=await h.request(s,'PUT',path,input,undefined,s.owner,key);assert.equal(r.status,201);assert.equal(r.data.version,'1');assert.equal(r.response.headers.get('ETag'),'"1"');
    assert.equal((await h.request(s,'PUT',path,input)).status,428);assert.equal((await h.request(s,'PUT',path,input,'2')).status,412);
    r=await h.request(s,'PUT',path,{...input,weight_g:200},'1');assert.equal(r.status,200);assert.equal(r.data.version,'2');
    const replay=await h.request(s,'PUT',path,input,undefined,s.owner,key);assert.equal(replay.status,200);assert.equal(replay.data.attributes.weight_g,200);
    const rows=(await h.f.x.h.pool.query('SELECT item_id,version FROM commerce_item_shipping_attributes ORDER BY version')).rows;assert.deepEqual(rows.map(r=>r.version),[1,2]);
    for(const query of ['UPDATE commerce_item_shipping_attributes SET weight_g=1','DELETE FROM commerce_item_shipping_attributes'])await assert.rejects(h.f.x.h.pool.query(query),(e:unknown)=>(e as {code?:string}).code==='23514');
    const map=await h.f.x.tx(q=>currentItemShippingAttributes(q,[s.product.product_id,randomUUID()]));assert.equal(map.size,1);assert.deepEqual(map.get(s.product.product_id),{version:'2',attributes:{...input,weight_g:200}});
    const receipts=(await h.f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.item_shipping_attributes.save'")).rows;assert.equal(receipts.length,2);for(const row of receipts)assert.deepEqual(row.response,{id:s.product.product_id});
  });
  test('all numeric, temperature, boolean and nullable bounds reject before any save',async()=>{
    const s=await h.store(),path=`/products/${s.product.product_id}/shipping-attributes`,input=h.attributes();
    const cases:Record<string,unknown[]>={weight_g:[0,1000001,1.5],length_mm:[0,10001,1.5],width_mm:[0,10001,1.5],height_mm:[0,10001,1.5],temperature:['hot',''],cvs_allowed:[1,null],ship_alone:['false',null],max_per_parcel:[0,1000,1.5]};
    for(const [key,values] of Object.entries(cases))for(const value of values){const r=await h.request(s,'PUT',path,{...input,[key]:value});assert.equal(r.status,422,key+' '+JSON.stringify(r.data));}
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_item_shipping_attributes')).rows[0].n,0);
    for(const [index,temperature] of ['ambient','chilled','frozen'].entries()){const r=await h.request(s,'PUT',path,{...input,temperature,max_per_parcel:index?999:null},index?String(index):undefined);assert.equal(r.status,index?200:201);}
  });
  test('another supply shop, even selected by this retailer, has no settings authority; SQL enforces ownership',async()=>{
    const a=await h.store(),b=await h.store(),foreign=b.product.product_id,path=`/products/${foreign}/shipping-attributes`;
    await h.f.x.h.pool.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot)
      SELECT $1,$2,item_id,100,'合成條款','{}'::jsonb FROM commerce_items WHERE item_id=$3`,[randomUUID(),a.storefront_shop_id,foreign]);
    for(const method of ['GET','PUT']){const r=await h.request(a,method,path,method==='PUT'?h.attributes():undefined);assert.equal(r.status,404,JSON.stringify(r.data));assert.equal(r.data.code,'not_found');assert.equal(r.data.detail,'找不到這項商品。');}
    await assert.rejects(h.f.x.h.pool.query(`INSERT INTO commerce_item_shipping_attributes(item_id,version,tenant_id,instance_id,weight_g,length_mm,width_mm,height_mm,temperature,cvs_allowed,ship_alone,created_by_principal_id)
      SELECT $1,1,$2,$3,1,1,1,1,'ambient',true,false,principal_id FROM principals WHERE user_ref=$4`,[foreign,a.tenantId,a.instanceId,a.owner.user.user_id]),(e:unknown)=>(e as {code?:string}).code==='23514');
  });
  test('quote attribute lookup selects the latest version per item across participants and omits unsaved items',async()=>{
    const a=await h.store(),b=await h.store(),unsaved=await h.store(),first=h.attributes(),latest={...first,weight_g:321},other={...first,temperature:'chilled'};
    h.expect(await h.request(a,'PUT',`/products/${a.product.product_id}/shipping-attributes`,first),201);
    h.expect(await h.request(a,'PUT',`/products/${a.product.product_id}/shipping-attributes`,latest,'1'));
    h.expect(await h.request(b,'PUT',`/products/${b.product.product_id}/shipping-attributes`,other),201);
    const map=await h.f.x.tx(async q=>{const {bindStore}=await import('../../modules/agent-commerce/checkout/authority.js');await bindStore(q,a.tenantId);return currentItemShippingAttributes(q,[a.product.product_id,b.product.product_id,unsaved.product.product_id,randomUUID()]);});
    assert.equal(map.size,2);assert.deepEqual(map.get(a.product.product_id),{version:'2',attributes:latest});assert.deepEqual(map.get(b.product.product_id),{version:'1',attributes:other});assert.equal(map.has(unsaved.product.product_id),false);
  });
  test('read and write capabilities are independent and console flag controls all attribute routes',async()=>{
    const s=await h.store(),path=`/products/${s.product.product_id}/shipping-attributes`;
    for(const [caps,save] of [[['store:read'],403],[['store:write'],201],[['store:manage'],403],[['store:fulfil'],403]] as const){const member=await h.member(s,caps);assert.equal((await h.request(s,'GET',path,undefined,undefined,member.session)).status,200);assert.equal((await h.request(s,'PUT',path,h.attributes(),undefined,member.session)).status,save);}
    const granted=await h.member(s,['store:write']);assert.equal((await h.request(s,'PUT',path,h.attributes(),'1',granted.session)).status,200);
    await h.f.x.h.pool.query("UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE principal_id=$1",[granted.principal]);assert.equal((await h.request(s,'GET',path,undefined,undefined,granted.session)).status,404);assert.equal((await h.request(s,'PUT',path,h.attributes(),'2',granted.session)).status,404);
    h.f.settings.consoleEnabled=false;h.f.install();assert.equal((await h.request(s,'GET',path)).status,404);assert.equal((await h.request(s,'PUT',path,h.attributes(),'1')).status,404);
  });
});
