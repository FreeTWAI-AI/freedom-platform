import {useContext} from 'react';
import {GitHubBookSocial,SkillBookStarGateContext} from './GitHubSocial';

type BookIdentity = { id?: string; book_id?: string; cover_url?: string };
type BookSource = BookIdentity & { upstream_url?: string; star_url?: string; repository_url: string };

export function skillBookCoverUrl(book: BookIdentity) {
  // Platform books and 社群技能書 share one cover format; see docs/design/*-art-manifest.json.
  if (book.cover_url && /^\/art\/(?:skills|community-skills)\/[a-z0-9-]+\.webp$/.test(book.cover_url)) return book.cover_url;
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

export function SkillBookStar({ book,compact=false }: { book: BookSource;compact?:boolean }) {
  const url = skillBookStarUrl(book),id=book.id??book.book_id;
  return url&&id ? <GitHubBookSocial bookId={id} repositoryUrl={url} compact={compact}/> : null;
}

export function SkillBookStarGate({books}:{books:(BookSource&{title:string})[]}){
  const enabled=useContext(SkillBookStarGateContext);
  if(!enabled||!books.length)return null;
  const uniqueBooks=new Map(books.map(book=>[book.id??book.book_id,book]));
  return <section className="stack" aria-label="技能書 Star 前置條件">
    <p className="field-hint" role="status">領取技能書或晉升前，請先透過 GitHub 授權驗證並連結本人的帳號，為下列原作 Repo 加星。按空心星星可連結 GitHub 或一鍵 Star；連結本身不會替你加星。完成後重試加入或晉升，系統會即時向 GitHub 確認；未加星或無法確認時不會放行。</p>
    {Array.from(uniqueBooks.values(),book=><div key={book.id??book.book_id}><strong>{book.title}</strong><SkillBookStar book={book} compact/></div>)}
  </section>;
}
