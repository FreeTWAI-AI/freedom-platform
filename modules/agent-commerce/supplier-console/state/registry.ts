import type {Attempt} from './attempt';
import type {ConsoleScope} from '../ui/route';
export type RetainedAttempt={attempt:Attempt;hadUnknown:boolean};
const pending=new WeakMap<object,Map<string,Map<string,RetainedAttempt>>>();let count=0;
const placement=(scope:ConsoleScope)=>JSON.stringify([scope.tenantId,scope.instanceId]);
const unload=(event:BeforeUnloadEvent)=>{if(count){event.preventDefault();event.returnValue='';}};
function watch(){if(typeof window==='undefined')return;window.removeEventListener('beforeunload',unload);if(count)window.addEventListener('beforeunload',unload);}
export function retainedAttempt(client:object,member:string,scope:ConsoleScope){return pending.get(client)?.get(member)?.get(placement(scope))??null;}
export function holdAttempt(client:object,member:string,attempt:Attempt,hadUnknown=false){
 let members=pending.get(client);if(!members){members=new Map();pending.set(client,members);}let scopes=members.get(member);if(!scopes){scopes=new Map();members.set(member,scopes);}
 const key=placement(attempt.scope),prior=scopes.get(key);if(prior&&prior.attempt.key!==attempt.key)throw new Error('original_result_pending');
 if(!prior)count++;scopes.set(key,{attempt,hadUnknown:hadUnknown||prior?.hadUnknown===true});watch();
}
export function markAttemptUnknown(client:object,member:string,attempt:Attempt){if(retainedAttempt(client,member,attempt.scope)?.attempt.key===attempt.key)holdAttempt(client,member,attempt,true);}
export function restoreAttempt(client:object,member:string,scope:ConsoleScope){const r=retainedAttempt(client,member,scope);if(!r)return null;markAttemptUnknown(client,member,r.attempt);return r.attempt;}
export function releaseAttempt(client:object,member:string,attempt:Attempt){const scopes=pending.get(client)?.get(member);if(scopes?.get(placement(attempt.scope))?.attempt.key!==attempt.key)return false;scopes.delete(placement(attempt.scope));count--;if(!scopes.size)pending.get(client)!.delete(member);watch();return true;}

// Keep only locators here; the existing photo registry owns the original File and CAS tuple.
const photoTargets=new WeakMap<object,Map<string,Map<string,Set<string>>>>();
export function consolePhotoTargets(client:object,member:string,scope:ConsoleScope){return [...(photoTargets.get(client)?.get(member)?.get(placement(scope))??[])];}
export function rememberConsolePhoto(client:object,member:string,scope:ConsoleScope,productId:string,pending:boolean){
 let members=photoTargets.get(client);if(!members){members=new Map();photoTargets.set(client,members);}let scopes=members.get(member);if(!scopes){scopes=new Map();members.set(member,scopes);}let targets=scopes.get(placement(scope));if(!targets){targets=new Set();scopes.set(placement(scope),targets);}if(pending)targets.add(productId);else targets.delete(productId);
}
