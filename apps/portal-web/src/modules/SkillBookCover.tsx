import {GitHubBookSocial} from './GitHubSocial';

type BookIdentity = { id?: string; book_id?: string; cover_url?: string };
type BookSource = BookIdentity & { upstream_url?: string; star_url?: string; repository_url: string };

export function skillBookCoverUrl(book: BookIdentity) {
  if (book.cover_url && /^\/art\/skills\/[a-z0-9-]+\.webp$/.test(book.cover_url)) return book.cover_url;
  const id = book.id ?? book.book_id;
  return id && /^[a-z0-9-]+$/.test(id) ? `/art/skills/${id}.webp` : null;
}

// Metrics and stars always credit the original author, independently of workshop forks.
export function skillBookStarUrl(book: BookSource) {
  try {
    const url = new URL(book.upstream_url ?? book.star_url ?? book.repository_url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null;
    if (!/^\/[a-z\d][a-z\d-]*\/[a-z\d_.-]+\/?$/i.test(url.pathname)) return null;
    return `https://github.com${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

export function SkillBookCover({ book, className = '' }: { book: BookIdentity; className?: string }) {
  const url = skillBookCoverUrl(book);
  return url ? <img className={`skill-book-illustration ${className}`} src={url} alt="" width="768" height="512" loading="lazy" decoding="async"/> : null;
}

export function SkillBookStar({ book,showFork=true,compact=false }: { book: BookSource;showFork?:boolean;compact?:boolean }) {
  const url = skillBookStarUrl(book),id=book.id??book.book_id;
  return url&&id ? <GitHubBookSocial bookId={id} repositoryUrl={url} showFork={showFork} compact={compact}/> : null;
}
