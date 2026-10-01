import {useCallback,useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {useModuleMutation} from './shared';
import type {GuildSummary} from './Onboarding';

export type GuildEntryQuestion={id:string;prompt:string;options:{id:string;label:string}[]};
type GuildAnswerItem={guild_key:string;name:string;question_set_version:string;outdated:boolean;answers:{question_id:string;prompt:string;option_id:string;label:string}[]|null;aggregate_version:number|null;updated_at:string|null};

export function GuildQuestionFields({questions,answers,onChange,disabled=false,namePrefix='guild-q'}:{questions:GuildEntryQuestion[];answers:Record<string,string>;onChange:(questionId:string,optionId:string)=>void;disabled?:boolean;namePrefix?:string}){
  return <>{questions.map(question=><fieldset className="guild-question" key={question.id} disabled={disabled}><legend>{question.prompt}</legend><div className="guild-question-options">{question.options.map(option=><label className={`guild-question-option${answers[question.id]===option.id?' is-selected':''}`} key={option.id}><input type="radio" name={`${namePrefix}-${question.id}`} value={option.id} checked={answers[question.id]===option.id} onChange={()=>onChange(question.id,option.id)}/><span>{option.label}</span></label>)}</div></fieldset>)}</>;
}

export function GuildAnswersSection({client}:{client:PortalClient}){
  const [items,setItems]=useState<GuildAnswerItem[]|null>(null),[directory,setDirectory]=useState<GuildSummary[]>([]);
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[directoryError,setDirectoryError]=useState(''),[notice,setNotice]=useState('');
  const [editing,setEditing]=useState(''),[draft,setDraft]=useState<Record<string,string>>({});
  const generation=useRef(0),{mutate,busy,error}=useModuleMutation(client);
  const questionsFor=useCallback((guildKey:string)=>directory.find(guild=>guild.guild_key===guildKey)?.entry_questions?.questions??[],[directory]);
  const load=useCallback(async(initial:boolean)=>{
    const sequence=++generation.current;if(initial)setLoading(true);setLoadError('');setDirectoryError('');
    const [answers,guilds]=await Promise.allSettled([client.get<{items:GuildAnswerItem[]}>('/me/guild-answers'),client.get<{items:GuildSummary[]}>('/guilds/directory')]);
    if(sequence!==generation.current)return;
    if(answers.status==='fulfilled')setItems(answers.value.items);else setLoadError(answers.reason instanceof Error?answers.reason.message:'公會小問答暫時無法載入。');
    if(guilds.status==='fulfilled')setDirectory(guilds.value.items);else setDirectoryError(guilds.reason instanceof Error?guilds.reason.message:'題目暫時無法載入。');
    if(initial)setLoading(false);
  },[client]);
  useEffect(()=>{void load(true);return()=>{generation.current++;};},[load]);
  function open(item:GuildAnswerItem){
    const questions=questionsFor(item.guild_key);
    if(!questions.length){setDirectoryError(directoryError||'題目暫時無法載入。');return;}
    const next:Record<string,string>={};
    for(const question of questions){const saved=item.answers?.find(answer=>answer.question_id===question.id&&question.options.some(option=>option.id===answer.option_id));if(saved)next[question.id]=saved.option_id;}
    setDraft(next);setEditing(item.guild_key);setNotice('');
  }
  async function save(item:GuildAnswerItem){
    const questions=questionsFor(item.guild_key);
    if(!questions.length||questions.some(question=>!draft[question.id])||busy)return;
    const result=await mutate<GuildAnswerItem>(`/me/guild-answers/${item.guild_key}`,{answers:draft},item.aggregate_version??undefined);
    if(result){setEditing('');setNotice(`已儲存${item.name}的小問答。`);await load(false);}
  }
  return <section className="card guild-answers" aria-labelledby="guild-answers-title">
    <h2 id="guild-answers-title">公會小問答</h2>
    {loading&&<p role="status">正在載入公會小問答…</p>}
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load(items===null)}>重新載入小問答</button></div>}
    {directoryError&&<div className="banner banner-error" role="alert"><p>{directoryError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load(false)}>重新載入題目</button></div>}
    {notice&&<p role="status" className="banner status-note">{notice}</p>}
    {error&&<p role="alert" className="banner banner-error">{error}</p>}
    {!loading&&items&&!items.length&&<p>加入公會後，可以在這裡回答小問題。</p>}
    {items?.map(item=>{
      const questions=questionsFor(item.guild_key),openEditor=editing===item.guild_key;
      const ready=questions.length>0&&questions.every(question=>draft[question.id]);
      return <article className="guild-answer-card" key={item.guild_key} aria-labelledby={`guild-answers-${item.guild_key}`}>
        <header><h3 id={`guild-answers-${item.guild_key}`}>{item.name}</h3>{!openEditor&&<button type="button" className="btn btn-ghost" onClick={()=>open(item)}>{item.answers?'修改':'回答'}</button>}</header>
        {item.outdated&&<p className="field-hint">題目已更新，請重新確認</p>}
        {!openEditor&&item.answers&&<dl className="guild-answer-pairs">{item.answers.map(answer=><div key={answer.question_id}><dt>{answer.prompt}</dt><dd>{answer.label}</dd></div>)}</dl>}
        {openEditor&&<div className="stack"><GuildQuestionFields questions={questions} answers={draft} disabled={busy} namePrefix={`edit-${item.guild_key}`} onChange={(questionId,optionId)=>setDraft(current=>({...current,[questionId]:optionId}))}/><div className="actions"><button type="button" className="btn btn-primary" disabled={!ready||busy} onClick={()=>void save(item)}>{busy?'正在儲存…':'儲存小問答'}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>setEditing('')}>取消</button></div></div>}
      </article>;
    })}
  </section>;
}
