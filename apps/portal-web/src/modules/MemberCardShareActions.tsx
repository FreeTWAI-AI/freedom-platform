import type {PortalClient} from '../api';
import {PromotionShare} from './PromotionShare';

const SHARE_TEXT='一起加入自由工坊，找到夥伴、學習與創作。';

export function MemberCardShareActions({client,target,title,url,pending=false,blocked=false}:{client:PortalClient;target?:string;title:string;url:string;pending?:boolean;blocked?:boolean}){
  const inactive=pending||blocked;
  return <div className="member-card-share-actions actions">
    {target
      ? <PromotionShare client={client} kind="member_card" target={target} title={title} text={SHARE_TEXT} label="分享名片"/>
      : <button type="button" className="btn btn-ghost" disabled>分享名片</button>}
    <a className="btn btn-ghost" href={url} target="_blank" rel="noopener noreferrer" aria-disabled={inactive?true:undefined} onClick={event=>{if(inactive)event.preventDefault();}}>{pending?'儲存中…':'開啟名片'}</a>
  </div>;
}
