import './GuildName.css';

export function guildLabel(name:string,alias?:string|null){
  const trimmed=alias?.trim()??'';
  return trimmed?`${name}（${trimmed}）`:name;
}

export function GuildName({name,alias}:{name:string;alias?:string|null}){
  const trimmed=alias?.trim()??'';
  if(!trimmed)return <span className="guild-name"><span className="guild-name-main">{name}</span></span>;
  return <span className="guild-name"><span className="guild-name-main">{name}</span><span className="guild-name-sep" aria-hidden="true">·</span><span className="guild-name-alias"><span className="visually-hidden">別名：</span>{trimmed}</span></span>;
}
