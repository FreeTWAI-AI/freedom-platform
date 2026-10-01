import {useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import type {SessionPayload} from '../types';
import {BrandPoster} from './Community';
import {MemberECard,type CardDesign,type CardLink} from './MemberECard';
import {MemberCard,loadLabels,type MemberCardData} from './Membership';
import {useModuleMutation} from './shared';
import './MemberConnections.css';
type PublicCard={nickname:string;primary_guild:{name:string;guild_key:string}|null;capabilities:string[];avatar_url:string|null;design?:CardDesign;headline?:string|null;links?:CardLink[]};
export function PublicMemberPage({client,token,session,onLogin,onReturn}:{client:PortalClient;token:string;session?:SessionPayload;onLogin:()=>void;onReturn:()=>void}){
  const [card,setCard]=useState<PublicCard|null>(null),[member,setMember]=useState<MemberCardData|null>(null),[labels,setLabels]=useState<Record<string,string>>({}),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const generation=useRef(0),{mutate,busy,error}=useModuleMutation(client);
  async function load(){const current=++generation.current;setLoading(true);setLoadError('');setCard(null);setMember(null);try{
    const data=await client.get<PublicCard>(`/public/member-cards/${token}`);if(current!==generation.current)return;setCard(data);
    if(session){const full=await client.get<MemberCardData>(`/member-cards/${token}/member`);if(current===generation.current)setMember(full);}
  }catch(cause){if(current===generation.current)setLoadError(cause instanceof Error?cause.message:'名片暫時無法開啟。');}finally{if(current===generation.current)setLoading(false);}}
  useEffect(()=>{void load();if(session)void loadLabels(client).then(setLabels).catch(()=>{});return()=>{generation.current++;};},[client,token,session?.user.user_id]);
  async function invite(){if(!member)return;const saved=await mutate(`/friends/${member.user_id}/request`,{},member.friendship.aggregate_version);if(saved){setNotice('好友邀請已送出。');await load();}}
  const design=card?.design??'calm';
  return <main className="public-member-page" data-design={!loading&&!loadError&&card?design:undefined}><BrandPoster compact/>
    {loading&&<p role="status">正在開啟工坊名片…</p>}
    {loadError&&<div className="card stack" role="alert"><h1>暫時無法開啟這張名片</h1><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重新載入名片</button><button type="button" className="btn btn-primary" onClick={onReturn}>前往自由工坊</button></div>}
    {!loading&&!loadError&&card&&<>
      <MemberECard design={design} nickname={card.nickname} headline={card.headline??null} guildName={card.primary_guild?.name??null} capabilities={card.capabilities} avatarUrl={card.avatar_url} links={card.links??[]} heading="h1"/>
      {member&&<MemberCard member={member} labels={labels} client={client}/>}
      {session?<div className="actions">{member&&!member.is_self&&(member.friendship.state==='accepted'?<span className="badge">你們已是好友</span>:member.friendship.state==='pending'?<span>好友邀請待回覆</span>:<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void invite()}>邀請成為好友</button>)}<button type="button" className="btn btn-ghost" onClick={onReturn}>返回會員首頁</button></div>:<section className="public-card-invite"><h2>和社群夥伴一起把想法做出來</h2><p>加入感興趣的公會、閱讀免費技能書，找到擅長不同事情的人一起學習、創作與合作。</p><button type="button" className="btn btn-primary" onClick={onLogin}>加入自由工坊／登入</button><p className="field-hint">Email、密碼即可建立帳號，名稱選填；再選一個公會就能開始。完整定位可稍後補做。</p></section>}
    </>}{error&&<p role="alert" className="banner banner-error">{error}</p>}{notice&&<p role="status" className="banner status-note">{notice}</p>}
  </main>;
}
