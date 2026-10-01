import { communityCatalog } from '../community/catalog.js';

export interface CatalogBookMatch {
  book_id: string;
  title: string;
  public_path: string;
}

// owner/repo of a GitHub repository root. Trailing slash and .git are ignored.
function parseGitHubRepository(url: string | null | undefined): { display: string; key: string } | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const name = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = name.split('/');
  if (parts.length !== 2 || parts.some(part => part === '' || part === '.' || part === '..')) return null;
  return { display: `${parts[0]}/${parts[1]}`, key: `${parts[0]}/${parts[1]}`.toLowerCase() };
}

export function repositoryKey(url: string | null | undefined): string | null {
  return parseGitHubRepository(url)?.key ?? null;
}

export function repositoryDisplayName(url: string | null | undefined): string | null {
  return parseGitHubRepository(url)?.display ?? null;
}

const booksByRepository = new Map<string, CatalogBookMatch>();
for (const book of communityCatalog.skill_books) {
  const match: CatalogBookMatch = { book_id: book.id, title: book.title, public_path: `/development/skills/${book.id}` };
  for (const url of [book.repository_url, book.upstream_url]) {
    const key = repositoryKey(url);
    if (key && !booksByRepository.has(key)) booksByRepository.set(key, match);
  }
}

export const catalogRepositoryKeys: readonly string[] = [...booksByRepository.keys()];

export function catalogBookForRepository(key: string | null | undefined): CatalogBookMatch | null {
  if (!key) return null;
  return booksByRepository.get(key.toLowerCase()) ?? null;
}
