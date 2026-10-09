/** Only an acknowledged publication may offer a public submission destination. */
export function skillPublicationPath(submission: {status:string;public_path?:string|null}): string | null {
  const path=submission.public_path;
  return submission.status==='published' && typeof path==='string'
    && /^\/development\/submissions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path) ? path : null;
}

export function PublishedSkillLinks({submission,onShelf}: {submission:{status:string;public_path?:string|null};onShelf?:()=>void}) {
  if(submission.status!=='published')return null;
  const path=skillPublicationPath(submission);
  return <div className="actions">
    {path && <a className="btn btn-primary" href={path} target="_blank" rel="noopener noreferrer">閱讀已公開技能書 ↗</a>}
    <a className="btn btn-ghost" href="/#skills" onClick={onShelf}>前往技能書架</a>
  </div>;
}


export type ProjectSkillBook = {
  status:'published'|'ready_for_review'|'awaiting_upload';
  submission_id:string|null;
  public_path:string|null;
  catalog_book:{book_id:string;title:string;public_path:string}|null;
  can_edit:boolean;
};
export function projectSkillBookPath(book:ProjectSkillBook|null|undefined):string|null {
  if(!book || book.status!=='published')return null;
  const catalog=book.catalog_book;
  if(catalog && /^[a-z0-9-]+$/.test(catalog.book_id) && catalog.public_path===`/development/skills/${catalog.book_id}`)return catalog.public_path;
  return skillPublicationPath(book);
}
export function projectSkillDraft(book:ProjectSkillBook|null|undefined,own:boolean):{submissionId:string;mode:'preview'|'complete'}|null {
  if(!own || !book || !book.submission_id || book.status==='published')return null;
  return {submissionId:book.submission_id,mode:book.status==='ready_for_review'?'preview':'complete'};
}
