import { communityCatalog } from '../community/catalog.js';

/** owner/name from a GitHub repository URL, lowercased. Trailing slash and .git are ignored. */
export function githubRepositoryPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
    let pathname = parsed.pathname.replace(/\/+$/, '');
    if (pathname.toLowerCase().endsWith('.git')) pathname = pathname.slice(0, -4);
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Catalog book whose repository_url path equals this full name. First match wins. */
export function skillBookIdForFullName(fullName: string): string | null {
  const target = fullName.toLowerCase();
  for (const book of communityCatalog.skill_books) {
    const path = githubRepositoryPath(book.repository_url);
    if (path && path === target) return book.id;
  }
  return null;
}

export function skillBookTitle(id: string | null | undefined): string | null {
  if (!id) return null;
  return communityCatalog.skill_books.find(book => book.id === id)?.title ?? null;
}

export function isCatalogSkillBook(id: string): boolean {
  return communityCatalog.skill_books.some(book => book.id === id);
}

export function skillBookChoices(): Array<{ skill_book_id: string; title: string }> {
  return communityCatalog.skill_books.map(book => ({ skill_book_id: book.id, title: book.title }));
}
