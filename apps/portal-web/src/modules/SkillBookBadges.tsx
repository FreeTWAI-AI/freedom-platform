import {useSkillDiscovery} from './skill-discovery-client';
import {AuthorClaimBadge} from './AuthorClaim';
import './SkillDiscovery.css';

export const communityBadgeTitle='社群成員分享的技能書；不隨加入公會解鎖，所有人都能閱讀';
/** The badge slot every skill book shares: guild designations above, 社群技能書 below. */
export function CommunityBadge(){return <span className="skill-badge skill-badge-community" title={communityBadgeTitle}>社群技能書</span>;}
export function SkillBookBadges({bookId,community=false}:{bookId?:string;community?:boolean}){
  const {data,error}=useSkillDiscovery(),book=!error?data?.books.find(item=>item.book_id===bookId):undefined;
  const claim=<AuthorClaimBadge bookId={bookId}/>;
  if(!book&&!claim&&!community)return null;
  return <div className="skill-book-badges" aria-label="技能書徽章">
    {community&&<CommunityBadge/>}
    {!community&&book&&book.official_guild_keys.length>0&&(book.official_guilds?.length?book.official_guilds.map(guild=><span key={guild.guild_key} className="skill-badge skill-badge-official" title="自由工坊公會指定技能；不代表原作者背書"><span aria-hidden="true">✦</span><span>{guild.name}指定技能</span></span>):<span className="skill-badge skill-badge-official" title="自由工坊公會指定技能；不代表原作者背書"><span aria-hidden="true">✦</span><span>官方公會技能</span></span>)}
    {book?.is_new_today&&<span className="skill-badge skill-badge-new" title="今天首次收錄於自由工坊（台北時間）">每日新技能</span>}
    {book?.week_rank!=null&&<span className="skill-badge skill-badge-rank">工坊週榜 #{book.week_rank}</span>}
    {book?.month_rank!=null&&<span className="skill-badge skill-badge-rank">工坊月榜 #{book.month_rank}</span>}
    {claim}
  </div>;
}
