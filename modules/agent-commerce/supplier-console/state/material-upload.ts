import {SupplyMaterialReceiptSchema,type SupplyMaterialReceipt} from '../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ConsoleScope} from '../ui/route';
export type MaterialUploadTarget=ConsoleScope & {materialId:string};
export type MaterialUploadAttempt=Readonly<MaterialUploadTarget & {key:string;expected:string;file:File;hadUnknown:boolean}>;
export function materialAcknowledgement(raw:unknown,a:MaterialUploadAttempt):SupplyMaterialReceipt|null {
 const parsed=SupplyMaterialReceiptSchema.safeParse(raw);
 return parsed.success&&parsed.data.material_id===a.materialId&&parsed.data.version===String(BigInt(a.expected)+1n)?parsed.data:null;
}
const pending=new WeakMap<object,Map<string,Map<string,MaterialUploadAttempt>>>();let count=0;
const placement=(a:MaterialUploadTarget)=>JSON.stringify([a.tenantId,a.instanceId,a.materialId]);
const unload=(e:BeforeUnloadEvent)=>{if(count){e.preventDefault();e.returnValue='';}};
function watch(){if(typeof window==='undefined')return;window.removeEventListener('beforeunload',unload);if(count)window.addEventListener('beforeunload',unload);}
export function heldMaterialUpload(client:object,member:string,target:MaterialUploadTarget){return pending.get(client)?.get(member)?.get(placement(target))??null;}
export function materialUploadTargets(client:object,member:string,scope:ConsoleScope){return [...(pending.get(client)?.get(member)?.values()??[])].filter(a=>a.tenantId===scope.tenantId&&a.instanceId===scope.instanceId).map(a=>a.materialId);}
const same=(a:MaterialUploadAttempt,b:MaterialUploadAttempt)=>a.key===b.key&&a.expected===b.expected&&a.file===b.file;
export function holdMaterialUpload(client:object,member:string,a:MaterialUploadAttempt){
 let members=pending.get(client);if(!members){members=new Map();pending.set(client,members);}let targets=members.get(member);if(!targets){targets=new Map();members.set(member,targets);}
 const key=placement(a),prior=targets.get(key);if(prior&&!same(prior,a))throw new Error('material_original_result_pending');
 if(!prior)count++;targets.set(key,Object.freeze({...a,hadUnknown:a.hadUnknown||prior?.hadUnknown===true}));watch();
}
export function markMaterialUploadUnknown(client:object,member:string,a:MaterialUploadAttempt){const prior=heldMaterialUpload(client,member,a);if(!prior||!same(prior,a))return false;holdMaterialUpload(client,member,{...a,hadUnknown:true});return true;}
export function restoreMaterialUpload(client:object,member:string,target:MaterialUploadTarget){const a=heldMaterialUpload(client,member,target);if(!a)return null;holdMaterialUpload(client,member,{...a,hadUnknown:true});return heldMaterialUpload(client,member,target);}
export function releaseMaterialUpload(client:object,member:string,a:MaterialUploadAttempt){
 const targets=pending.get(client)?.get(member),prior=targets?.get(placement(a));if(!prior||!same(prior,a))return false;
 targets!.delete(placement(a));count--;if(!targets!.size)pending.get(client)!.delete(member);watch();return true;
}
export function forgetRefusedMaterialUpload(client:object,member:string,a:MaterialUploadAttempt){return heldMaterialUpload(client,member,a)?.hadUnknown?false:releaseMaterialUpload(client,member,a);}
export const materialUploadBlocksLeaving=(a:MaterialUploadAttempt|null,sending=false)=>sending||a!==null;
