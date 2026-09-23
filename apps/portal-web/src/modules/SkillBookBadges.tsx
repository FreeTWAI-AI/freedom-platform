import {useSkillDiscovery} from './skill-discovery-client';
import './SkillDiscovery.css';

export function SkillBookBadges({bookId}:{bookId?:string}){
  const {data,error}=useSkillDiscovery(),book=data?.books.find(item=>item.book_id===bookId);
  if(!book||error)return null;
  return <div className="skill-book-badges" aria-label="技能書徽章">
    {book.official_guild_keys.length>0&&<span className="skill-badge skill-badge-official" title="自由工坊公會指定技能；不代表原作者背書"><span aria-hidden="true">✦</span><span>官方公會技能</span></span>}
    {book.is_new_today&&<span className="skill-badge skill-badge-new" title="今天首次收錄於自由工坊（台北時間）">每日新技能</span>}
    {book.week_rank!==null&&<span className="skill-badge skill-badge-rank">工坊週榜 #{book.week_rank}</span>}
    {book.month_rank!==null&&<span className="skill-badge skill-badge-rank">工坊月榜 #{book.month_rank}</span>}
  </div>;
}
