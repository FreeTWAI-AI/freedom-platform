import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives';
export type ConsoleScope={tenantId:string;instanceId:string};
export type ProductState='offered'|'not_offered'|'outdated'|'out_of_stock';
export type ProductSort='sku'|'title'|'available';
const pages=[
 ['overview','營運概覽','營運','read'],['products','商品與庫存','營運','write'],['reservations','預留與訂單','營運','owner'],
 ['partners','合作店家','合作','write'],['terms','供貨條件與審核','合作','write'],['settings','設定與資料','管理','read'],
 ['product-new','新增商品',null,'write','products'],['product','商品詳情',null,'write','products'],
 ['partner','合作店家詳情',null,'write','partners'],['review','審核售價申請',null,'write','terms'],['not-found','找不到這個頁面',null,'read'],
] as const;
export const SUPPLIER_CONSOLE_PAGES=pages.map(([page,title,group,requires,parent])=>({page,title,titleKey:`supplierConsole.${page}` as const,group,label:title,requires,parent}));
export type ConsolePage=typeof pages[number][0];
export type SupplierConsoleRoute=ConsoleScope & {page:ConsolePage;titleKey:typeof SUPPLIER_CONSOLE_PAGES[number]['titleKey'];id?:string;state?:ProductState;sort?:ProductSort};
export function parseSupplierConsoleRoute(hash:string):SupplierConsoleRoute|null {
 const split=hash.indexOf('?'),path=split<0?hash:hash.slice(0,split),query=new URLSearchParams(split<0?'':hash.slice(split+1));
 const parts=path.split('/');
 if(parts[0]!=='#stores'||!OpaqueId.safeParse(parts[1]).success||!OpaqueId.safeParse(parts[2]).success||!['supply','supply-orders'].includes(parts[3]))return null;
 const rest=parts.slice(4);let page:ConsolePage='not-found',id:string|undefined;
 if(parts[3]==='supply-orders'){if(!rest.length)page='reservations';}
 else if(!rest.length)page='overview';
 else if(rest.length===1&&['products','partners','terms','reservations','settings'].includes(rest[0]))page=rest[0] as ConsolePage;
 else if(rest.length===2&&rest[0]==='products'&&rest[1]==='new')page='product-new';
 else if(rest.length===2&&OpaqueId.safeParse(rest[1]).success&&['products','partners','terms'].includes(rest[0])){page=rest[0]==='products'?'product':rest[0]==='partners'?'partner':'review';id=rest[1];}
 const state=query.get('state'),sort=query.get('sort');
 return {tenantId:parts[1],instanceId:parts[2],page,titleKey:SUPPLIER_CONSOLE_PAGES.find(p=>p.page===page)!.titleKey,...(id?{id}:{}),
 ...(page==='products'&&['offered','not_offered','outdated','out_of_stock'].includes(state??'')?{state:state as ProductState}:{}),
 ...(page==='products'&&['sku','title','available'].includes(sort??'')?{sort:sort as ProductSort}:{})};
}
export function supplierConsoleHref(scope:ConsoleScope,page:ConsolePage,extra:{id?:string;state?:ProductState;sort?:ProductSort}={}) {
 const suffix=page==='overview'?'':page==='product-new'?'/products/new':page==='product'?`/products/${extra.id}`:page==='partner'?`/partners/${extra.id}`:page==='review'?`/terms/${extra.id}`:page==='not-found'?'/missing':`/${page}`;
 const q=new URLSearchParams();if(page==='products'){if(extra.state)q.set('state',extra.state);if(extra.sort)q.set('sort',extra.sort);}
 return `#stores/${scope.tenantId}/${scope.instanceId}/supply${suffix}${q.size?'?'+q:''}`;
}
export function sameConsoleScope(hash:string,scope:ConsoleScope){const r=parseSupplierConsoleRoute(hash);return r?.tenantId===scope.tenantId&&r?.instanceId===scope.instanceId;}
export function consoleNavigation(capabilities:readonly string[],owner:boolean){return SUPPLIER_CONSOLE_PAGES.filter(p=>p.group&&(p.requires==='read'||capabilities.includes('store:write')&&(p.requires!=='owner'||owner)));}
