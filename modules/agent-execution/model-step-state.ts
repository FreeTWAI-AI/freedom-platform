import { ModelStepMetadataSchema, type ModelStepMetadata } from '../../contracts/execution/v2/model-step.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { AdapterFault } from './adapters/common.js';

export type ModelStepTransition = 'begin' | 'observe' | 'unknown' | 'cancel' | 'finalize';
/** Pure lifecycle arithmetic for the transactional service. This never checks
 * backing records, authenticates a model or creates an execution capability. */
export function transitionModelStep(raw: ModelStepMetadata, event: ModelStepTransition): ModelStepMetadata {
  const current = ModelStepMetadataSchema.parse(snapshotInput(raw));
  if ((['reserved', 'cancelled'].includes(current.state) && current.usageStatus !== 'not_dispatched')
    || (current.state === 'dispatched' && current.usageStatus !== 'unknown')
    || (['awaiting_result', 'succeeded'].includes(current.state) && current.usageStatus !== 'known')
    || (current.state === 'outcome_unknown' && current.usageStatus === 'not_dispatched')) throw new AdapterFault('invalid_input');
  const next = { ...current };
  switch (event) {
    case 'begin':
      if (current.state !== 'reserved' || current.usageStatus !== 'not_dispatched') throw new AdapterFault('execution_authority_unavailable');
      next.state = 'dispatched'; next.usageStatus = 'unknown'; break;
    case 'observe':
      if (current.state !== 'dispatched' || current.usageStatus !== 'unknown') throw new AdapterFault('execution_authority_unavailable');
      next.state = 'awaiting_result'; next.usageStatus = 'known'; break;
    case 'unknown':
      if (!['dispatched', 'outcome_unknown', 'awaiting_result'].includes(current.state)) throw new AdapterFault('execution_authority_unavailable');
      if (current.state !== 'dispatched') return freezeTree(current);
      next.state = 'outcome_unknown';
      // A genuine bounded observation keeps known usage even when Result CAS
      // fails; failures never fabricate zero usage or release reservations.
      break;
    case 'cancel':
      if (current.state !== 'reserved' || current.usageStatus !== 'not_dispatched') throw new AdapterFault('execution_authority_unavailable');
      next.state = 'cancelled'; break;
    case 'finalize':
      if (current.state !== 'awaiting_result' || current.usageStatus !== 'known') throw new AdapterFault('execution_authority_unavailable');
      next.state = 'succeeded'; break;
    default: throw new AdapterFault('invalid_input');
  }
  if (BigInt(current.aggregateVersion) >= 9223372036854775807n) throw new AdapterFault('execution_authority_unavailable');
  next.aggregateVersion = String(BigInt(current.aggregateVersion) + 1n);
  return freezeTree(ModelStepMetadataSchema.parse(next));
}
