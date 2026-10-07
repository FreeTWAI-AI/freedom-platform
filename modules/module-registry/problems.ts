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

/** The failing dimension is copied onto the JSON body. Quota is not a rate, so there is no Retry-After. */
export class QuotaExceeded extends Problem {
  readonly dimension: string;
  constructor(dimension: string) {
    super(429, 'quota_exceeded', `已達到這個業務空間的容量上限。（${dimension}）`);
    this.dimension = dimension;
  }
}

export type DependencyCandidate = { requirement_key: string; instance_id: string; version: string; created_at: string };

export class DependencySelectionRequired extends Problem {
  readonly candidates: readonly DependencyCandidate[];
  constructor(candidates: readonly DependencyCandidate[]) {
    super(409, 'dependency_selection_required', '這個應用要先選擇要沿用的模組實例。');
    this.candidates = candidates;
  }
}
