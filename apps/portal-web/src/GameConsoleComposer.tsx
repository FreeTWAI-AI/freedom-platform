import {useEffect,useRef,useState,type FormEvent} from 'react'
import {ApiError,type PortalClient} from './api'
import {logConsoleEvent,type ConsoleVisibility,type GameConsoleChannel} from './game-console-core'
import {announceInboxChange} from './modules/member-inbox'

type ChatChannel='guild'|'squad'|'direct'|'world_chat'
type Target={id:string;name:string}
type Room={kind:'guild'|'squad';channel_key:string;name:string}
type Conversation={participant:{user_id:string;display_name:string};can_send:boolean}
type Member={user_id:string;nickname:string;is_self:boolean}
type Page<T>={items:T[];next_offset:number|null}
type SentMessage={message_id:string;body:string;created_at:string;sender_name?:string}
type Pending={idempotencyKey:string;body:string;unconfirmed:boolean}

const isChat=(channel:GameConsoleChannel):channel is ChatChannel=>['guild','squad','direct','world_chat'].includes(channel)
const failure=(cause:unknown)=>cause instanceof Error&&cause.message?cause.message:'請稍後重試。'
const unconfirmed=(cause:unknown)=>!(cause instanceof ApiError)||cause.network||cause.status===0||cause.status>=500

