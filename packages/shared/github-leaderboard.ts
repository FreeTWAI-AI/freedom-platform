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

export type GitHubLeaderboardItem = {author: string | null; kind: 'issue' | 'pr'};
export type GitHubAuthorTotals = {login: string; ideas: number; edits: number};

/** Same counts the history page used to compute in the browser: every state, bots skipped, logins grouped case-insensitively. */
export function leaderboardFromItems(items: readonly GitHubLeaderboardItem[]): GitHubAuthorTotals[] {
  const totals = new Map<string, GitHubAuthorTotals>();
  for (const item of items) {
    const login = item.author?.trim();
    if (!login || isGitHubBot(login)) continue;
    const id = login.toLowerCase();
    const row = totals.get(id) ?? {login, ideas: 0, edits: 0};
    if (item.kind === 'issue') row.ideas += 1;
    else row.edits += 1;
    totals.set(id, row);
  }
  return [...totals.values()];
}

/** Competition ranks for rows already sorted by count, highest first: ties share a rank (1, 2, 2, 4). */
export function withRanks<T extends {count: number}>(rows: readonly T[]): (T & {rank: number})[] {
  const ranked: (T & {rank: number})[] = [];
  rows.forEach((row, index) => ranked.push({...row, rank: index > 0 && row.count === rows[index - 1].count ? ranked[index - 1].rank : index + 1}));
  return ranked;
}

export function rankedLeaderboards(rows: readonly GitHubAuthorTotals[]) {
  const ranked = (value: (row: GitHubAuthorTotals) => number) => rows
    .filter(row => value(row) > 0)
    .sort((a, b) => value(b) - value(a) || a.login.localeCompare(b.login));
  return {
    ideas: ranked(row => row.ideas).map(row => ({login: row.login, count: row.ideas})),
    edits: ranked(row => row.edits).map(row => ({login: row.login, count: row.edits})),
    contributions: ranked(row => contributionPoints(row.ideas, row.edits)).map(row => ({login: row.login, count: contributionPoints(row.ideas, row.edits)})),
  };
}
