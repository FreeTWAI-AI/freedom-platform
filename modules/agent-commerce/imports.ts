import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {command,digest,journal,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {importInput,manifestInput,parseManifestFile,type ShopManifest} from './schema.js';
import {listingDigest,resellerArrangement} from './distribution.js';

export async function catalog(pool:Pool,actor:Actor){
 return (await pool.query(`SELECT i.*,s.name AS shop_name,s.currency,s.mode,s.shop_id FROM commerce_items i JOIN commerce_shops s USING(shop_id)
 JOIN users u ON u.user_id=s.owner_id WHERE s.origin='imported' AND s.community_id=$1 AND s.accepting_orders AND u.active ORDER BY i.title,i.item_id`,[actor.community_id])).rows;
}
export async function ownShops(pool:Pool,actor:Actor){
 return (await pool.query(`SELECT s.*,k.expires_at AS key_expires_at,k.revoked_at AS key_revoked_at,
 (SELECT count(*)::int FROM commerce_items i WHERE i.shop_id=s.shop_id) AS product_count,
 (SELECT count(*)::int FROM commerce_selections l WHERE l.shop_id=s.shop_id) AS selection_count
 FROM commerce_shops s LEFT JOIN commerce_shop_keys k USING(shop_id) WHERE s.origin='imported' AND s.community_id=$1 AND s.owner_id=$2 ORDER BY s.created_at DESC`,[actor.community_id,actor.user_id])).rows;
}
export async function ownShop(q:Pool|PoolClient,actor:Pick<Actor,'user_id'|'community_id'>,id:string){
 const shop=(await q.query("SELECT * FROM commerce_shops WHERE origin='imported' AND shop_id=$1 AND community_id=$2 AND owner_id=$3",[id,actor.community_id,actor.user_id])).rows[0];
 requireCondition(shop,404,'shop_not_found','找不到你的商店。');return shop;
}
async function checkedSelections(q:Pool|PoolClient,actor:Actor,m:ShopManifest){
 if(m.kind==='internal')return [];
 const result=[];
 for(const selection of m.selections){
  const item=(await q.query(`SELECT i.*,s.currency,s.mode,s.accepting_orders,s.owner_id,s.community_id FROM commerce_items i JOIN commerce_shops s USING(shop_id)
   JOIN users u ON u.user_id=s.owner_id WHERE s.origin='imported' AND i.item_id=$1 AND s.community_id=$2 AND u.active`,[selection.item_id,actor.community_id])).rows[0];
  requireCondition(item,422,'item_unavailable','部分商品不存在或不可選，請重新下載開店包。');
  requireCondition(item.accepting_orders&&item.mode===m.mode,422,'shop_mode_mismatch','商品與商店的測試／正式模式不一致，或商品已暫停接單。');
  requireCondition(item.currency===m.currency,422,'currency_mismatch','同一家商店請選擇相同幣別的商品。');
  result.push({selection,item});
 }
 return result;
}
export async function previewImport(pool:Pool,actor:Actor,raw:unknown){
 const manifest=manifestInput.parse(raw);await checkedSelections(pool,actor,manifest);
 return {manifest,sha256:digest(manifest),count:manifest.kind==='internal'?manifest.products.length:manifest.selections.length};
}
export async function importShop(pool:Pool,input:Command){
 const {manifest:m}=importInput.parse(input.body);
 return command(pool,input,async()=>{},async q=>{
  const hash=digest(m);
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shop-import/${input.actor.user_id}/${hash}`]);
  const prior=(await q.query("SELECT shop_id FROM commerce_shops WHERE origin='imported' AND owner_id=$1 AND manifest_sha256=$2",[input.actor.user_id,hash])).rows[0];
  if(prior)return {...prior,reused:true};
  const selections=await checkedSelections(q,input.actor,m),id=randomUUID();
  await q.query("INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,name,description,website_url,contact,currency,manifest_sha256,mode,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'imported')",[id,input.actor.community_id,input.actor.user_id,m.kind,m.name,m.description,m.website_url,m.contact,m.currency,hash,m.mode]);
  if(m.kind==='internal')for(const p of m.products)await q.query(`INSERT INTO commerce_items(item_id,shop_id,sku,title,description,photo_url,price_minor,shipping_minor,stock,shipping_terms,return_terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),id,p.sku,p.title,p.description,p.photo_url,p.price_minor,p.shipping_minor,p.stock,p.shipping_terms,p.return_terms]);
  for(const {selection:s,item} of selections){
   const selectionId=randomUUID();
   const snapshot={selection_id:selectionId,item_id:item.item_id,sku:item.sku,public_shop_id:id,internal_shop_id:item.shop_id,title:item.title,description:item.description,photo_url:item.photo_url,cost_minor:Number(item.price_minor),shipping_minor:Number(item.shipping_minor),tax_minor:0,currency:m.currency,shipping_terms:item.shipping_terms,return_terms:item.return_terms,retail_price_minor:s.retail_price_minor,sale_terms:s.sale_terms,arrangement:resellerArrangement(input.actor.user_id,item.owner_id)};
   const listingSha=listingDigest(snapshot);
   await q.query('INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[selectionId,id,item.item_id,s.retail_price_minor,s.sale_terms,{...snapshot,listing_sha256:listingSha},listingSha]);
  }
  await journal(q,input.actor,'commerce_shop',id,1,'import_agent_shop',{kind:m.kind,manifest_sha256:hash});
  return {shop_id:id,reused:false};
 });
}
const manifestUrlMessage='網址請用 GitHub 原始 JSON／MD 檔；其他平台請下載成果檔後直接上傳。';
const manifestFetchMessage='無法讀取成果檔，請改用上傳。';
// Only fixed raw GitHub content is fetched. No redirects, cookies, auth, private URLs or executable HTML.
function allowedManifestUrl(u:URL){
 return u.protocol==='https:'&&u.hostname==='raw.githubusercontent.com'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[^/]+\/[^/]+\/[^/]+\/.+\.(json|md)$/.test(u.pathname);
}
export async function fetchManifest(url:string,fetcher:typeof fetch=fetch){
 let u:URL;try{u=new URL(url);}catch{throw new Problem(422,'manifest_url_unsupported',manifestUrlMessage);}
 requireCondition(allowedManifestUrl(u),422,'manifest_url_unsupported',manifestUrlMessage);
 const response=await fetcher(u.href,{redirect:'manual',credentials:'omit',referrer:'no-referrer',signal:AbortSignal.timeout(8000),headers:{Accept:'text/plain, application/json'}});
 requireCondition(response.status===200&&!response.redirected&&response.body,422,'manifest_fetch_failed',manifestFetchMessage);
 if(response.url){let final:URL;try{final=new URL(response.url);}catch{throw new Problem(422,'manifest_fetch_failed',manifestFetchMessage);}requireCondition(allowedManifestUrl(final),422,'manifest_url_unsupported',manifestUrlMessage);}
 const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;requireCondition(bytes<=24000,413,'manifest_too_large','成果檔上限 24 KB。');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return parseManifestFile(Buffer.concat(chunks).toString('utf8'));
}
