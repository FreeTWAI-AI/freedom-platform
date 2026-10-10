import type { PoolClient } from 'pg';
import type { PrincipalRef, ResourceScopeRef } from '../../contracts/common/v1/identity.js';
import { requireCondition } from '../shared/problem.js';

/** Internal transaction plumbing, NOT authentication. Only a server adapter
 * which has locked/verified its actual credentials may register a context.
 * Request JSON must never be passed to this module by an HTTP adapter. */
export interface ScopedFactContext {
  readonly subject_principal: PrincipalRef;
  readonly scope: ResourceScopeRef;
  // SQL117 admits only member/execution. The separately reviewed service/site
  // adapter + SQL118 must establish its own actual authority and fact branch.
  readonly authn_kind: 'member_session' | 'execution_token' | 'shop_service_key';
}
export interface ExecutionFactBinding {
  readonly authorizationId: string;
  readonly attemptId: string;
  readonly grantId: string;
  readonly runtimeDeviceId: string;
  readonly connectionId: string;
}
type JournalTarget = { aggregate_type: 'member_avatar'|'member_service'|'member_message_image'|'community_comment_image'|'community_event'|'social_post'|'community_event_highlight'|'commerce_order_cancellation'; id: string };
interface ActiveCommand {
  readonly q: PoolClient;
  readonly operation: string;
  authorized: boolean;
  readonly journalTarget?: JournalTarget;
  execution?: Readonly<ExecutionFactBinding>;
}
const commands = new WeakMap<ScopedFactContext, ActiveCommand>();

export function registerScopedCommand(context: ScopedFactContext, q: PoolClient, operation: string,
  journalTarget?: JournalTarget): void {
  requireCondition(!commands.has(context), 500, 'scoped_context_active', '操作範圍已使用。');
  commands.set(context, { q, operation, authorized: false, ...(journalTarget ? { journalTarget } : {}) });
}
export function authorizeScopedCommand(context: ScopedFactContext): void {
  const command = commands.get(context);
  requireCondition(command, 403, 'scoped_context_required', '需要目前交易的操作範圍。');
  command.authorized = true;
}
export function forgetScopedCommand(context: ScopedFactContext): void { commands.delete(context); }
export function currentScopedCommand(q: PoolClient, context: ScopedFactContext): Readonly<ActiveCommand> {
  const command = commands.get(context);
  requireCondition(command?.q === q && command.authorized, 403, 'scoped_context_required', '需要目前交易的操作範圍。');
  return command;
}
/** Called only after the exact SQL authorization has acquired its real Attempt.
 * Composite FKs also bind every fact to that same immutable authorization. */
export function bindScopedExecutionFact(q: PoolClient, context: ScopedFactContext, binding: ExecutionFactBinding): void {
  const command = currentScopedCommand(q, context);
  requireCondition(context.authn_kind === 'execution_token' && !command.execution,
    403, 'scoped_context_required', '需要目前交易的操作範圍。');
  commands.get(context)!.execution = Object.freeze({ ...binding });
}
