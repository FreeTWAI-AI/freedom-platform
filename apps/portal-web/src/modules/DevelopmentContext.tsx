import {developmentPages} from '../../../../modules/development/pages';
import './DevelopmentContext.css';

/** A quiet, contextual entry for contributors; no member or session data is exposed. */
export function DevelopmentContext({moduleId}:{moduleId:string}){
 const page=developmentPages.find(value=>value.id===moduleId);
 if(!page)return null;
 return <aside className="development-context" aria-label="這一頁的開發入口" data-development-guide={`/development/${page.id}`}>
  <details key={moduleId}>
   <summary>參與這一頁的開發</summary>
   <div className="development-context-body">
    <p>想改善「{page.title}」？從指引找到程式碼與任務，也可以交給你的 AI Agent 閱讀。</p>
    <nav aria-label="開發與 Agent 指引">
     <a href={`/development/${page.id}`} target="_blank" rel="noopener noreferrer">查看這一頁的開發指引 ↗</a>
     <a href={`/development/${page.id}.md`} target="_blank" rel="noopener noreferrer">給 Agent 的文字版 ↗</a>
     <a href="https://github.com/FreeTWAI-AI/freedom-platform/fork" target="_blank" rel="noopener noreferrer">Fork 平台 Repo ↗</a>
    </nav>
    <p className="muted">Repo 是專案的程式碼庫；Fork 是複製到自己的 GitHub，再修改並提出 PR（合併提案）。</p>
    {page.related_repositories.length>0&&<p className="muted">商店、技能書與工具的程式碼位置也列在指引裡。</p>}
   </div>
  </details>
 </aside>;
}
