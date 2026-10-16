import {OpaqueId} from '../../../contracts/guild-launchpad/v1/primitives';
export type SellerScope={tenantId:string;instanceId:string};
export type SellerPage='orders'|'order'|'reservations'|'payments'|'case'|'settings'|'settings-payments';
export type SellerQuery={lifecycle?:'open'|'cancelled'|'closed';needs_action?:'true';display_number?:string;state?:'open'|'closed'};
export type SellerConsoleRoute=SellerScope & {page:SellerPage;titleKey:`sellerConsole.${SellerPage}`;id?:string;query:SellerQuery};
export const displayNumberPattern=/^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$(?![\s\S])/;
function parts(hash:string){const [path,query='']=hash.split('?');return {p:path.split('/'),q:new URLSearchParams(query)};}
function scope(p:string[]):SellerScope|null{return p[0]==='#stores'&&OpaqueId.safeParse(p[1]).success&&OpaqueId.safeParse(p[2]).success?{tenantId:p[1],instanceId:p[2]}:null;}
export function parseSellerConsoleRoute(hash:string):SellerConsoleRoute|null {
 const {p,q}=parts(hash),s=scope(p);if(!s)return null;
 let page:SellerPage,id:string|undefined;
 if(p.length===4&&['orders','payments','settings'].includes(p[3]))page=p[3] as SellerPage;
 else if(p.length===5&&p[3]==='orders'&&p[4]==='reservations')page='reservations';
 else if(p.length===5&&p[3]==='settings'&&p[4]==='payments')page='settings-payments';
 else if(p.length===5&&['orders','payments'].includes(p[3])&&OpaqueId.safeParse(p[4]).success){page=p[3]==='orders'?'order':'case';id=p[4];}
 else return null;
 const query:SellerQuery={};
 if(page==='orders'){
  const lifecycle=q.get('lifecycle');if(['open','cancelled','closed'].includes(lifecycle??''))query.lifecycle=lifecycle as SellerQuery['lifecycle'];
  if(q.get('needs_action')==='true')query.needs_action='true';
  // Keep an invalid known filter visible so the form can explain it without issuing a read.
  if(q.has('display_number'))query.display_number=q.get('display_number')!;
 }
 if(page==='payments'&&['open','closed'].includes(q.get('state')??''))query.state=q.get('state') as SellerQuery['state'];
 return {...s,page,titleKey:`sellerConsole.${page}`,...(id?{id}:{}),query};
}
export function sellerRootHref(s:SellerScope){return `#stores/${OpaqueId.parse(s.tenantId)}/${OpaqueId.parse(s.instanceId)}`;}
export function sellerConsoleHref(s:SellerScope,page:SellerPage,options:{id?:string;query?:SellerQuery}={}){
 const suffix=page==='order'?`orders/${OpaqueId.parse(options.id)}`:page==='case'?`payments/${OpaqueId.parse(options.id)}`:page==='reservations'?'orders/reservations':page==='settings-payments'?'settings/payments':page;
 const query=new URLSearchParams();
 if(page==='orders')for(const key of ['lifecycle','needs_action','display_number'] as const){const v=options.query?.[key];if(v)query.set(key,v);}
 if(page==='payments'&&options.query?.state)query.set('state',options.query.state);
 return `${sellerRootHref(s)}/${suffix}${query.size?'?'+query:''}`;
}
export const SELLER_NAVIGATION=[
 {key:'orders',label:'訂單',group:'營運',capability:'store:orders:read'},
 {key:'payments',label:'收款與對帳',group:'帳務',capability:'store:finance:read'},
 {key:'settings',label:'商店設定',group:'設定',capability:'store:manage'},
] as const;
export function sellerNavigation(capabilities:readonly string[]){return SELLER_NAVIGATION.filter(p=>capabilities.includes(p.capability));}
export function sellerPageCapability(page:SellerPage){return page==='reservations'?null:page==='orders'||page==='order'?'store:orders:read':page==='payments'||page==='case'?'store:finance:read':'store:manage';}
const slugs=['fulfilment','shipments','customers','support','storefront','products','sourcing','promotions','payments','invoices','reports','settings'];
/** Dispatch only: never rewrites the hash or enters Supplier Console paths. */
export function sellerSlugFallback(hash:string):(SellerScope & {orders:boolean})|null {
 const {p}=parts(hash),s=scope(p);if(!s||p.length<4)return null;
 if(p[3]==='orders')return p.length>=5&&(OpaqueId.safeParse(p[4]).success||p[4]==='reservations')?{...s,orders:true}:null;
 return slugs.includes(p[3])?{...s,orders:false}:null;
}
