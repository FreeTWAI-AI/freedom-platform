import type {Pool,PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {withMemberScope,type MemberScopeContext} from '../../packages/resource-scopes/index.js';
import {scopedMemberCommand,scopedJournal,type ScopedJournalInput} from '../../packages/scoped-commands/index.js';
import type {ScopedFactContext} from '../../packages/scoped-commands/command-context.js';
import {assertCurrentSessionClock} from '../../packages/db/member-session.js';
import type {ResourceScopeRef} from '../../contracts/common/v1/identity.js';

/** A server-derived owner key is only a lookup identity, never a credential. */
export interface AuthorityOwner {readonly user_id:string}
interface ScopeInput<A>{actor:A;scope:'personal'|'community'|ResourceScopeRef;lockUser?:boolean}
export interface AuthorityCommand<A> extends ScopeInput<A>{operation:string;key:string;body:unknown;target:{kind:string;id:string};expected?:string}
/** Internal composition ports. Each adapter MUST authenticate and lock its
 * actual credentials/current SQL on this client before any callback. No HTTP
 * route accepts these functions, subjects or contexts from JSON. Domain ports
 * still own target authorization, policy, version and publication checks. */
export interface LifecycleAuthority<A extends AuthorityOwner,C extends ScopedFactContext>{
  snapshot(actor:A):A;
  read<T>(pool:Pool,input:ScopeInput<A>,authorize:(q:PoolClient,c:C)=>Promise<unknown>,run:(q:PoolClient,c:C)=>Promise<T>):Promise<T>;
  command<T>(pool:Pool,input:AuthorityCommand<A>,authorize:(q:PoolClient,c:C)=>Promise<unknown>,run:(q:PoolClient,c:C)=>Promise<T>,
    revalidate?:(q:PoolClient,c:C)=>Promise<unknown>,assertCurrentTime?:()=>void):Promise<T>;
  clock(q:PoolClient,actor:A):Promise<void>;
  communityId(actor:A):string;
  journal(q:PoolClient,c:C,input:ScopedJournalInput):Promise<void>;
}
/** Public member constructors always install this unchanged adapter. */
export const memberLifecycleAuthority:LifecycleAuthority<Actor,MemberScopeContext>=Object.freeze({
  snapshot:(actor:Actor)=>Object.freeze({...actor}),read:withMemberScope,command:scopedMemberCommand,
  clock:assertCurrentSessionClock,communityId:(actor:Actor)=>actor.community_id,journal:scopedJournal,
});
export function isMemberLifecycleAuthority(value:object):boolean{return value===memberLifecycleAuthority;}
