import {GUILD_TOPIC_LABELS,type GuildTopic} from '../../../../packages/shared/guild-topics';
import './MemberConnections.css';
export function GuildTopicFilter({value,onChange}:{value:GuildTopic|'';onChange:(value:GuildTopic|'')=>void}){
  return <div className="guild-topic-filter" role="group" aria-label="公會主題">
    <button type="button" className="btn btn-ghost" aria-pressed={value===''} onClick={()=>onChange('')}>全部主題</button>
    {Object.entries(GUILD_TOPIC_LABELS).map(([key,label])=><button key={key} type="button" className="btn btn-ghost" aria-pressed={value===key} onClick={()=>onChange(key as GuildTopic)}>{label}</button>)}
  </div>;
}
export function GuildTags({tags=[]}:{tags?:GuildTopic[]}){
  return <div className="tag-list guild-topic-tags">{tags.map(tag=><span key={tag} className="pill">{GUILD_TOPIC_LABELS[tag]}</span>)}</div>;
}