export function GameConsoleComposer({client,userId,enabled,channel,visibility}: {
  client?:PortalClient;userId?:string;enabled:boolean;channel:GameConsoleChannel;
  visibility:ConsoleVisibility;
}){
  const [rooms,setRooms]=useState<Record<'guild'|'squad',Target[]>>({guild:[],squad:[]})
  const [peers,setPeers]=useState<Target[]>([])
  const [chosen,setChosen]=useState<Partial<Record<'guild'|'squad'|'direct',Target>>>({})
  const [query,setQuery]=useState(''),[matches,setMatches]=useState<Target[]>([])
  const [searchState,setSearchState]=useState<'idle'|'loading'|'ready'|'error'>('idle')
  const [listState,setListState]=useState<'idle'|'loading'|'ready'|'error'>('idle')
  const [listError,setListError]=useState(''),[searchError,setSearchError]=useState('')
  const [drafts,setDrafts]=useState<Record<string,string>>({})
  const [sendErrors,setSendErrors]=useState<Record<string,string>>({})
  const [sending,setSending]=useState<string|null>(null)
  const pending=useRef(new Map<string,Pending>())

  useEffect(()=>{
    if(!client||!userId||!enabled||!['guild','squad','direct'].includes(channel))return
    let live=true
    const load=async()=>{
      setListState('loading');setListError('')
      try{
        if(channel==='direct'){
          const page=await client.get<Page<Conversation>>('/me/conversations?limit=20&offset=0')
          if(live)setPeers(page.items.filter(item=>item.can_send).map(item=>({id:item.participant.user_id,name:item.participant.display_name})))
        }else{
          const kind=channel as 'guild'|'squad',items:Target[]=[]
          let offset:number|null=0
          while(offset!==null&&items.length<1000){
            const page:Page<Room>=await client.get<Page<Room>>(`/me/channels?kind=${kind}&limit=50&offset=${offset}`)
            items.push(...page.items.map(item=>({id:item.channel_key,name:item.name})))
            offset=page.next_offset
          }
          if(live)setRooms(current=>({...current,[kind]:items}))
        }
        if(live)setListState('ready')
      }catch(cause){if(live){setListState('error');setListError(failure(cause))}}
    }
    void load()
    const refresh=()=>void load()
    window.addEventListener('focus',refresh)
    window.addEventListener('freedom-profile-updated',refresh)
    return()=>{live=false;window.removeEventListener('focus',refresh);window.removeEventListener('freedom-profile-updated',refresh)}
  },[client,userId,enabled,channel])

  useEffect(()=>{
    if(channel!=='direct'||!client||!enabled||!query.trim()){
      setMatches([]);setSearchState('idle');setSearchError('');return
    }
    let live=true
    setSearchState('loading');setSearchError('')
    const timer=window.setTimeout(async()=>{
      try{
        const page=await client.get<Page<Member>>(`/members?${new URLSearchParams({search:query.trim(),limit:'20',offset:'0'})}`)
        if(live){setMatches(page.items.filter(item=>item.user_id!==userId&&!item.is_self).map(item=>({id:item.user_id,name:item.nickname})));setSearchState('ready')}
      }catch(cause){if(live){setSearchState('error');setSearchError(failure(cause))}}
    },300)
    return()=>{live=false;window.clearTimeout(timer)}
  },[channel,client,enabled,userId,query])

  const chatChannel=channel==='all'?'world_chat':channel
  if(!isChat(chatChannel))return <div className="game-console-action game-console-hint">
    <p>{channel==='ai'?'AI 工作指令與執行摘要會顯示在這裡。':channel==='guide'?'公告、任務與下一步指引會顯示在這裡。':'頁面錯誤與系統狀態會顯示在這裡。'}</p>
  </div>

  if(!enabled||!client||!userId)return <div className="game-console-action"><p>完成定位並登入後即可發送聊天訊息。</p></div>
  if(channel==='all'&&!visibility.world_chat)return <div className="game-console-action game-console-hint"><p>世界聊天已關閉。請在「頻道顯示」中開啟，即可從總頻道發言。</p></div>

  const selected=chatChannel==='world_chat'?null:chosen[chatChannel]
  const options:Target[]=chatChannel==='direct'?[...new Map([...(chosen.direct?[chosen.direct]:[]),...peers,...matches].map(item=>[item.id,item])).values()]
    :chatChannel==='world_chat'?[]:rooms[chatChannel]
  const key=chatChannel==='world_chat'?'world_chat':selected?`${chatChannel}/${selected.id}`:''
  const draft=key?drafts[key]??'':''
  const sendError=key?sendErrors[key]:''

  async function send(event:FormEvent){
    event.preventDefault()
    if(!client||!key||sending)return
    const body=draft.trim()
    if(!body)return
    if([...body].length>2000){setSendErrors(current=>({...current,[key]:'訊息最多 2000 字。'}));return}
    const previous=pending.current.get(key)
    const attempt:Pending={idempotencyKey:previous?.unconfirmed&&previous.body===body?previous.idempotencyKey:crypto.randomUUID(),body,unconfirmed:false}
    pending.current.set(key,attempt);setSending(key);setSendErrors(current=>({...current,[key]:''}))
    try{
      const path=chatChannel==='direct'?`/me/conversations/${encodeURIComponent(selected!.id)}/messages`
        :chatChannel==='world_chat'?'/me/channels/world/world/messages'
        :`/me/channels/${chatChannel}/${encodeURIComponent(selected!.id)}/messages`
      const message=await client.post<SentMessage>(path,{body},{idempotencyKey:attempt.idempotencyKey})
      pending.current.delete(key)
      setDrafts(current=>current[key]?.trim()===body?{...current,[key]:''}:current)
      logConsoleEvent({id:`${chatChannel==='direct'?'direct':'room'}:${message.message_id}`,channel:chatChannel,kind:'chat',level:'success',
        source:chatChannel==='direct'?`你 → ${selected!.name}`:chatChannel==='world_chat'?(message.sender_name??'你'):`${selected!.name} · ${message.sender_name??'你'}`,
        message:message.body,createdAt:message.created_at})
      announceInboxChange()
    }catch(cause){
      if(unconfirmed(cause)){
        pending.current.set(key,{...attempt,unconfirmed:true})
        setSendErrors(current=>({...current,[key]:`傳送結果未確認：${failure(cause)}。使用相同內容重試不會重複傳送。`}))
      }else{
        pending.current.delete(key)
        setSendErrors(current=>({...current,[key]:`訊息未送出：${failure(cause)}`}))
      }
    }finally{setSending(null)}
  }

  return <form className="game-console-action game-console-compose" data-channel={chatChannel} onSubmit={event=>void send(event)}>
    {chatChannel==='world_chat'&&<span className="game-console-compose-scope">世界聊天 <small>所有會員可見</small></span>}
    {chatChannel==='direct'&&<label className="game-console-search">搜尋會員
      <input type="search" value={query} maxLength={100} placeholder="輸入會員名稱" onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault()}}/>
    </label>}
    {chatChannel!=='world_chat'&&<label className="game-console-target">{chatChannel==='direct'?'私訊對象':chatChannel==='guild'?'公會頻道':'小隊頻道'}
      <select value={selected?.id??''} onChange={event=>{const target=options.find(item=>item.id===event.target.value);if(target)setChosen(current=>({...current,[chatChannel]:target}))}}>
        <option value="">{listState==='loading'?'讀取中…':chatChannel==='direct'?'請選擇會員':'請選擇頻道'}</option>
        {options.map(item=><option key={item.id} value={item.id}>{item.name} · {item.id.slice(0,8)}</option>)}
      </select>
    </label>}
    <label className="game-console-message"><span className={chatChannel==='world_chat'?'sr-only':undefined}>{chatChannel==='direct'?'私人訊息':chatChannel==='guild'?'公會訊息':chatChannel==='squad'?'小隊訊息':'世界聊天訊息'}</span>
      <input value={draft} disabled={!key||sending===key} maxLength={2000} placeholder={key?'輸入訊息…':'請先選擇對象'} onChange={event=>setDrafts(current=>({...current,[key]:event.target.value}))}/>
    </label>
    <button type="submit" disabled={!key||!draft.trim()||sending!==null}>{sending===key?'傳送中…':pending.current.get(key)?.unconfirmed&&pending.current.get(key)?.body===draft.trim()?'重試傳送':'傳送'}</button>
    {(chatChannel!=='world_chat'&&listState==='error'||chatChannel==='direct'&&(searchState==='error'||searchState==='loading'||searchState==='ready'&&matches.length===0)||sendError)&&<p className="game-console-compose-status" role={sendError||listState==='error'||searchState==='error'?'alert':'status'}>
      {sendError|| (listState==='error'?`頻道讀取失敗：${listError}`:searchState==='error'?`搜尋失敗：${searchError}`:searchState==='loading'?'搜尋中…':'找不到符合的會員。')}
    </p>}
  </form>
}
