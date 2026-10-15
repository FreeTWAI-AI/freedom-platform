import {useEffect,useRef,useState} from 'react';
import type {z} from 'zod';
import {ApiError,type PortalClient} from '../../../../apps/portal-web/src/api';
import {SupplyCatalogViewSchema,SupplyCatalogSetupInputSchema,SupplyProductInputSchema,SupplyProductUpdateInputSchema,type SupplyCatalogView} from '../../../../contracts/guild-launchpad/v1/hosted-supply-catalog';
import {SupplierReportSchema,type SupplierReport,SupplierReservationsSchema,SupplierReservationDetailSchema,SupplierChangesSchema,SupplierOverviewSchema,SupplierProductsSchema,SupplierProductDetailSchema,SupplierPartnersSchema,SupplierPartnerDetailSchema,SupplierRequestDetailSchema,SupplyProfileUpdateInputSchema,type SupplierProductDetail} from '../../../../contracts/guild-launchpad/v1/supplier-console';
import {DistributionsSchema,SupplyOffersSchema} from '../../../../contracts/guild-launchpad/v1/hosted-distribution';
import {SupplyTermsInputSchema} from '../../../../contracts/guild-launchpad/v1/hosted-supply-terms';
import {ReservationSettingSchema} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order';
import {ProductMediaPageSchema} from '../../../../contracts/guild-launchpad/v1/hosted-store-media';
import {heldPhotoAttempt} from '../../../../apps/portal-web/src/modules/hosted-store-photo-state';
import {createAttempt,classifyCommandOutcome,ATTEMPT_KINDS,type Attempt,type AttemptKind,refusalReleased} from './attempt';
import {holdAttempt,markAttemptUnknown,releaseAttempt,restoreAttempt,consolePhotoTargets,rememberConsolePhoto} from './registry';
import {editDraft,staleDrafts,discardDraft,reapplyAttempt,type Drafts,type Fields} from './drafts';
import {leaveDecision} from './leave';
import {defaultReportPeriod,type ReportPeriod,supplierConsoleHref,reservationFilterParams,type ReservationFilters,type ConsoleScope,type SupplierConsoleRoute} from '../ui/route';
import {commandFields} from '../ui/view';
export type ReadSlot<T>={state:'idle'|'loading'|'ready'|'failed';data:T|null;asOf:string|null;lastOkAt:string|null;error:string;status?:number};
const empty:ReadSlot<never>={state:'idle',data:null,asOf:null,lastOkAt:null,error:''};
export type ListPosition={search:string;filter:string;sort:string;scroll:number;lastId:string|null};
export type RegisterLeave=(guard:((nextHash:string|null)=>boolean)|null)=>void;
export function reportMatchesReadKey(data:SupplierReport,scope:ConsoleScope,key:string):boolean {return data.tenant_id===scope.tenantId&&data.instance_id===scope.instanceId&&key===`report:${data.period.from}:${data.period.to}`;}
export function useSupplierConsoleController({client,userId,scope,route,registerLeave,photosEnabled}:{client:PortalClient;userId:string;scope:ConsoleScope;route:SupplierConsoleRoute;registerLeave:RegisterLeave;photosEnabled:boolean}) {
 const [reads,setReads]=useState<Record<string,ReadSlot<unknown>>>({}),[drafts,setDrafts]=useState<Drafts>({});
 const [attempt,setAttempt]=useState<Attempt|null>(()=>restoreAttempt(client,userId,scope)),[phase,setPhase]=useState<'idle'|'sending'|'held'>(()=>attempt?'held':'idle');
 const [notice,setNotice]=useState(''),[error,setError]=useState(''),[revoked,setRevoked]=useState(false),[conflicts,setConflicts]=useState<Record<string,Attempt>>({}),[rejected,setRejected]=useState<Attempt|null>(null);
 const [pendingReads,setPendingReads]=useState<string[]>([]),[sectionStatus,setSectionStatus]=useState<Record<string,string>>({});
 const [positions,setPositions]=useState<Record<string,ListPosition>>({}),[photoStates,setPhotoStates]=useState<Record<string,{dirty:boolean;blocking:boolean}>>(()=>Object.fromEntries(consolePhotoTargets(client,userId,scope).filter(id=>heldPhotoAttempt(client,userId,{...scope,productId:id})).map(id=>[id,{dirty:true,blocking:true}])));
 const reportEntry=useRef<{page:string;binding:string;explicit:string;period:ReportPeriod}|null>(null);
 const reportBinding=`${scope.tenantId}:${scope.instanceId}`,explicitPeriod=route.period?`${route.period.from}:${route.period.to}`:'';
 if(!reportEntry.current||reportEntry.current.page!==route.page||reportEntry.current.binding!==reportBinding||reportEntry.current.explicit!==explicitPeriod)reportEntry.current={page:route.page,binding:reportBinding,explicit:explicitPeriod,period:route.period??defaultReportPeriod(Date.now())};
 const reportPeriod=reportEntry.current.period,reportKey=`report:${reportPeriod.from}:${reportPeriod.to}`;
 const lastReservationFilters=useRef<ReservationFilters>({});
 if(route.page==='reservations')lastReservationFilters.current=route.reservation??{};
 const reservationFilters=lastReservationFilters.current,reservationQuery=reservationFilterParams(reservationFilters),filterKey=reservationQuery?.toString()??'invalid';
 const [paging,setPaging]=useState<{filterKey:string;cursors:(string|undefined)[]}>({filterKey,cursors:[undefined]});
 const cursors=paging.filterKey===filterKey?paging.cursors:[undefined],cursor=cursors.at(-1),appliedFilter=useRef(filterKey);
 const photoRef=useRef(photoStates);photoRef.current=photoStates;
 const readRef=useRef(reads);readRef.current=reads;const draftRef=useRef(drafts);draftRef.current=drafts;
 const attemptRef=useRef(attempt);attemptRef.current=attempt;const busyRef=useRef(false),mounted=useRef(false),generation=useRef(client.sessionGeneration);
 const tickets=useRef(new Map<string,{ticket:number;abort:AbortController}>()),serial=useRef(0),refusalMark=useRef<number|null>(null),commandAbort=useRef(new AbortController());
 const root=`/tenants/${scope.tenantId}/storefronts/${scope.instanceId}`,binding=`${scope.tenantId}:${scope.instanceId}`;
 const slot=<T,>(key:string)=>(reads[key]??empty) as ReadSlot<T>;
 const profile=slot<SupplyCatalogView>('profile').data;
 const owner=slot<z.infer<typeof ReservationSettingSchema>>('owner');
 const ownerAllowed=owner.state==='ready'&&owner.data!==null;
 const can=(capability:string)=>!revoked&&refusalMark.current===null&&profile?.writable===true&&profile.capabilities.includes(capability)===true;
 function descriptor(key:string):{path:string;schema:z.ZodType;gate?:'write'|'owner'}|null {
  if(key.startsWith('report:')){const [,from,to]=key.split(':');return {path:'/supplier-console/report?'+new URLSearchParams({from,to}),schema:SupplierReportSchema,gate:'write'};}
  if(key.startsWith('reservation:'))return {path:'/supplier-console/reservations/'+key.slice(12),schema:SupplierReservationDetailSchema,gate:'owner'};
  if(key.startsWith('partner-reservations:'))return {path:'/supplier-console/reservations?'+new URLSearchParams({partner_id:key.slice(21),limit:'5'}),schema:SupplierReservationsSchema,gate:'owner'};
  if(key==='changes'||key.startsWith('changes:'))return {path:'/supplier-console/changes'+(key==='changes'?'':'?'+new URLSearchParams({product_id:key.slice(8)})),schema:SupplierChangesSchema,gate:'write'};
  if(key==='reservations'){
   if(!reservationQuery)return null;
   const query=new URLSearchParams(reservationQuery);query.set('limit','20');if(cursor)query.set('cursor',cursor);
   return {path:'/supplier-console/reservations?'+query,schema:SupplierReservationsSchema,gate:'owner'};
  }
  if(key.startsWith('product:'))return {path:'/supplier-console/products/'+key.slice(8),schema:SupplierProductDetailSchema,gate:'write'};
  if(key.startsWith('request:'))return {path:'/supplier-console/requests/'+key.slice(8),schema:SupplierRequestDetailSchema,gate:'write'};
  if(key.startsWith('partner:'))return {path:'/supplier-console/partners/'+key.slice(8),schema:SupplierPartnerDetailSchema,gate:'write'};
  const table:Record<string,{path:string;schema:z.ZodType;gate?:'write'|'owner'}>={profile:{path:'/supply-profile',schema:SupplyCatalogViewSchema},owner:{path:'/reservation-setting',schema:ReservationSettingSchema},
   overview:{path:'/supplier-console/overview',schema:SupplierOverviewSchema},products:{path:'/supplier-console/products',schema:SupplierProductsSchema,gate:'write'},partners:{path:'/supplier-console/partners',schema:SupplierPartnersSchema,gate:'write'},
   requests:{path:'/supply-requests',schema:DistributionsSchema,gate:'write'},offers:{path:'/supply-offers',schema:SupplyOffersSchema,gate:'write'},media:{path:'/product-media',schema:ProductMediaPageSchema,gate:'write'}};
  return table[key]??null;
 }
 const descriptorRef=useRef(descriptor);descriptorRef.current=descriptor;
 async function read(key:string):Promise<boolean> {
  const d=descriptorRef.current(key),p=readRef.current.profile?.data as SupplyCatalogView|undefined;
  if(!d||d.gate==='write'&&!p?.capabilities.includes('store:write')||d.gate==='owner'&&!(readRef.current.owner?.state==='ready'&&readRef.current.owner.data)||key==='media'&&!photosEnabled)return false;
  tickets.current.get(key)?.abort.abort();const abort=new AbortController(),ticket=++serial.current,session=client.sessionGeneration; tickets.current.set(key,{abort,ticket});
  const current=()=>mounted.current&&!abort.signal.aborted&&tickets.current.get(key)?.ticket===ticket&&generation.current===session&&session===client.sessionGeneration&&binding===`${scope.tenantId}:${scope.instanceId}`;
  setReads(old=>({...old,[key]:{...(old[key]??empty),state:'loading',error:''}}));
  try {
   const result=d.schema.safeParse(await client.get(root+d.path,{signal:abort.signal}));if(!result.success)throw new Error('invalid_read');if(!current())return false;
   const data=result.data as Record<string,unknown>;
   if(key.startsWith('report:')&&!reportMatchesReadKey(result.data as SupplierReport,scope,key))throw new Error('read_target_mismatch');
   if(key==='profile'&&(data.tenant_id!==scope.tenantId||data.instance_id!==scope.instanceId)||key.startsWith('product:')&&(data.product as {product_id:string}).product_id!==key.slice(8)||key.startsWith('partner:')&&(data.partner as {partner_id:string}).partner_id!==key.slice(8)||key.startsWith('request:')&&(data.request as {selection_id:string}).selection_id!==key.slice(8))throw new Error('read_target_mismatch');
   if(key.startsWith('reservation:')&&(data.reservation as {order_id:string}).order_id!==key.slice(12)||key.startsWith('partner-reservations:')&&(data.filter as {partner_id:string}).partner_id!==key.slice(21)||key==='changes'&&data.product_id!==null||key.startsWith('changes:')&&data.product_id!==key.slice(8))throw new Error('read_target_mismatch');
   if(key==='reservations'){
    const query=new URLSearchParams(d.path.split('?')[1]),filter=data.filter as Record<string,string|null>;
    if(['state','partner_id','product_id','from','to'].some(field=>filter[field]!==query.get(field)))throw new Error('read_target_mismatch');
   }
   const now=new Date().toISOString(),next:ReadSlot<unknown>={state:'ready',data,asOf:typeof data.as_of==='string'?data.as_of:now,lastOkAt:now,error:''};
   readRef.current={...readRef.current,[key]:next};setReads(old=>({...old,[key]:next}));setPendingReads(old=>old.filter(k=>k!==key));if(refusalReleased({key,mark:refusalMark.current,ticket,current:current(),matched:data.tenant_id===scope.tenantId&&data.instance_id===scope.instanceId})){refusalMark.current=null;setRevoked(false);if(data.writable)setError(old=>old==='目前身分已沒有這項權限'?'':old);}
   if(key.startsWith('product:'))setDrafts(old=>staleDrafts(old,key.slice(8),(data as unknown as SupplierProductDetail).product.version));
   return true;
  } catch(cause) {
   if(!current())return false;
   if(key==='owner'&&cause instanceof ApiError&&[403,404].includes(cause.status)) {
    const next:ReadSlot<unknown>={state:'ready',data:null,asOf:null,lastOkAt:new Date().toISOString(),error:'只有業務空間擁有者可以查看預留',status:cause.status};readRef.current={...readRef.current,[key]:next};setReads(old=>({...old,[key]:next}));setPendingReads(old=>old.filter(k=>k!==key));return true;
   }
   const status=cause instanceof ApiError?cause.status:undefined,message=cause instanceof ApiError&&!cause.network?cause.detail??cause.message:'暫時無法讀取資料，已保存的內容不會因此改變。';
   setReads(old=>{const next={...(old[key]??empty),state:'failed' as const,error:message,status,...(status===403||status===404?{data:null}:{})};readRef.current={...readRef.current,[key]:next};return {...old,[key]:next};});
   // A refusal may mean the member's access changed: reread the capabilities so pages and navigation follow them.
   if(status===403&&key!=='profile')void read('profile');
   return false;
  }
 }
 useEffect(()=>{mounted.current=true;generation.current=client.sessionGeneration;refusalMark.current=null;setRevoked(false);commandAbort.current=new AbortController();void read('profile');return()=>{mounted.current=false;tickets.current.forEach(t=>t.abort.abort());commandAbort.current.abort();};},[client,root]);
 useEffect(()=>{if(profile?.setup_state==='ready')void read('owner');},[profile?.setup_state]);
 useEffect(()=>{if(profile?.setup_state!=='ready')return;
  const keys=route.page==='overview'?['overview','changes']:route.page==='products'?['profile','products',...(photosEnabled?['media']:[])]:route.page==='product'?['product:'+route.id,'changes:'+route.id,...(photosEnabled?['media']:[])]:route.page==='partners'?['partners']:route.page==='partner'?['partner:'+route.id,'partners',...(ownerAllowed?['partner-reservations:'+route.id]:[])]:route.page==='terms'?['requests','offers','products']:route.page==='review'?['request:'+route.id]:route.page==='reservations'&&ownerAllowed?['partners','products']:route.page==='reservation'&&ownerAllowed?['reservation:'+route.id]:route.page==='reports'?[reportKey]:route.page==='settings'?['profile']:route.page==='product-new'?['profile','products']:[];
  keys.forEach(key=>void read(key));
 },[route.page,route.id,reportKey,profile?.setup_state,profile?.capabilities.join(','),ownerAllowed,photosEnabled]);
 useEffect(()=>{
  if(appliedFilter.current!==filterKey){
   appliedFilter.current=filterKey;setPaging({filterKey,cursors:[undefined]});tickets.current.get('reservations')?.abort.abort();
   readRef.current={...readRef.current,reservations:empty};setReads(old=>({...old,reservations:empty}));
  }
  if(route.page==='reservations'&&ownerAllowed&&profile?.setup_state==='ready')void read('reservations');
 },[route.page,ownerAllowed,profile?.setup_state,filterKey,cursor]);
 // Reads the member may no longer make cannot keep writes paused as pending.
 useEffect(()=>{setPendingReads(old=>{const next=old.filter(key=>{const d=descriptorRef.current(key);return d&&(d.gate!=='write'||profile?.capabilities.includes('store:write'))&&(d.gate!=='owner'||ownerAllowed);});return next.length===old.length?old:next;});},[profile?.capabilities.join(','),ownerAllowed,filterKey]);
 const photoBlocking=Object.entries(photoStates).some(([id,s])=>s.blocking||!!heldPhotoAttempt(client,userId,{...scope,productId:id}));
 const dirty=Object.values(drafts).some(d=>Object.keys(d.fields).length>0)||Object.values(photoStates).some(s=>s.dirty);
 const locked=phase!=='idle'||photoBlocking||pendingReads.length>0||revoked||refusalMark.current!==null||!profile?.writable||slot('profile').state!=='ready';
 const guardRef=useRef<(next:string|null)=>boolean>(()=>true);
 guardRef.current=next=>{const result=leaveDecision(next,scope,{sending:busyRef.current,held:attemptRef.current!==null,photoBlocking,dirty});if(!result.allow){setNotice(result.message);return false;}return !result.confirm||window.confirm(result.message);};
 useEffect(()=>{registerLeave(next=>guardRef.current(next));return()=>registerLeave(null);},[registerLeave]);
 const unloadRef=useRef(false);unloadRef.current=dirty||photoBlocking||phase!=='idle';
 useEffect(()=>{const unload=(e:BeforeUnloadEvent)=>{if(unloadRef.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
 function updateDraft(name:string,baseVersion:string,base:Fields,key:string,value:string|number|boolean){setDrafts(old=>{const next=editDraft(old[name],baseVersion,base,key,value);return Object.keys(next.fields).length?{...old,[name]:next}:discardDraft(old,name);});}
 function discard(name:string){setDrafts(old=>discardDraft(old,name));setConflicts(old=>{const next={...old};delete next[name];return next;});}
 const loadedChanges=()=>Object.keys(readRef.current).filter(key=>key==='changes'||key.startsWith('changes:'));
 async function refreshAttempt(a:Attempt,value?:Record<string,unknown>){
  const productId=a.kind==='product.create'?String(value?.product_id):a.productId;
  const keys=ATTEMPT_KINDS[a.kind].reads.flatMap(key=>key==='request'?['request:'+a.target]:key==='product'?productId?['product:'+productId]:[]:key==='partner'?Object.keys(readRef.current).filter(k=>k.startsWith('partner:')):[key]);
  if(photosEnabled&&productId)keys.push('media');
  if(value)keys.push(...loadedChanges());
  const admissible=keys.filter(key=>{const d=descriptorRef.current(key);return d&&(d.gate!=='write'||profile?.capabilities.includes('store:write'))&&(d.gate!=='owner'||ownerAllowed);});
  setPendingReads(old=>[...new Set([...old,...admissible.filter(k=>k!=='media'&&k!=='changes'&&!k.startsWith('changes:'))])]);await Promise.all(admissible.map(read));
 }
 async function send(a:Attempt){
  if(busyRef.current||attemptRef.current&&attemptRef.current.key!==a.key||generation.current!==client.sessionGeneration)return;
  // Another attempt still owns this business: show it held instead of locking on a throw.
  try{holdAttempt(client,userId,a);}catch{const held=restoreAttempt(client,userId,scope);if(held){attemptRef.current=held;setAttempt(held);setPhase('held');}return;}
  busyRef.current=true;attemptRef.current=a;setAttempt(a);setPhase('sending');setError('');
  let outcome;
  try{outcome=classifyCommandOutcome(a,{response:await client[a.method](a.path,a.body,{idempotencyKey:a.key,ifMatch:a.ifMatch,signal:commandAbort.current.signal})});}
  catch(cause){outcome=classifyCommandOutcome(a,{error:cause});}
  if(outcome.state==='unknown')markAttemptUnknown(client,userId,a);else releaseAttempt(client,userId,a);
  if(!mounted.current||generation.current!==client.sessionGeneration)return;
  busyRef.current=false;
  if(outcome.state==='unknown'){setPhase('held');return;}
  attemptRef.current=null;setAttempt(null);setPhase('idle');
  if(outcome.state==='success'){
   const saved=`已保存：${a.label}。`;setNotice(saved);setSectionStatus(old=>({...old,[a.draft??a.target]:saved}));if(a.draft)discard(a.draft);
   if(a.productId&&typeof outcome.value.version==='string')setDrafts(old=>staleDrafts(old,a.productId!,outcome.value.version as string));
   await refreshAttempt(a,outcome.value);
   if(mounted.current&&generation.current===client.sessionGeneration&&a.kind==='product.create')window.location.hash=supplierConsoleHref(scope,'product',{id:String(outcome.value.product_id)});
   return;
  }
  const detail=outcome.detail??'操作未完成，請核對後重試。';setSectionStatus(old=>({...old,[a.draft??a.target]:detail}));
  if(outcome.status===403){refusalMark.current=serial.current;setRevoked(true);setError('目前身分已沒有這項權限');void read('profile');}
  else if(outcome.status===412){setError('資料剛剛被更新。你的修改還在，請確認後再套用。');if(a.draft){setDrafts(old=>old[a.draft!]?{...old,[a.draft!]:{...old[a.draft!],conflict:true}}:old);setConflicts(old=>({...old,[a.draft!]:a}));}await refreshAttempt(a);}
  else if(outcome.status===404&&a.kind.startsWith('profile.')){setReads(old=>({...old,profile:{...(old.profile??empty),state:'failed',data:null,error:'找不到這個供貨商品庫',status:404}}));}
  else {setError(outcome.status===404?'找不到這個項目，其他資料仍可查看。':outcome.status===422?'有欄位格式不符，請檢查後再送出。 '+detail:detail);if(outcome.code==='idempotency_conflict')setRejected(a);if(outcome.code==='stock_below_reserved'&&a.productId)void read('product:'+a.productId);}
 }
 function command(input:Omit<Attempt,'key'|'scope'>){
  if(locked||busyRef.current||attemptRef.current||Object.values(photoRef.current).some(p=>p.blocking))return;
  const capability=input.kind==='profile.setup'||input.kind==='profile.update'?'store:manage':input.kind==='offer.publish'?'store:publish':input.kind==='reservation.toggle'?null:'store:write';
  if(capability&&!can(capability)||input.kind==='offer.publish'&&!can('store:write')||input.kind==='reservation.toggle'&&!ownerAllowed)return;
  void send(createAttempt({...input,scope}));
 }
 function save(kind:AttemptKind,label:string,name:string,base:Fields,version:string,target:string,path:string,productId?:string){
  const draft=draftRef.current[name];if(!draft||!Object.keys(draft.fields).length)return;
  try{const body=commandFields(kind,kind==='terms.update'||kind==='product.create'||kind==='profile.setup'?{...base,...draft.fields}:draft.fields);
   const schema=kind==='product.create'?SupplyProductInputSchema:kind==='product.update'?SupplyProductUpdateInputSchema:kind==='terms.update'?SupplyTermsInputSchema:kind==='profile.setup'?SupplyCatalogSetupInputSchema:SupplyProfileUpdateInputSchema;
   const parsed=schema.safeParse(body);if(!parsed.success)throw new Error('請檢查欄位格式、金額與庫存。');
   command({kind,label,draft:name,method:kind==='product.create'||kind==='profile.setup'?'post':'patch',path:root+path,body:parsed.data,ifMatch:kind==='product.create'||kind==='profile.setup'?undefined:draft.baseVersion||version,target,productId});
  }catch(cause){setError(cause instanceof Error?cause.message:'請檢查欄位格式。');}
 }
 function reapply(name:string,current:Fields,version:string){const a=conflicts[name],d=drafts[name];if(!a||!d||locked)return;try{const next=reapplyAttempt(a,{...d,fields:commandFields(a.kind,d.fields)},commandFields(a.kind,current),version);if(!next){discard(name);setNotice('目前資料已包含你的修改。');return;}void send(next);}catch(cause){setError(cause instanceof Error?cause.message:'請檢查欄位格式。');}}
 const position=(name:string):ListPosition=>positions[name]??{search:'',filter:'',sort:'sku',scroll:0,lastId:null};
 const remember=(name:string,changes:Partial<ListPosition>)=>setPositions(old=>({...old,[name]:{...position(name),...changes}}));
 return {client,userId,scope,root,route,photosEnabled,reservationFilters,reportPeriod,reads,slot,read,profile,owner,ownerAllowed,can,locked,refused:revoked,phase,attempt,notice,error,rejected,pendingReads,drafts,conflicts,sectionStatus,updateDraft,discard,reapply,save,command,
  retry:()=>attempt&&void send(attempt),position,remember,cursors,nextPage:(next:string)=>setPaging({filterKey,cursors:[...cursors,next]}),previousPage:()=>setPaging({filterKey,cursors:cursors.length>1?cursors.slice(0,-1):cursors}),
  photoStates,photoState:(id:string,dirty:boolean,blocking:boolean)=>{const pending=!!heldPhotoAttempt(client,userId,{...scope,productId:id});rememberConsolePhoto(client,userId,scope,id,dirty||blocking||pending);photoRef.current={...photoRef.current,[id]:{dirty:dirty||pending,blocking:blocking||pending}};setPhotoStates(photoRef.current);},
  photoSaved:async(id:string)=>{setNotice('已保存照片。');setPendingReads(old=>[...new Set([...old,'product:'+id])]);await Promise.all([read('product:'+id),read('media'),read('products'),read('overview'),...loadedChanges().map(read)]);},
 };
}
export type ConsoleController=ReturnType<typeof useSupplierConsoleController>;
