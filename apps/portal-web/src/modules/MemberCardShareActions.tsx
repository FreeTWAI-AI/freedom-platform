import {useId} from 'react';

// Swap point: another branch can replace this with
// <PromotionShare kind="member_card" target={userId} title={displayName} label="分享"/>.
export function MemberCardShareActions({kind='member_card',target,title,label='分享',url,onNotice}:{kind?:'member_card';target?:string;title:string;label?:string;url:string;onNotice?:(message:string)=>void}){
  const fieldId=useId(),canShare=typeof navigator.share==='function';
  function fallback(){const input=document.getElementById(fieldId);if(input instanceof HTMLInputElement){input.focus();input.select();}onNotice?.('分享未完成，你可以選取下方連結手動複製。');}
  async function copy(){onNotice?.('');try{await navigator.clipboard.writeText(url);onNotice?.('名片邀請連結已複製。');}catch{fallback();}}
  async function share(){onNotice?.('');try{await navigator.share({title,text:'一起加入自由工坊，找到夥伴、學習與創作。',url});}catch(cause){if(cause instanceof DOMException&&cause.name==='AbortError')return;fallback();}}
  return <div className="member-card-share-actions" data-share-kind={kind} data-share-target={target??''}>
    <label className="field" htmlFor={fieldId}>名片邀請連結<input id={fieldId} readOnly value={url} onFocus={event=>event.currentTarget.select()}/></label>
    <div className="actions">
      <button type="button" className={canShare?'btn btn-ghost':'btn btn-primary'} onClick={()=>void copy()}>複製連結</button>
      {canShare&&<button type="button" className="btn btn-primary" onClick={()=>void share()}>{label}</button>}
      <a className="btn btn-ghost" href={url} target="_blank" rel="noopener noreferrer">開啟名片</a>
    </div>
  </div>;
}
