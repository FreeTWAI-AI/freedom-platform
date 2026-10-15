import {useEffect, useState} from 'react';
import type {SkillBook} from '../../../../modules/community/catalog';
import {commerceReadingReferences} from './skill-book-commerce-references';

function publicReadingUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function CommerceReadingReferences() {
  return <details className="skill-book-references">
    <summary>開店延伸閱讀與來源</summary>
    <p className="field-hint">以下是開店規劃的學習與設計參考，尚不表示本站版本已採用或安裝這些工具。</p>
    <ul>{commerceReadingReferences.map(source => {
      const base = `https://github.com/${source.repository}/blob/${source.commit}`;
      return <li key={source.repository}>
        <a href={`${base}/README.md`} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>
        <p><strong>{source.role}</strong> · {source.description}</p>
        <p className="field-hint">{source.attribution} · 閱讀版本 <code>{source.commit.slice(0, 12)}</code> · {source.license
          ? <a href={`${base}/LICENSE`} target="_blank" rel="noopener noreferrer">{source.license} 授權 ↗</a>
          : '未見 LICENSE，使用素材或程式前須另確認授權'}</p>
      </li>;
    })}</ul>
  </details>;
}

export function PortableBusinessStatus() {
  // The current registry has no published portable-business release artifact.
  // Neither external-supported nor a skill/CSV link establishes availability.
  return <p className="field-hint"><strong>可攜營業版本：</strong>目前沒有已核對的獨立部署發行物可供下載。原作技能書與資料匯出各有用途，完整營業包另需部署、資料、備份與升級支援。</p>;
}

export function StorefrontBookUsage({onNavigate}: {onNavigate: () => void}) {
  return <section className="skill-book-usage" aria-label="商店技能書的使用方式">
    <h3>閱讀原作、站內使用與自行部署</h3>
    <p><strong>原作技能書：</strong>依收錄版本學習與下載原作；下方練習和功能說明屬於該版本。</p>
    <p><strong>站內應用：</strong>由工坊維護，使用本站的會員、業務空間與資料。適用功能、版本與啟動資格請在公會工具目錄查看。</p>
    <a className="btn btn-ghost btn-small" href="#guilds/guild_commerce_sales" onClick={onNavigate}>前往開店與銷售公會</a>
    <PortableBusinessStatus/>
    <CommerceReadingReferences/>
  </section>;
}

export function ApplicationSkillSources({refs}: {refs: readonly string[]}) {
  const refsKey = JSON.stringify(refs);
  const [loaded, setLoaded] = useState<{key: string; books: SkillBook[]; error: boolean} | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!refs.length) return;
    const controller = new AbortController();
    setLoaded(null);
    // The public catalog still needs same-origin edge admission on Access-protected hosts.
    void fetch('/api/v1/community', {credentials: 'same-origin', signal: controller.signal, headers: {Accept: 'application/json'}})
      .then(async response => {
        if (!response.ok) throw new Error('catalog_unavailable');
        const data = await response.json();
        if (!Array.isArray(data.skill_books)) throw new Error('catalog_invalid');
        const books = data.skill_books.filter((book: SkillBook) => book && typeof book.id === 'string' && typeof book.title === 'string' && refs.includes(book.id));
        if (!controller.signal.aborted) setLoaded({key: refsKey, books, error: false});
      }).catch(() => {if (!controller.signal.aborted) setLoaded({key: refsKey, books: [], error: true});});
    return () => controller.abort();
  }, [refsKey, retry]);
  const current = loaded?.key === refsKey ? loaded : null;
  return <section className="skill-book-usage" aria-label="此版本的原作技能書">
    <h4>原作技能書</h4>
    <p className="field-hint">以下依此應用版本登錄的參照呈現。原作有自己的作者、授權與閱讀版本；閱讀不需要啟動應用，也不授予本站資料權限。</p>
    {refs.length && !current ? <p role="status">正在載入原作閱讀資料…</p> : current?.error
      ? <p role="alert">原作閱讀資料暫時無法載入。<button type="button" className="btn btn-ghost btn-small" onClick={() => setRetry(value => value + 1)}>重讀閱讀資料</button></p>
      : refs.length ? <ul>{Array.from(new Set(refs), ref => {
      const book = current?.books.find(item => item.id === ref);
      const guide = book?.guide;
      const reading = publicReadingUrl(guide?.reading_url) ?? publicReadingUrl(book?.upstream_url) ?? publicReadingUrl(book?.repository_url);
      const sourceCommit = [guide?.source_commit, book?.source_commit].find(value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value));
      return <li key={ref}>{book
        ? <>{reading ? <a href={reading} target="_blank" rel="noopener noreferrer">閱讀《{book.title}》原作 ↗</a> : <span>{book.title}（來源閱讀連結尚未提供）</span>}
          {guide?.author_name && <p className="field-hint">來源標示的作者：{guide.author_name}</p>}
          <p className="field-hint">{sourceCommit ? <>閱讀版本 <code>{sourceCommit.slice(0, 12)}</code></> : '閱讀版本未提供'} · {book.license_status === 'NOASSERTION' ? '授權待確認，使用前請見原作說明。' : `來源記錄的授權：${book.license_status || '未提供'}`}</p></>
        : <>{ref} <span className="field-hint">（尚無對應的閱讀指南）</span></>}</li>;
    })}</ul> : <p>此版本尚未登錄技能書參照。</p>}
  </section>;
}
