import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import {SupplyMaterialsSchema,SupplyMaterialDetailSchema,SupplyMaterialReceiptSchema,PartnerMaterialsSchema,
  SupplyMaterialCreateInputSchema,SupplyMaterialUpdateInputSchema,SupplyMaterialCopyInputSchema,
  SupplyMaterialAccessInputSchema,SupplyMaterialGrantInputSchema,SupplyMaterialEmptyInputSchema} from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import {checkVersion} from '../../../packages/db/index.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import type {TenantScopeContext} from '../../../packages/resource-scopes/index.js';
import type {Actor} from '../../identity-membership/service.js';
import {capacitySummary} from '../../opportunity-project-work/tenant-capacity.js';
import {profile,ready,storeRead,storeCommand,storeFact} from '../hosted/store.js';
import {offers,selections,params,type Row} from './reads.js';

const stamp=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const clock=`clock AS (SELECT statement_timestamp() AS at)`;
// Response corruption is a server failure; the HTTP Zod handler is for inputs.
function answer<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success)throw new Problem(500,'internal_error','素材資料目前無法讀取。');
  return result.data;
}
const versionJson=`jsonb_build_object('version_id',v.version_id,'version_no',v.version_no,'created_at',${stamp('v.created_at')},
  'content',CASE v.kind WHEN 'copy' THEN jsonb_build_object('kind','copy','body',v.body)
    WHEN 'image' THEN jsonb_build_object('kind','image','content_type',o.content_type,'byte_size',o.byte_size,'width',o.pixel_width,'height',o.pixel_height)
    ELSE jsonb_build_object('kind','video','content_type',o.content_type,'byte_size',o.byte_size) END)`;
const objectJoin=`LEFT JOIN asset_objects o ON (o.asset_id,o.scope_id,o.representation_id,o.policy_revision,o.purpose)
  =(v.asset_id,v.scope_id,v.representation_id,v.policy_revision,v.purpose)`;
const versions=`versions AS (SELECT v.*,${versionJson} AS view FROM supply_material_versions v ${objectJoin})`;
const materials=`materials AS (SELECT m.*,jsonb_build_object('material_id',m.material_id,'kind',m.kind,
  'subject',CASE WHEN m.product_id IS NULL THEN jsonb_build_object('kind','brand') ELSE
    jsonb_build_object('kind','product','product_id',m.product_id,'sku',i.sku,'title',i.title) END,
  'title',m.title,'description',m.description,'access',m.access,'state',m.state,'version',m.aggregate_version::text,
  'created_at',${stamp('m.created_at')},'updated_at',${stamp('m.updated_at')},'withdrawn_at',${stamp('m.withdrawn_at')},
  'current',(SELECT v.view FROM versions v WHERE v.version_id=m.current_version_id),
  'version_count',(SELECT count(*)::int FROM versions v WHERE v.material_id=m.material_id),
  'active_grants',(SELECT count(*)::int FROM supply_material_grants g WHERE g.material_id=m.material_id AND g.revoked_at IS NULL)) AS view
  FROM supply_materials m LEFT JOIN commerce_items i ON i.item_id=m.product_id AND i.shop_id=$3
  WHERE m.tenant_id=$1 AND m.instance_id=$2)`;
// Shared by detail and grant: target is the exact material in this business.
const eligiblePartners=`eligible_partners AS (SELECT l.partner_id,l.seller_name AS name,
  CASE WHEN bool_or(l.bucket='sellable') THEN 'sellable' ELSE 'awaiting' END AS cooperation,
  EXISTS(SELECT 1 FROM supply_material_grants g WHERE g.material_id=m.material_id AND g.partner_shop_id=l.partner_id AND g.revoked_at IS NULL) AS granted
  FROM selections l JOIN commerce_storefront_profiles seller ON seller.storefront_shop_id=l.partner_id CROSS JOIN target m
  WHERE seller.tenant_id<>m.tenant_id AND l.bucket IN ('awaiting','sellable') AND (m.product_id IS NULL OR l.item_id=m.product_id)
  GROUP BY l.partner_id,l.seller_name,m.material_id)`;

