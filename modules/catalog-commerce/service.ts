import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { command, checkVersion, digest, journal, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { text, money, currency } from '../../packages/shared/validation.js';
import type { Actor } from '../identity-membership/service.js';

const photoUrl=z.url().max(2000).refine(value=>{
  const u=new URL(value),host=u.hostname.toLowerCase();
  const local=/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(host) || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.');
  return u.protocol==='https:' && !u.username && !u.password && !local;
},'照片請使用不含帳密的 HTTPS 網址。').nullable().default(null);
const supplyFields={net_price_minor:money,currency,availability:z.enum(['finite','manual_confirmation']),stock:z.number().int().min(0).max(100000000).nullable(),shipping_terms:text(1500),return_terms:text(1500)};
const validStock=(b:{availability:string;stock:number|null})=>b.availability==='finite'?b.stock!==null:b.stock===null;
export const productInput=z.object({title:text(120),photo_url:photoUrl,specifications:text(2000),...supplyFields}).strict().refine(validStock,'有限庫存須填數量；待確認供貨請保留未知數量。');
export const offerInput=z.object(supplyFields).strict().refine(validStock,'庫存與供貨方式不相符。');
export const storeInput=z.object({name:text(120),description:text(1500),support_contact:text(250)}).strict();
export const listingInput=z.object({store_id:z.uuid(),offer_version_id:z.uuid(),retail_price_minor:money,sale_terms:text(1500)}).strict();
const snapshotInput=z.object({snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const decisionInput=snapshotInput.extend({decision:z.enum(['accepted','declined']),note:text(1000),acknowledge_internal_preview:z.literal(true)}).strict();

const commerceLimits={checkout_enabled:false,money_movement_enabled:false,official:false,confirmation_kind:'internal_preview'} as const;
function limited(row:any){return {...row,...commerceLimits};}

async function productScope(q:PoolClient,actor:Actor,id:string,owned=false,lock=false){
  const row=(await q.query(`SELECT * FROM catalog_products WHERE product_id=$1 AND community_id=$2${owned?' AND supplier_ref=$3':''}${lock?' FOR UPDATE':''}`,
    owned?[id,actor.community_id,actor.user_id]:[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到可操作的商品。');return row;
}
async function insertOffer(q:PoolClient,actor:Actor,product:any,body:z.infer<typeof offerInput>,revision:number){
  const offerId=randomUUID();
  const snapshot={offer_version_id:offerId,product_id:product.product_id,supplier_ref:actor.user_id,revision,title:product.title,
    photo_url:product.photo_url,specifications:product.specifications,product_type:'physical',qc_status:'unreviewed',...body};
  return (await q.query(`INSERT INTO supplier_offer_versions(offer_version_id,product_id,community_id,revision,supplier_ref,net_price_minor,currency,availability,stock,shipping_terms,return_terms,snapshot,snapshot_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [offerId,product.product_id,actor.community_id,revision,actor.user_id,body.net_price_minor,body.currency,body.availability,body.stock,body.shipping_terms,body.return_terms,JSON.stringify(snapshot),digest(snapshot)])).rows[0];
}
export async function createProduct(pool:Pool,input:Command){
  const body=productInput.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    const row=(await q.query(`INSERT INTO catalog_products(product_id,community_id,supplier_ref,title,photo_url,specifications)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),input.actor.community_id,input.actor.user_id,body.title,body.photo_url,body.specifications])).rows[0];
    const {title:_,photo_url:__,specifications:___,...terms}=body;
    const offer=await insertOffer(q,input.actor,row,terms,1);
    await journal(q,input.actor,'catalog_product',row.product_id,1,'submit_physical_product',{offer_version_id:offer.offer_version_id});
    return limited({...row,current_offer:offer,supplier_name:input.actor.display_name});
  });
}
export async function createOfferVersion(pool:Pool,input:Command,id:string){
  const body=offerInput.parse(input.body);
  return command(pool,input,q=>productScope(q,input.actor,id,true),async q=>{
    const product=await productScope(q,input.actor,id,true,true);checkVersion(product.aggregate_version,input.expected);
    const revision=Number((await q.query('SELECT max(revision) AS revision FROM supplier_offer_versions WHERE product_id=$1',[id])).rows[0].revision)+1;
    const offer=await insertOffer(q,input.actor,product,body,revision);
    const updated=(await q.query('UPDATE catalog_products SET aggregate_version=aggregate_version+1 WHERE product_id=$1 RETURNING *',[id])).rows[0];
    await journal(q,input.actor,'catalog_product',id,updated.aggregate_version,'revise_supply_terms',{offer_version_id:offer.offer_version_id});
    return limited({...updated,current_offer:offer,supplier_name:input.actor.display_name});
  });
}
export async function listProducts(pool:Pool,actor:Actor,owned=false){
  return (await pool.query(`SELECT p.*,u.display_name AS supplier_name,to_jsonb(o) AS current_offer FROM catalog_products p
    JOIN users u ON u.user_id=p.supplier_ref JOIN LATERAL (SELECT * FROM supplier_offer_versions o WHERE o.product_id=p.product_id ORDER BY revision DESC LIMIT 1) o ON true
    WHERE p.community_id=$1${owned?' AND p.supplier_ref=$2':''} ORDER BY p.created_at DESC,p.product_id`,owned?[actor.community_id,actor.user_id]:[actor.community_id])).rows.map(limited);
}
// Read-only application port. Marketing stores this exact snapshot; it never
// updates catalog tables or treats a supplier's declaration as verified QC.
export async function getMarketingProductSource(q:PoolClient,actor:Actor,id:string){
  const p=await productScope(q,actor,id,true);
  const o=(await q.query('SELECT * FROM supplier_offer_versions WHERE product_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0];
  return {source_type:'supplier_product',source_id:p.product_id,source_version:String(o.revision),offer_version_id:o.offer_version_id,
    source_sha256:o.snapshot_sha256,title:p.title,description:p.specifications,photo_url:p.photo_url,
    net_price_minor:o.net_price_minor,currency:o.currency,availability:o.availability,stock:o.stock,
    shipping_terms:o.shipping_terms,return_terms:o.return_terms,qc_status:'unreviewed',official:false,checkout_enabled:false};
}
export async function createStore(pool:Pool,input:Command){
  const body=storeInput.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    const row=(await q.query(`INSERT INTO retail_stores(store_id,community_id,seller_ref,name,description,support_contact)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),input.actor.community_id,input.actor.user_id,body.name,body.description,body.support_contact])).rows[0];
    await journal(q,input.actor,'retail_store',row.store_id,1,'create_internal_store');return limited(row);
  });
}
export async function listStores(pool:Pool,actor:Actor){
  return (await pool.query('SELECT * FROM retail_stores WHERE community_id=$1 AND seller_ref=$2 ORDER BY created_at DESC',[actor.community_id,actor.user_id])).rows.map(limited);
}
async function ownStore(q:PoolClient,actor:Actor,id:string){
  const row=(await q.query('SELECT * FROM retail_stores WHERE store_id=$1 AND community_id=$2 AND seller_ref=$3',[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'not_found','找不到你的商店。');return row;
}
async function visibleOffer(q:PoolClient,actor:Actor,id:string){
  const row=(await q.query('SELECT * FROM supplier_offer_versions WHERE offer_version_id=$1 AND community_id=$2',[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這個供貨版本。');return row;
}
export async function createListing(pool:Pool,input:Command){
  const body=listingInput.parse(input.body);
  return command(pool,input,async q=>{await ownStore(q,input.actor,body.store_id);await visibleOffer(q,input.actor,body.offer_version_id);},async q=>{
    const store=await ownStore(q,input.actor,body.store_id),offer=await visibleOffer(q,input.actor,body.offer_version_id),id=randomUUID();
    const snapshot={listing_id:id,store_id:store.store_id,store_name:store.name,seller_ref:input.actor.user_id,supplier_ref:offer.supplier_ref,
      offer_version_id:offer.offer_version_id,supplier_offer_sha256:offer.snapshot_sha256,supply:offer.snapshot,
      retail_price_minor:body.retail_price_minor,currency:offer.currency,sale_terms:body.sale_terms,confirmation_kind:'internal_preview'};
    const row=(await q.query(`INSERT INTO retail_listing_revisions(listing_id,community_id,store_id,offer_version_id,seller_ref,supplier_ref,retail_price_minor,currency,sale_terms,snapshot,snapshot_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,input.actor.community_id,store.store_id,offer.offer_version_id,input.actor.user_id,offer.supplier_ref,body.retail_price_minor,offer.currency,body.sale_terms,JSON.stringify(snapshot),digest(snapshot)])).rows[0];
    await journal(q,input.actor,'retail_listing',id,1,'create_listing_draft',{snapshot_sha256:row.snapshot_sha256});return limited(row);
  });
}
export async function listListings(pool:Pool,actor:Actor){
  return (await pool.query(`SELECT l.*,a.acceptance_id,a.state AS acceptance_state,a.decision_note FROM retail_listing_revisions l
    LEFT JOIN distribution_acceptances a USING(listing_id) WHERE l.community_id=$1 AND l.seller_ref=$2 ORDER BY l.created_at DESC`,[actor.community_id,actor.user_id])).rows.map(limited);
}
async function ownListing(q:PoolClient,actor:Actor,id:string,lock=false){
  const row=(await q.query(`SELECT * FROM retail_listing_revisions WHERE listing_id=$1 AND community_id=$2 AND seller_ref=$3${lock?' FOR UPDATE':''}`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'not_found','找不到你的選品草稿。');return row;
}
export async function requestSupply(pool:Pool,input:Command,id:string){
  const body=snapshotInput.parse(input.body);
  return command(pool,input,q=>ownListing(q,input.actor,id),async q=>{
    const listing=await ownListing(q,input.actor,id,true);checkVersion(listing.aggregate_version,input.expected);
    requireCondition(listing.state==='draft',409,'invalid_state','這份選品已經送出。');
    requireCondition(listing.snapshot_sha256===body.snapshot_sha256,409,'snapshot_changed','請確認目前選品的價格與供貨版本。');
    const acceptance=(await q.query(`INSERT INTO distribution_acceptances(acceptance_id,listing_id,community_id,supplier_ref,seller_ref,snapshot_sha256)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),id,input.actor.community_id,listing.supplier_ref,input.actor.user_id,listing.snapshot_sha256])).rows[0];
    const updated=(await q.query("UPDATE retail_listing_revisions SET state='requested',aggregate_version=aggregate_version+1 WHERE listing_id=$1 RETURNING *",[id])).rows[0];
    await journal(q,input.actor,'retail_listing',id,updated.aggregate_version,'request_internal_supply',{acceptance_id:acceptance.acceptance_id,snapshot_sha256:listing.snapshot_sha256});
    return limited({...updated,acceptance_id:acceptance.acceptance_id});
  });
}
export async function listSupplyRequests(pool:Pool,actor:Actor){
  return (await pool.query(`SELECT a.*,l.snapshot,u.display_name AS seller_name FROM distribution_acceptances a
    JOIN retail_listing_revisions l USING(listing_id) JOIN users u ON u.user_id=a.seller_ref
    WHERE a.community_id=$1 AND a.supplier_ref=$2 ORDER BY a.created_at DESC`,[actor.community_id,actor.user_id])).rows.map(limited);
}
async function ownRequest(q:PoolClient,actor:Actor,id:string,lock=false){
  const row=(await q.query(`SELECT * FROM distribution_acceptances WHERE acceptance_id=$1 AND community_id=$2 AND supplier_ref=$3${lock?' FOR UPDATE':''}`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'not_found','找不到可由你回覆的供貨請求。');return row;
}
export async function decideSupply(pool:Pool,input:Command,id:string){
  const body=decisionInput.parse(input.body);
  return command(pool,input,q=>ownRequest(q,input.actor,id),async q=>{
    const acceptance=await ownRequest(q,input.actor,id,true);checkVersion(acceptance.aggregate_version,input.expected);
    requireCondition(acceptance.state==='requested',409,'invalid_state','供貨請求已有回覆。');
    requireCondition(body.snapshot_sha256===acceptance.snapshot_sha256,409,'snapshot_changed','選品內容與你確認的版本不一致。');
    const listing=(await q.query('SELECT * FROM retail_listing_revisions WHERE listing_id=$1 FOR UPDATE',[acceptance.listing_id])).rows[0];
    requireCondition(listing.state==='requested' && listing.snapshot_sha256===body.snapshot_sha256,409,'invalid_state','選品版本已變更。');
    const updated=(await q.query(`UPDATE distribution_acceptances SET state=$2,decision_note=$3,decided_at=now(),aggregate_version=aggregate_version+1 WHERE acceptance_id=$1 RETURNING *`,[id,body.decision,body.note])).rows[0];
    const updatedListing=(await q.query('UPDATE retail_listing_revisions SET state=$2,aggregate_version=aggregate_version+1 WHERE listing_id=$1 RETURNING *',[listing.listing_id,body.decision])).rows[0];
    await journal(q,input.actor,'distribution_acceptance',id,updated.aggregate_version,`internal_preview_${body.decision}`,{snapshot_sha256:body.snapshot_sha256,official:false});
    await journal(q,input.actor,'retail_listing',listing.listing_id,updatedListing.aggregate_version,`supply_${body.decision}`,{acceptance_id:id});
    return limited(updated);
  });
}
