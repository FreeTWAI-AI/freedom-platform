import './GuildLeadership.css';

type GuildPerson={user_id?:string;display_name:string};

/** Uses only the public directory's visible people; never synthesizes avatars or roles. */
export function GuildLeadership({masterName,masterId,experts=[]}:{masterName:string;masterId?:string;experts?:GuildPerson[]}){
  return <div className="guild-leadership" role="group" aria-label="公會團隊">
    <div className={`guild-leadership-row guild-master${masterId?'':' is-unlinked'}`} data-user-id={masterId}>
      <span className="guild-leadership-role">公會長<span className="guild-leadership-colon">：</span></span><strong className="guild-leadership-name">{masterName}</strong>
    </div>
    {experts.length>0&&<div className="guild-experts">{experts.map((expert,index)=><div className="guild-leadership-row guild-expert" key={expert.user_id??index} data-user-id={expert.user_id}>
      <span className="guild-leadership-role">公會專家<span className="guild-leadership-colon">：</span></span><strong className="guild-leadership-name">{expert.display_name}</strong>
    </div>)}</div>}
  </div>;
}