export async function listSupplyMaterials(pool:Pool,actor:Actor,t:string,i:string) {
  return storeRead(pool,actor,t,i,'store:write',async(q,context)=>{
    const p=await profile(q,t,i);ready(p);
    const row=(await q.query(`/* supplier-console:materials */ WITH ${clock},${versions},${materials}
      SELECT ${stamp('clock.at')} AS as_of,(SELECT count(*)::int FROM materials) AS total,
      (SELECT count(*)::int FROM materials WHERE state='active') AS active,
      COALESCE((SELECT jsonb_agg(m.view ORDER BY m.state,m.updated_at DESC,m.material_id) FROM
        (SELECT * FROM materials ORDER BY state,updated_at DESC,material_id LIMIT 200) m),'[]') AS items FROM clock`,params(p).slice(0,3))).rows[0];
    const usage=await capacitySummary(q,context.scope.scope_id,t);
    let capacity:unknown={state:'unavailable'};
    if(usage.limit!==null) {
      const limit=BigInt(usage.limit),used=BigInt(usage.used),reserved=BigInt(usage.reserved),remaining=limit-used-reserved;
      const safe=(n:bigint)=>{requireCondition(n>=0n&&n<=BigInt(Number.MAX_SAFE_INTEGER),500,'internal_error','素材容量資料目前無法讀取。');return Number(n);};
      capacity={state:'ready',limit_bytes:safe(limit),used_bytes:safe(used),reserved_bytes:safe(reserved),remaining_bytes:safe(remaining>0n?remaining:0n)};
    }
    return answer(SupplyMaterialsSchema,{profile:'freedom.supplier-console.materials/v1',tenant_id:t,instance_id:i,...row,capacity,truncated:row.total>200});
  });
}
export async function readSupplyMaterial(pool:Pool,actor:Actor,t:string,i:string,id:string) {
  return storeRead(pool,actor,t,i,'store:write',async q=>{
    const p=await profile(q,t,i);ready(p);
    const row=(await q.query(`/* supplier-console:material */ WITH ${clock},${versions},${materials},
      target AS (SELECT * FROM materials WHERE material_id=$5),${offers},${selections},${eligiblePartners},
      grants AS (SELECT g.*,s.name AS partner_name FROM supply_material_grants g JOIN commerce_shops s ON s.shop_id=g.partner_shop_id WHERE g.material_id=$5)
      SELECT ${stamp('clock.at')} AS as_of,(SELECT view FROM target) AS material,
      COALESCE((SELECT jsonb_agg(v.view ORDER BY v.version_no DESC,v.version_id) FROM
        (SELECT * FROM versions WHERE material_id=$5 ORDER BY version_no DESC,version_id LIMIT 50) v),'[]') AS versions,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('partner_id',g.partner_shop_id,'partner_name',g.partner_name,
        'granted_at',${stamp('g.granted_at')},'revoked_at',${stamp('g.revoked_at')})
        ORDER BY (g.revoked_at IS NOT NULL),CASE WHEN g.revoked_at IS NULL THEN g.partner_name END,
          CASE WHEN g.revoked_at IS NULL THEN g.partner_shop_id END,g.revoked_at DESC,g.grant_id) FROM
        (SELECT * FROM grants ORDER BY (revoked_at IS NOT NULL),CASE WHEN revoked_at IS NULL THEN partner_name END,
          CASE WHEN revoked_at IS NULL THEN partner_shop_id END,revoked_at DESC,grant_id LIMIT 200) g),'[]') AS grants,
      (SELECT count(*)>200 FROM grants) AS grants_truncated,
      COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.name,e.partner_id) FROM
        (SELECT * FROM eligible_partners ORDER BY name,partner_id LIMIT 200) e),'[]') AS partners,
      (SELECT count(*)>200 FROM eligible_partners) AS partners_truncated FROM clock`,[...params(p),id])).rows[0];
    requireCondition(row.material,404,'not_found','找不到這個素材。');
    return answer(SupplyMaterialDetailSchema,{profile:'freedom.supplier-console.material/v1',tenant_id:t,instance_id:i,...row,
      versions_truncated:row.material.version_count>50});
  });
}

