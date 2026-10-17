import {ApiError} from '../../../../apps/portal-web/src/api';
export type Attempt=Readonly<{key:string;method:'post'|'put';path:string;body:Readonly<Record<string,unknown>>;ifMatch?:string}>;
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
export function createAttempt(input:Omit<Attempt,'key'>,key=crypto.randomUUID()):Attempt{return freeze({...input,body:JSON.parse(JSON.stringify(input.body)),key});}
export type AttemptState={phase:'idle';attempt:null}|{phase:'sending'|'unknown';attempt:Attempt};
export const idleAttempt:AttemptState={phase:'idle',attempt:null};
export function startAttempt(state:AttemptState,input:Omit<Attempt,'key'>):AttemptState{return state.phase==='idle'?{phase:'sending',attempt:createAttempt(input)}:state;}
export function retryAttempt(state:AttemptState):AttemptState{return state.phase==='unknown'?{...state,phase:'sending'}:state;}
export function attemptLocked(state:AttemptState){return state.phase!=='idle';}
export function unknownFailure(error:unknown){return !(error instanceof ApiError)||error.network||error.timedOut||error.accessExpired||!error.status||error.status===401||error.status>=500&&!error.code;}
