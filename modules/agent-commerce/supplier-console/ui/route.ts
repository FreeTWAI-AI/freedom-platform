import {SupplierReportQuerySchema,type SupplierReportQuery} from '../../../../contracts/guild-launchpad/v1/supplier-console';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives';
export type ConsoleScope={tenantId:string;instanceId:string};
export type ReportPeriod=SupplierReportQuery;
export function taipeiToday(now:number):string{return new Date(now+8*60*60*1000).toISOString().slice(0,10);}
export function defaultReportPeriod(now:number):ReportPeriod{return {from:taipeiToday(now-29*86_400_000),to:taipeiToday(now)};}
export type ProductState='offered'|'not_offered'|'outdated'|'out_of_stock';
export type ProductSort='sku'|'title'|'available';
export type ReservationFilters={state?:'reserved'|'cancelled'|'expired';partner?:string;product?:string;from?:string;to?:string};
export function validLocalDate(value:string):boolean {
 if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))return false;
 const [year,month,day]=value.split('-').map(Number),date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(0,0,0,0);
 return year>0&&date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}
function cleanReservationFilters(input:ReservationFilters):ReservationFilters {
 return {...(['reserved','cancelled','expired'].includes(input.state??'')?{state:input.state}:{}),
 ...(OpaqueId.safeParse(input.partner).success?{partner:input.partner}:{}),...(OpaqueId.safeParse(input.product).success?{product:input.product}:{}),
 ...(input.from&&validLocalDate(input.from)?{from:input.from}:{}),...(input.to&&validLocalDate(input.to)?{to:input.to}:{})};
}
export function reservationFilterParams(filters:ReservationFilters):URLSearchParams|null {
 if(filters.from&&!validLocalDate(filters.from)||filters.to&&!validLocalDate(filters.to)||filters.from&&filters.to&&filters.from>filters.to)return null;
 const q=new URLSearchParams();if(filters.state)q.set('state',filters.state);if(filters.partner)q.set('partner_id',filters.partner);if(filters.product)q.set('product_id',filters.product);
 // Asia/Taipei days (UTC+8, no DST) in any browser zone; `to` is the next day's exclusive midnight.
 for(const field of ['from','to'] as const)if(filters[field])q.set(field,new Date(Date.parse(`${filters[field]}T00:00:00+08:00`)+(field==='to'?86_400_000:0)).toISOString());
 return q;
}
const pages=[
 ['overview','營運概覽','營運','read'],['products','商品與庫存','營運','write'],['reservations','預留與訂單','營運','owner'],
 ['partners','合作店家','合作','write'],['terms','供貨條件與審核','合作','write'],['materials','行銷素材','管理','write'],['reports','營運報表','管理','write'],['settings','設定與資料','管理','read'],
 ['material-new','新增素材',null,'write','materials'],['material','素材詳情',null,'write','materials'],
 ['product-new','新增商品',null,'write','products'],['product','商品詳情',null,'write','products'],
 ['reservation','預留明細',null,'owner','reservations'],['partner','合作店家詳情',null,'write','partners'],['review','審核售價申請',null,'write','terms'],['not-found','找不到這個頁面',null,'read'],
] as const;
export const SUPPLIER_CONSOLE_PAGES=pages.map(([page,title,group,requires,parent])=>({page,title,titleKey:`supplierConsole.${page}` as const,group,label:title,requires,parent}));
export type ConsolePage=typeof pages[number][0];
export type SupplierConsoleRoute=ConsoleScope & {page:ConsolePage;titleKey:typeof SUPPLIER_CONSOLE_PAGES[number]['titleKey'];id?:string;state?:ProductState;sort?:ProductSort;reservation?:ReservationFilters;period?:ReportPeriod};
export function parseSupplierConsoleRoute(hash:string):SupplierConsoleRoute|null {
 const split=hash.indexOf('?'),path=split<0?hash:hash.slice(0,split),query=new URLSearchParams(split<0?'':hash.slice(split+1));
 const parts=path.split('/');
 if(parts[0]!=='#stores'||!OpaqueId.safeParse(parts[1]).success||!OpaqueId.safeParse(parts[2]).success||!['supply','supply-orders'].includes(parts[3]))return null;
 const rest=parts.slice(4);let page:ConsolePage='not-found',id:string|undefined;
 if(parts[3]==='supply-orders'){if(!rest.length)page='reservations';}
 else if(!rest.length)page='overview';
 else if(rest.length===1&&['products','partners','terms','reservations','materials','reports','settings'].includes(rest[0]))page=rest[0] as ConsolePage;
 else if(rest.length===2&&rest[0]==='materials'&&rest[1]==='new')page='material-new';
 else if(rest.length===2&&rest[0]==='materials'&&OpaqueId.safeParse(rest[1]).success){page='material';id=rest[1];}
 else if(rest.length===2&&rest[0]==='products'&&rest[1]==='new')page='product-new';
 else if(rest.length===2&&OpaqueId.safeParse(rest[1]).success&&['products','partners','terms','reservations'].includes(rest[0])){page=rest[0]==='products'?'product':rest[0]==='partners'?'partner':rest[0]==='reservations'?'reservation':'review';id=rest[1];}
 const state=query.get('state'),sort=query.get('sort'),period=SupplierReportQuerySchema.safeParse({from:query.get('from'),to:query.get('to')});
 return {tenantId:parts[1],instanceId:parts[2],page,titleKey:SUPPLIER_CONSOLE_PAGES.find(p=>p.page===page)!.titleKey,...(id?{id}:{}),
 ...(page==='products'&&['offered','not_offered','outdated','out_of_stock'].includes(state??'')?{state:state as ProductState}:{}),
 ...(page==='reports'&&period.success?{period:period.data}:{}),
 ...(page==='reservations'?{reservation:cleanReservationFilters(Object.fromEntries(['state','partner','product','from','to'].map(key=>[key,query.get(key)??undefined])) as ReservationFilters)}:{}),
 ...(page==='products'&&['sku','title','available'].includes(sort??'')?{sort:sort as ProductSort}:{})};
}
export function supplierConsoleHref(scope:ConsoleScope,page:ConsolePage,extra:{id?:string;state?:ProductState;sort?:ProductSort;reservation?:ReservationFilters;period?:ReportPeriod}={}) {
 const suffix=page==='overview'?'':page==='material-new'?'/materials/new':page==='material'?`/materials/${extra.id}`:page==='product-new'?'/products/new':page==='product'?`/products/${extra.id}`:page==='reservation'?`/reservations/${extra.id}`:page==='partner'?`/partners/${extra.id}`:page==='review'?`/terms/${extra.id}`:page==='not-found'?'/missing':`/${page}`;
 const q=new URLSearchParams();if(page==='products'){if(extra.state)q.set('state',extra.state);if(extra.sort)q.set('sort',extra.sort);}
 if(page==='reports'){const period=SupplierReportQuerySchema.safeParse(extra.period);if(period.success){q.set('from',period.data.from);q.set('to',period.data.to);}}
 if(page==='reservations'){const filters=cleanReservationFilters(extra.reservation??{});for(const key of ['state','partner','product','from','to'] as const)if(filters[key])q.set(key,filters[key]!);}
 return `#stores/${scope.tenantId}/${scope.instanceId}/supply${suffix}${q.size?'?'+q:''}`;
}
export function sameConsoleScope(hash:string,scope:ConsoleScope){const r=parseSupplierConsoleRoute(hash);return r?.tenantId===scope.tenantId&&r?.instanceId===scope.instanceId;}
export function consoleNavigation(capabilities:readonly string[],owner:boolean){return SUPPLIER_CONSOLE_PAGES.filter(p=>p.group&&(p.requires==='read'||capabilities.includes('store:write')&&(p.requires!=='owner'||owner)));}