/** SQL that yields the materials visible to one seller storefront shop ($1 = that storefront_shop_id), with their
 * current version id and applies_to. The caller adds its own filters. Cooperation is checked here, not by RLS. */
export const partnerVisibleMaterials=`SELECT m.*,v.version_id,v.asset_id,v.representation_id,v.policy_revision,v.purpose,c.applies_to,c.supplier_name,c.product_title,${versionJson} AS current
  FROM supply_materials m
  JOIN supply_material_grants g ON g.material_id=m.material_id AND g.partner_shop_id=$1 AND g.revoked_at IS NULL
  JOIN supply_material_versions v ON v.version_id=m.current_version_id AND v.material_id=m.material_id
  ${objectJoin}
  CROSS JOIN LATERAL (
    SELECT ARRAY(SELECT DISTINCT l.item_id FROM commerce_selections l JOIN commerce_hosted_supply_offers offer
      ON offer.offer_id=l.hosted_offer_id AND offer.item_id=l.item_id
      WHERE l.shop_id=$1 AND offer.tenant_id=m.tenant_id AND offer.instance_id=m.instance_id AND offer.state<>'withdrawn'
        AND l.acceptance_state IN ('awaiting_supply_acceptance','sellable') AND (m.product_id IS NULL OR l.item_id=m.product_id)
      ORDER BY l.item_id LIMIT 200) AS applies_to,
      o.supplier_name,o.terms->>'title' AS product_title
    FROM commerce_selections l JOIN commerce_hosted_supply_offers o ON o.offer_id=l.hosted_offer_id AND o.item_id=l.item_id
    WHERE l.shop_id=$1 AND o.tenant_id=m.tenant_id AND o.instance_id=m.instance_id AND o.state<>'withdrawn'
      AND l.acceptance_state IN ('awaiting_supply_acceptance','sellable') AND (m.product_id IS NULL OR l.item_id=m.product_id)
    ORDER BY o.created_at DESC,o.offer_id DESC LIMIT 1
  ) c WHERE m.state='active'`;
export async function readPartnerMaterial(q:PoolClient,shopId:string,materialId:string,versionId:string) {
  return (await q.query(`WITH visible AS (${partnerVisibleMaterials}) SELECT * FROM visible WHERE material_id=$2 AND version_id=$3`,
    [shopId,materialId,versionId])).rows[0]??null;
}
export async function listPartnerMaterials(pool:Pool,actor:Actor,t:string,i:string) {
  return storeRead(pool,actor,t,i,'store:read',async q=>{
    const p=await profile(q,t,i);ready(p);
    const row=(await q.query(`/* supplier-console:partner-materials */ WITH ${clock},visible AS (${partnerVisibleMaterials})
      SELECT ${stamp('clock.at')} AS as_of,(SELECT count(*)>200 FROM visible) AS truncated,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('material_id',m.material_id,'kind',m.kind,'supplier_name',m.supplier_name,
        'subject',CASE WHEN m.product_id IS NULL THEN jsonb_build_object('kind','brand') ELSE
          jsonb_build_object('kind','product','product_id',m.product_id,'title',m.product_title) END,
        'applies_to',m.applies_to,'title',m.title,'description',m.description,'access',m.access,'current',m.current)
        ORDER BY m.supplier_name,(m.product_id IS NOT NULL),m.title,m.material_id) FROM
        (SELECT * FROM visible ORDER BY supplier_name,(product_id IS NOT NULL),title,material_id LIMIT 200) m),'[]') AS items FROM clock`,[p.storefront_shop_id])).rows[0];
    return answer(PartnerMaterialsSchema,{profile:'freedom.partner-materials/v1',tenant_id:t,instance_id:i,...row});
  });
}

