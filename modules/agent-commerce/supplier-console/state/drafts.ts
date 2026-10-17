import {createAttempt,type Attempt} from './attempt';
export type Fields=Record<string,string|number|boolean>;
export type Draft={baseVersion:string;fields:Fields;stale?:boolean;conflict?:boolean};
export type Drafts=Record<string,Draft>;
export function changedFields(base:Fields,values:Fields):Fields {return Object.fromEntries(Object.entries(values).filter(([k,v])=>v!==base[k]));}
export function editDraft(prior:Draft|undefined,version:string,base:Fields,key:string,value:string|number|boolean):Draft {
 const fields={...prior?.fields,[key]:value};if(value===base[key])delete fields[key];return {...prior,baseVersion:prior?.baseVersion??version,fields};
}
export function staleDrafts(drafts:Drafts,productId:string,version:string):Drafts {return Object.fromEntries(Object.entries(drafts).map(([k,d])=>[k,k.startsWith(`product:${productId}:`)&&d.baseVersion!==version?{...d,stale:true}:d]));}
export function conflictRows(draft:Draft,current:Fields){return Object.entries(draft.fields).map(([field,mine])=>({field,mine,current:current[field]}));}
export function reapplyAttempt(prior:Attempt,draft:Draft,current:Fields,version:string,key?:string){const fields=changedFields(current,draft.fields);if(!Object.keys(fields).length)return null;return createAttempt({...prior,ifMatch:version,body:prior.kind==='terms.update'?{...current,...fields}:fields},key);}
export function discardDraft(drafts:Drafts,name:string){const next={...drafts};delete next[name];return next;}
