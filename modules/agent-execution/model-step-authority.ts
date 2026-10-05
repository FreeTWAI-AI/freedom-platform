import type {PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import type {MemberScopeContext} from '../../packages/resource-scopes/index.js';
import type {ScopedFactContext} from '../../packages/scoped-commands/command-context.js';
import {memberLifecycleAuthority,type LifecycleAuthority,type AuthorityOwner} from '../assets/lifecycle-authority.js';
import type {LifecyclePolicy} from '../assets/engine.js';
import type {ModelSelection} from '../../contracts/execution/v1/member-execution.js';
import {resolvePrivateWorkPersistencePolicy} from '../autopilot-work/policy.js';
import {resolveInferenceExportPolicy,type InferenceExportPolicy} from './export-policy.js';

/** Server composition only. Private branding or JSON claims never authenticate
 * a machine: its adapter verifies actual signatures AND current SQL before
 * every callback. The shared model engine retains all domain/dispatch guards. */
export interface ModelStepAuthority<A extends AuthorityOwner,C extends ScopedFactContext> extends LifecycleAuthority<A,C>{
  persistencePolicy(q:PoolClient,c:C):Promise<LifecyclePolicy>;
  exportPolicy(q:PoolClient,c:C,environment:string,clientId:string,selection:ModelSelection):Promise<InferenceExportPolicy>;
  /** The Step/Attempt/Run already exist on this transaction. Attach a machine
   * authorization before the first fact; returned secrets stay out of receipts. */
  stepCreated?(q:PoolClient,actor:A,c:C,stepId:string):Promise<void>;
}
export const memberModelStepAuthority:ModelStepAuthority<Actor,MemberScopeContext>=Object.freeze({
  ...memberLifecycleAuthority,persistencePolicy:resolvePrivateWorkPersistencePolicy,exportPolicy:resolveInferenceExportPolicy,
});