async function lockMaterial(q:PoolClient,t:string,i:string,id:string,expected:string) {
  const m=(await q.query(`SELECT * FROM supply_materials WHERE material_id=$1 AND tenant_id=$2 AND instance_id=$3 FOR UPDATE`,[id,t,i])).rows[0];
  requireCondition(m,404,'not_found','找不到這個素材。');
  requireCondition(m.state!=='withdrawn',409,'material_withdrawn','這個素材已撤回，不能再修改。');
  checkVersion(String(m.aggregate_version),expected);return m;
}
async function appendCopy(q:PoolClient,context:TenantScopeContext,m:Row,body:string) {
  requireCondition(m.kind==='copy',409,'material_kind_mismatch','這個素材的種類不接受這個內容。');
  const n=(await q.query('SELECT count(*)::int AS n FROM supply_material_versions WHERE material_id=$1',[m.material_id])).rows[0].n;
  requireCondition(n<100,409,'material_version_limit','這個素材已有 100 個版本，請另外建立新素材。');
  const id=randomUUID();
  await q.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,body,created_by_principal_id)
    VALUES($1,$2,$3,$4,$5,'copy',$6,$7,$8)`,[id,m.material_id,m.tenant_id,m.instance_id,m.scope_id,n+1,body,context.principal_id]);
  return (await q.query(`UPDATE supply_materials SET current_version_id=$2,aggregate_version=aggregate_version+1 WHERE material_id=$1
    RETURNING aggregate_version::text AS version`,[m.material_id,id])).rows[0].version as string;
}
async function receipt(q:PoolClient,context:TenantScopeContext,id:string,version:string,operation:string) {
  await storeFact(q,context,id,version,operation,'supply_material');
  return answer(SupplyMaterialReceiptSchema,{material_id:id,version});
}
export async function createSupplyMaterial(pool:Pool,actor:Actor,t:string,i:string,raw:unknown,key:string) {
  const input=SupplyMaterialCreateInputSchema.parse(raw),operation='storefront.supply-material.create';
  return storeCommand(pool,actor,t,i,'store:write',operation,input,key,undefined,async(q,context)=>{
    const p=await profile(q,t,i,true);ready(p);
    const n=(await q.query(`SELECT count(*)::int AS n FROM supply_materials WHERE tenant_id=$1 AND instance_id=$2 AND state='active'`,[t,i])).rows[0].n;
    requireCondition(n<200,409,'material_limit','使用中的素材已達 200 筆，請先撤回不再使用的素材。');
    if(input.product_id!==null) {
      const own=(await q.query(`SELECT 1 FROM commerce_storefront_profiles p JOIN commerce_items item ON item.shop_id=p.supply_shop_id AND item.item_id=$3
        JOIN commerce_resource_tenants mapping ON mapping.resource_kind='shop' AND mapping.resource_id=p.supply_shop_id
          AND mapping.tenant_id=p.tenant_id AND mapping.instance_id=p.instance_id AND mapping.mapping_state='confirmed'
        WHERE p.tenant_id=$1 AND p.instance_id=$2`,[t,i,input.product_id])).rowCount;
      requireCondition(own===1,422,'material_product_invalid','請選擇這個商品庫自己的商品。');
    }
    const m=(await q.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,product_id,title,description,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),t,i,context.scope.scope_id,input.kind,input.product_id,input.title,input.description,context.principal_id])).rows[0];
    const version=input.kind==='copy'?await appendCopy(q,context,m,input.body):'1';
    return receipt(q,context,m.material_id,version,operation);
  });
}
type Change='update'|'copy'|'access'|'grant'|'revoke'|'withdraw';
const inputs={update:SupplyMaterialUpdateInputSchema,copy:SupplyMaterialCopyInputSchema,access:SupplyMaterialAccessInputSchema,
  grant:SupplyMaterialGrantInputSchema,revoke:SupplyMaterialEmptyInputSchema,withdraw:SupplyMaterialEmptyInputSchema};
export async function changeSupplyMaterial(pool:Pool,actor:Actor,t:string,i:string,id:string,change:Change,raw:unknown,key:string,expected:string,partnerId?:string) {
  const input=inputs[change].parse(raw),operation=`storefront.supply-material.${change}`;
  // Target IDs participate in the receipt digest: a key cannot address a second material/shop.
  return storeCommand(pool,actor,t,i,'store:write',operation,{material_id:id,...(partnerId?{partner_id:partnerId}:{}),...input},key,expected,async(q,context)=>{
    const p=await profile(q,t,i,true);ready(p);
    const m=await lockMaterial(q,t,i,id,expected);
    if(change==='copy')return receipt(q,context,id,await appendCopy(q,context,m,(input as z.infer<typeof SupplyMaterialCopyInputSchema>).body),operation);
    if(change==='grant') {
      const ids=(input as z.infer<typeof SupplyMaterialGrantInputSchema>).partner_ids;
      const eligible=(await q.query(`WITH target AS (SELECT * FROM supply_materials WHERE material_id=$5 AND tenant_id=$1 AND instance_id=$2),
        ${offers},${selections},${eligiblePartners} SELECT * FROM eligible_partners`,[...params(p),id])).rows;
      requireCondition(ids.every(id=>eligible.some(e=>e.partner_id===id)),409,'partner_not_eligible','有店家目前沒有可售或待確認的合作，不能授權。');
      requireCondition(ids.every(id=>!eligible.find(e=>e.partner_id===id)!.granted),409,'already_granted','有店家已經取得這個素材的授權。');
      const n=(await q.query('SELECT count(*)::int AS n FROM supply_material_grants WHERE material_id=$1 AND revoked_at IS NULL',[id])).rows[0].n;
      requireCondition(n+ids.length<=200,409,'material_grant_limit','這個素材的授權店家已達 200 間。');
      await q.query(`INSERT INTO supply_material_grants(grant_id,material_id,tenant_id,instance_id,partner_shop_id,granted_by_principal_id)
        SELECT gen_random_uuid(),$1,$2,$3,partner,$5 FROM unnest($4::uuid[]) partner`,[id,t,i,ids,context.principal_id]);
    }
    if(change==='revoke'||change==='withdraw') {
      const revoked=await q.query(`WITH at AS MATERIALIZED (SELECT clock_timestamp() AS now) UPDATE supply_material_grants SET revoked_at=at.now,revoked_by_principal_id=$2 FROM at
        WHERE material_id=$1 AND revoked_at IS NULL${change==='revoke'?' AND partner_shop_id=$3':''}`,[id,context.principal_id,...(change==='revoke'?[partnerId]:[])]);
      requireCondition(change==='withdraw'||revoked.rowCount===1,404,'not_found','這間店目前沒有這個素材的授權。');
    }
    const fields=change==='update'?SupplyMaterialUpdateInputSchema.parse(input):null;
    const access=change==='access'?SupplyMaterialAccessInputSchema.parse(input).access:null;
    const version=(await q.query(`UPDATE supply_materials SET aggregate_version=aggregate_version+1,
      title=COALESCE($2::text,title),description=COALESCE($3::text,description),access=COALESCE($4::text,access)
      ${change==='withdraw'?",state='withdrawn',withdrawn_at=clock_timestamp()":''}
      WHERE material_id=$1 RETURNING aggregate_version::text AS version`,[id,fields?.title??null,fields?.description??null,access])).rows[0].version;
    return receipt(q,context,id,version,operation);
  });
}
