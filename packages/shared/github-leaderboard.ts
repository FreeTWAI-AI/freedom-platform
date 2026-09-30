/** Display-only GitHub history scores. Never written as XP, rewards or member credit. */
export const IDEA_POINTS = 5;
export const EDIT_POINTS = 20;

/** Rankings skip automation accounts. History lists still show their issues and pull requests. */
export function isGitHubBot(login: string): boolean {
  const value = login.trim().toLowerCase();
  if (!value) return true;
  return value.endsWith('[bot]') || value === 'dependabot' || value === 'github-actions';
}

export function contributionPoints(issues: number, pulls: number): number {
  return issues * IDEA_POINTS + pulls * EDIT_POINTS;
}

/** A closed issue is resolved even when GitHub's state_reason is not_planned. */
export function issueResolved(state: 'open' | 'closed'): boolean {
  return state === 'closed';
}

export function pullUpdated(mergedAt: string | null | undefined): boolean {
  return Boolean(mergedAt);
}

/** Closed without a merge commit. Open pull requests are simply not updated yet. */
export function pullClosedUnmerged(state: 'open' | 'closed', mergedAt: string | null | undefined): boolean {
  return state === 'closed' && !mergedAt;
}
