import { Problem } from '../../packages/shared/problem.js';
import type { InstanceCandidate } from '../../contracts/guild-launchpad/v1/tenant-work.js';

/** Candidates are not fields of the shared Problem type. The HTTP handler copies them onto the JSON body. */
export class InstanceSelectionRequired extends Problem {
  readonly candidates: readonly InstanceCandidate[];
  constructor(candidates: readonly InstanceCandidate[]) {
    super(409, 'instance_selection_required', '這個工作區要先選擇要沿用的工作實例。');
    this.candidates = candidates;
  }
}
