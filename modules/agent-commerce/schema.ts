import {z} from 'zod';
import {Problem} from '../../packages/shared/problem.js';
import {text,money,currency} from '../../packages/shared/validation.js';

// No URL is fetched except the separate, strictly allowlisted manifest reader.
export const httpsUrl=z.url().max(2000).refine(value=>{
 const u=new URL(value),h=u.hostname.toLowerCase();
 return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&
 !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(h)&&h.includes('.')&&!h.endsWith('.local')&&!h.endsWith('.localhost');
},'請提供不含帳密的公開 HTTPS 網址。');
const base={schema:z.literal('freedom-shop/v1'),mode:z.enum(['test','live']).default('test'),name:text(120),description:text(1500),website_url:httpsUrl,contact:text(250),currency};
const unique=<T>(items:T[],key:(item:T)=>string)=>new Set(items.map(key)).size===items.length;
export const manifestInput=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('internal'),access:z.literal('authenticated'),products:z.array(z.object({sku:text(80),title:text(120),description:text(2000),photo_url:httpsUrl.nullable(),price_minor:money,shipping_minor:z.number().int().min(0).max(100000000000),stock:z.number().int().min(0).max(1000000),shipping_terms:text(1500),return_terms:text(1500)}).strict()).min(1).max(50).refine(items=>unique(items,p=>p.sku),'商品代號不可重複。')}).strict(),
 z.object({...base,kind:z.literal('public'),selections:z.array(z.object({item_id:z.uuid(),retail_price_minor:money,sale_terms:text(1500)}).strict()).min(1).max(50).refine(items=>unique(items,p=>p.item_id),'商品不可重複。')}).strict()
]);
export type ShopManifest=z.infer<typeof manifestInput>;
export const importInput=z.object({manifest:manifestInput,confirmed:z.literal(true)}).strict();
export const orderInput=z.object({external_id:text(100),items:z.array(z.object({selection_id:z.uuid(),quantity:z.number().int().min(1).max(99),delivery_ref:z.string().regex(/^[a-zA-Z0-9_-]{8,120}$/)}).strict()).min(1).max(50).refine(items=>unique(items,p=>p.selection_id),'選品不可重複。')}).strict();
// provider_verified_by_merchant is the shop's own claim. It does not create a SupplierPayable or move money. See handoff section 11.
export const paymentInput=z.object({event_id:text(120),type:z.enum(['paid','refunded']),provider:text(80),transaction_ref:text(160),amount_minor:money,currency,mode:z.enum(['test','live']),verification:z.literal('provider_verified_by_merchant')}).strict();
export const shipmentInput=z.object({method:z.enum(['carrier','self_delivery','pickup']),carrier:z.string().trim().max(80),tracking_number:z.string().trim().max(120),shipped_at:z.iso.datetime({offset:true})}).strict().refine(s=>s.method!=='carrier'||Boolean(s.carrier&&s.tracking_number),'宅配請填物流公司與單號。');
export function parseManifestFile(content:string):ShopManifest{
 if(new TextEncoder().encode(content).length>24000)throw new Problem(413,'manifest_too_large','成果檔上限 24 KB，請讓 AI 精簡文字並以網址提供圖片。');
 let raw=content.trim();
 if(!raw.startsWith('{')){
  const blocks=[...raw.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if(blocks.length!==1)throw new Problem(422,'manifest_invalid','請上傳商品成果 JSON，或包含一個 JSON 成果區塊的 MD。');
  raw=blocks[0][1];
 }
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new Problem(422,'manifest_invalid','成果檔不是有效 JSON，請交給 AI 修正。');}
 return manifestInput.parse(parsed);
}
