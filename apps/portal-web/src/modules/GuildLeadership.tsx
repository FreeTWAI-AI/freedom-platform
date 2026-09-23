import {MemberAvatar} from './MemberAvatar';
import './GuildLeadership.css';

type GuildPerson={user_id?:string;display_name:string;avatar_url?:string|null};

/** Visible directory metadata only; MemberAvatar validates the local image URL. */
export function GuildLeadership({masterName,masterId,masterAvatarUrl,experts=[]}:{masterName:string;masterId?:string;masterAvatarUrl?:string|null;experts?:GuildPerson[]}){
  return <div className="guild-leadership" role="group" aria-label="公會團隊">
    <div className={`guild-leadership-row guild-master${masterId?'':' is-unlinked'}`} data-user-id={masterId}>
      <MemberAvatar nickname={masterName} avatarUrl={masterAvatarUrl} className="guild-leadership-avatar"/>
      <div className="guild-leadership-person"><strong className="guild-leadership-name">{masterName}</strong><span className="guild-leadership-role">公會長</span></div>
    </div>
    {experts.length>0&&<div className="guild-experts">{experts.map((expert,index)=><div className="guild-leadership-row guild-expert" key={expert.user_id??index} data-user-id={expert.user_id}>
      <MemberAvatar nickname={expert.display_name} avatarUrl={expert.avatar_url} className="guild-leadership-avatar"/>
      <div className="guild-leadership-person"><strong className="guild-leadership-name">{expert.display_name}</strong><span className="guild-leadership-role">公會專家</span></div>
    </div>)}</div>}
  </div>;
}
