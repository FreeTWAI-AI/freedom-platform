import {useEffect,useLayoutEffect,useId,useRef,useState,type FormEvent} from 'react';
import {ApiError,type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import type {SessionPayload,TabId} from '../types';
import {announceInboxChange,INBOX_ALL_READ,type InboxUnread} from './member-inbox';
import {logConsoleEvent} from '../game-console-core';
import {consoleChannel} from '../game-console-routing';
import type {MessageContent,MessageContentInput} from '../../../../modules/member-communications/content-types';
import {findChatSticker} from '../../../../modules/member-communications/stickers';
import {ChatBody,ChatQuote,ChatExtras,chatPayload,quoteMessage,useRichChatDraft} from './ChatContent';
import {ChatInput,ChatTime,useChatViewport,useVisibleChatRead} from './ChatWorkspace';
import {ChatSearch} from './ChatSearch';
import {matchesChannelMessageAck} from './message-image-client';
import './MemberSettings.css';

export type ChannelKind='guild'|'squad'|'world';
type ChannelSummary={kind:ChannelKind;channel_key:string;name:string;unread_count:number;last_message_at:string|null};
type ChannelPage={items:ChannelSummary[];unread_count:number;next_offset:number|null};
type ChannelMessage={message_id:string;kind:ChannelKind;channel_key:string;sequence:string;sender_ref:string;sender_name:string;body:string;created_at:string}&MessageContent;
type History={channel:{kind:ChannelKind;channel_key:string;name:string};items:ChannelMessage[];unread_count:number;next_offset:number|null;next_after_sequence?:string|null};
type Activity={latest_sequence:string;unread_count:number};
type Pending={key:string;body:string;payload:MessageContentInput;status:'sending'|'unknown'};
type Props={client:PortalClient;session:SessionPayload;kind:ChannelKind;onUnread:(count:InboxUnread)=>void;onNavigate:(id:TabId)=>void;active?:boolean;compact?:boolean;openChannel?:{key:string;request:number}|null;onReturnToChats?:()=>void;registerLeave?:(guard:(()=>boolean)|null)=>void};

const PAGE=20,MAX_BODY=2000,LIVE_POLL_MS=1000;
const copy={
  guild:{title:'公會閒聊',unit:'公會',pick:'從頻道列表選擇一個公會後才會讀取訊息。',empty:'你還沒有加入任何公會，加入後會出現該公會的閒聊頻道。',home:'guilds',homeLabel:'前往職業公會',back:'回到職業公會'},
  squad:{title:'小隊閒聊',unit:'小隊',pick:'從頻道列表選擇一個小隊後才會讀取訊息。',empty:'你還沒有加入任何小隊，加入後會出現該小隊的閒聊頻道。',home:'squads',homeLabel:'前往小隊集合',back:'回到小隊集合'},
  world:{title:'世界聊天',unit:'世界',pick:'所有會員可見的交流空間。',empty:'所有會員可在這裡交流。',home:'community',homeLabel:'前往自由工坊社群',back:'回到自由工坊社群'},
} as const satisfies Record<ChannelKind,Record<string,string>>;
const fail=(cause:unknown,fallback='暫時無法讀取，請稍後重試。')=>cause instanceof Error&&cause.message?cause.message:fallback;
/** No response, timeout or 5xx: the server may already have applied the write. */
const unconfirmed=(cause:unknown)=>!(cause instanceof ApiError)||cause.network||cause.status===0||cause.status>=500;
/** The member left (or never had) this channel: nothing already shown may stay on screen. */
const revoked=(cause:unknown)=>cause instanceof ApiError&&(cause.status===403||cause.status===404);
const merge=<T,>(current:T[],next:T[],id:(value:T)=>string)=>{const seen=new Set(current.map(id));return [...current,...next.filter(value=>!seen.has(id(value)))];};
// Sequences are integer strings that may exceed Number precision.
const compare=(a:string,b:string)=>{const x=BigInt(a),y=BigInt(b);return x<y?-1:x>y?1:0;};
const newestFirst=(items:ChannelMessage[])=>[...items].sort((a,b)=>compare(b.sequence,a.sequence));

/** One guild or squad chat tab: the list is read on its own; a channel's history only after the member picks it. */
export function MemberChannels({client,session,kind,onUnread,onNavigate,active=true,compact=false,openChannel,onReturnToChats,registerLeave}:Props){
  const me=session.user.user_id,text=copy[kind],uid=useId();
  const mobile=useChatViewport(),singlePane=compact||mobile;
  const richDrafts=useRichChatDraft();
  const path=(key:string,rest:string)=>`/me/channels/${kind}/${encodeURIComponent(key)}/${rest}`;
  const [channels,setChannels]=useState<ChannelSummary[]>([]),[listNext,setListNext]=useState<number|null>(null);
  const [listStatus,setListStatus]=useState<'loading'|'ready'|'error'>('loading'),[listError,setListError]=useState('');
  const [listMore,setListMore]=useState({loading:false,error:''}),[listRefresh,setListRefresh]=useState({loading:false,error:''});
  const [selected,setSelected]=useState<{key:string;name:string}|null>(null),[history,setHistory]=useState<History|null>(null);
  const [status,setStatus]=useState<'idle'|'loading'|'ready'|'error'|'gone'>('idle'),[error,setError]=useState('');
  const [more,setMore]=useState({loading:false,error:''}),[refresh,setRefresh]=useState({loading:false,error:''});
  const [drafts,setDrafts]=useState<Record<string,string>>({}),[pending,setPendingState]=useState<Record<string,Pending>>({}),[sendErrors,setSendErrors]=useState<Record<string,string>>({});
  // Keep the original command visible to guards before React renders state.
  const held=useRef<Record<string,Pending>>({}),sendLocks=useRef(new Set<string>());
  function setPending(update:(value:Record<string,Pending>)=>Record<string,Pending>){
    held.current=update(held.current);setPendingState(held.current);
  }
  function canLeave(){
    if(Object.keys(held.current).length===0)return true;
    window.alert('頻道訊息傳送結果尚未確認。請回到待確認訊息重試；若已失去存取權，需先恢復頻道存取才能確認結果。');return false;
  }
  function onBeforeUnload(event:BeforeUnloadEvent){
    if(Object.keys(held.current).length>0){event.preventDefault();event.returnValue='';}
  }
  useLayoutEffect(()=>{
    registerLeave?.(canLeave);
    return()=>registerLeave?.(null);
  },[registerLeave]);
  useEffect(()=>{
    window.addEventListener('beforeunload',onBeforeUnload);
    return()=>window.removeEventListener('beforeunload',onBeforeUnload);
  },[]);
  const [reading,setReading]=useState(false),[readError,setReadError]=useState(''),[newerUnseen,setNewerUnseen]=useState(false);
  // The read itself was confirmed; only the unread count after it is not known yet.
  const [countUnconfirmed,setCountUnconfirmed]=useState('');
  // listInFlight/threadInFlight record the full read still out, so a confirmed write can supersede it.
  const listGeneration=useRef(0),listInFlight=useRef<boolean|null>(null),listState=useRef(listStatus);listState.current=listStatus;
  const threadGeneration=useRef(0),threadInFlight=useRef<{key:string;quiet:boolean}|null>(null);
  // current is the selected key; epoch counts selections so a late 404 cannot close a newer selection of the same key.
  const current=useRef<string|null>(null),epoch=useRef(0),gone=useRef(new Set<string>());
  const readAttempts=useRef(new Map<string,{through:string;key:string}>()),readLocks=useRef(new Set<string>()),readIssues=useRef(new Map<string,string>());
  const heading=useRef<HTMLHeadingElement>(null),focusThread=useRef(false),alive=useRef(true);
  const [roomQuery,setRoomQuery]=useState(''),[liveError,setLiveError]=useState(''),[hasNew,setHasNew]=useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const [picking,setPicking]=useState(true);
  const scroll=useRef<HTMLDivElement>(null),stick=useRef(true),anchor=useRef<{top:number;height:number}|null>(null),polling=useRef(false),retryAt=useRef(0),failures=useRef(0);
  const snapshot=useRef({history,status,more,reading,active,sending:false});snapshot.current={history,status,more,reading,active:active&&(!singlePane||!picking),sending:pending[selected?.key??'']?.status==='sending'};
  const openedRequest=useRef<number|null>(null);
  const searched=useRef('');
  useLayoutEffect(()=>{
    const node=scroll.current;if(!node)return;
    if(anchor.current){node.scrollTop=anchor.current.top+node.scrollHeight-anchor.current.height;anchor.current=null;}
    else if(stick.current){node.scrollTop=node.scrollHeight;setHasNew(false);}
  },[history,selected?.key,pending[selected?.key??''],picking,singlePane]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;listGeneration.current++;threadGeneration.current++;};},[]);

  function revoke(key:string,since:number,reread=true){
    if(current.current===key&&epoch.current!==since)return;
    gone.current.add(key);
    if(current.current===key){
      // Dropping the generation discards every read of this history that is still out.
      threadGeneration.current++;threadInFlight.current=null;
      setHistory(null);setStatus('gone');setMore({loading:false,error:''});setRefresh({loading:false,error:''});setReadError('');setNewerUnseen(false);setCountUnconfirmed('');
    }
    setChannels(value=>value.filter(item=>item.channel_key!==key));
    // Losing access does not disprove a command that may already have committed.
    if(!held.current[key]){setSendErrors(({[key]:_,...rest})=>rest);richDrafts.clear(key);}
    announceInboxChange();
    // A list read already out may still include the channel; replace it with one taken now.
    if(reread&&alive.current)void loadList(true);
  }
  /** A selected channel beyond the first page is checked on its own instead of being assumed gone. */
  async function probe(key:string){
    const since=epoch.current;
    try{await client.get<History>(path(key,'messages?limit=1&offset=0'));}catch(cause){if(alive.current&&revoked(cause))revoke(key,since);}
  }
  async function loadList(quiet=false){
    if(kind==='world'){setListStatus('ready');return;}
    const generation=++listGeneration.current;listInFlight.current=quiet;setListMore({loading:false,error:''});
    if(quiet)setListRefresh({loading:true,error:''});else{setListStatus('loading');setListError('');setListRefresh({loading:false,error:''});}
    try{
      const page=await client.get<ChannelPage>(`/me/channels?kind=${kind}&limit=${PAGE}&offset=0${roomQuery.trim()?`&search=${encodeURIComponent(roomQuery.trim())}`:''}`);
      if(generation!==listGeneration.current)return;
      listInFlight.current=null;setChannels(page.items);setListNext(page.next_offset);onUnread(page.unread_count);setListStatus('ready');setListRefresh({loading:false,error:''});
      const key=current.current;
      if(key&&!gone.current.has(key)&&!page.items.some(item=>item.channel_key===key)){
        if(page.next_offset===null&&!roomQuery.trim())revoke(key,epoch.current,false);else void probe(key);
      }
    }catch(cause){
      if(generation!==listGeneration.current)return;
      listInFlight.current=null;
      // A refused list means the open channel can no longer be shown either; no list re-read, so no loop.
      const key=current.current;if(key&&revoked(cause))revoke(key,epoch.current,false);
      // The list on screen is kept, but its total is no longer confirmed.
      if(quiet){setListRefresh({loading:false,error:fail(cause)});onUnread(null);}else{setListError(fail(cause));setListStatus('error');onUnread(null);}
    }
  }
  const handlers=useRef({loadList,loadThread,pullLatest});handlers.current={loadList,loadThread,pullLatest};
  useEffect(()=>{
    const update=()=>{void handlers.current.loadList(true);if(current.current)void handlers.current.loadThread(current.current,true);};
    window.addEventListener(INBOX_ALL_READ,update);
    return()=>window.removeEventListener(INBOX_ALL_READ,update);
  },[]);
  useEffect(()=>{
    void handlers.current.loadList();
    // Coming back to the window or a membership change re-checks the list (never a history nobody opened).
    const recheck=()=>{if(listState.current==='ready')void handlers.current.loadList(true);};
    window.addEventListener('focus',recheck);window.addEventListener('freedom-profile-updated',recheck);
    return()=>{window.removeEventListener('focus',recheck);window.removeEventListener('freedom-profile-updated',recheck);};
  },[]);
  useEffect(()=>{
    const term=roomQuery.trim();if(term===searched.current)return;
    const timer=window.setTimeout(()=>{searched.current=term;void handlers.current.loadList(true)},250);
    return()=>window.clearTimeout(timer);
  },[roomQuery]);
  useEffect(()=>{
    if(!active)return;
    if(kind==='world'&&(!mobile||compact)&&!current.current)select({kind,channel_key:'world',name:'世界聊天',unread_count:0,last_message_at:null});
    else if(openChannel&&openedRequest.current!==openChannel.request){openedRequest.current=openChannel.request;select({kind,channel_key:openChannel.key,name:channels.find(item=>item.channel_key===openChannel.key)?.name??text.unit,unread_count:0,last_message_at:null});}
  },[active,openChannel?.request,mobile,compact]);
  useEffect(()=>{
    if(!active||singlePane&&picking)return;
    const update=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void handlers.current.pullLatest();};
    const resume=()=>{retryAt.current=0;update();};
    update();const timer=window.setInterval(update,LIVE_POLL_MS);window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',update);
    return()=>{window.clearInterval(timer);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',update);};
  },[active,client,singlePane,picking,kind]);
  async function pullLatest(){
    const key=current.current,shown=snapshot.current;
    if(!key||!shown.active||shown.status!=='ready'||!shown.history||shown.more.loading||shown.reading||shown.sending||threadInFlight.current||polling.current||Date.now()<retryAt.current)return;
    polling.current=true;const generation=threadGeneration.current,since=epoch.current;
    try{
      // Idle checks never download history bodies or refresh every joined room.
      const activity=await client.get<Activity>(path(key,'activity'),{background:true});
      if(!alive.current||generation!==threadGeneration.current||since!==epoch.current||current.current!==key||!snapshot.current.active||snapshot.current.sending)return;
      if(compare(activity.latest_sequence,shown.history.items[0]?.sequence??'0')<=0&&activity.unread_count===shown.history.unread_count){failures.current=0;retryAt.current=0;setLiveError('');return;}
      const value=await client.get<History>(path(key,`messages?limit=50&after_sequence=${shown.history.items[0]?.sequence??'0'}`),{background:true});
      if(!alive.current||generation!==threadGeneration.current||since!==epoch.current||current.current!==key||!snapshot.current.active)return;
      failures.current=0;retryAt.current=0;setLiveError('');
      setCountUnconfirmed('');setNewerUnseen(Boolean(value.next_after_sequence));
      if(kind==='world')onUnread(value.unread_count);
      setHistory(existing=>{
        if(!existing)return existing;
        const fresh=value.items.filter(item=>!existing.items.some(known=>known.message_id===item.message_id));
        if(fresh.length&&!stick.current)setHasNew(true);
        return {...existing,unread_count:value.unread_count,items:newestFirst(merge(value.items,existing.items,item=>item.message_id)),next_offset:existing.next_offset===null?null:existing.next_offset+fresh.length};
      });
      if(value.items.some(item=>!shown.history!.items.some(known=>known.message_id===item.message_id))){void loadList(true);announceInboxChange();}
    }catch(cause){
      if(!alive.current||generation!==threadGeneration.current||since!==epoch.current||current.current!==key)return;
      if(revoked(cause)){revoke(key,since);return;}
      retryAt.current=Date.now()+Math.min(60000,2000*2**Math.min(++failures.current,5));setLiveError('新訊息更新暫停，會自動重試。草稿仍保留，也可手動重讀。');
    }finally{polling.current=false;}
  }
  async function moreChannels(){
    if(listNext===null||listMore.loading)return;
    const generation=listGeneration.current;setListMore({loading:true,error:''});
    try{
      const page=await client.get<ChannelPage>(`/me/channels?kind=${kind}&limit=${PAGE}&offset=${listNext}${roomQuery.trim()?`&search=${encodeURIComponent(roomQuery.trim())}`:''}`);
      if(generation!==listGeneration.current)return;
      setChannels(value=>merge(value,page.items.filter(item=>!gone.current.has(item.channel_key)),item=>item.channel_key));setListNext(page.next_offset);onUnread(page.unread_count);setListMore({loading:false,error:''});
    }catch(cause){if(generation===listGeneration.current)setListMore({loading:false,error:fail(cause)});}
  }

  async function loadThread(key:string,quiet=false){
    const generation=++threadGeneration.current,since=epoch.current;threadInFlight.current={key,quiet};
    setMore({loading:false,error:''});if(!quiet)setReadError(readIssues.current.get(key)??'');
    if(quiet)setRefresh({loading:true,error:''});else{setStatus('loading');setError('');setRefresh({loading:false,error:''});setHistory(null);setNewerUnseen(false);setCountUnconfirmed('');}
    try{
      const value=await client.get<History>(path(key,`messages?limit=${PAGE}&offset=0`));
      if(generation===threadGeneration.current)threadInFlight.current=null;
      // A slower answer for an earlier selection must never replace the open channel.
      if(generation!==threadGeneration.current||current.current!==key)return;
      gone.current.delete(key);
      setHistory(existing=>quiet&&existing?{...value,items:newestFirst(merge(value.items,existing.items,item=>item.message_id)),next_offset:existing.next_offset===null?value.next_offset:Math.max(existing.next_offset,value.next_offset??0)+value.items.filter(item=>!existing.items.some(known=>known.message_id===item.message_id)).length}:{...value,items:newestFirst(value.items)});setStatus('ready');setRefresh({loading:false,error:''});setNewerUnseen(false);setCountUnconfirmed('');setLiveError('');
      if(kind==='world')onUnread(value.unread_count);
      // A re-read can show newer unread messages; the tab and list totals come from the kind list, never from this channel.
      // loadList never re-reads a history, so this cannot loop. The settings total re-reads its own four sources.
      if(quiet){void loadList(listInFlight.current??listState.current==='ready');announceInboxChange();}
    }catch(cause){
      if(generation===threadGeneration.current)threadInFlight.current=null;
      if(generation!==threadGeneration.current||current.current!==key)return;
      if(revoked(cause)){revoke(key,since);return;}
      if(quiet)setRefresh({loading:false,error:fail(cause)});else{setError(fail(cause));setStatus('error');}
    }
  }
  function select(item:ChannelSummary){
    current.current=item.channel_key;epoch.current++;focusThread.current=true;
    stick.current=true;anchor.current=null;setHasNew(false);setLiveError('');retryAt.current=0;
    setSelected({key:item.channel_key,name:item.name});setPicking(false);void loadThread(item.channel_key);
    setReading(readLocks.current.has(item.channel_key));
  }
  useEffect(()=>{if(status==='ready'&&focusThread.current){focusThread.current=false;heading.current?.focus();}},[status]);
  // A read that was already out when a write was confirmed may answer with the state before it.
  function rereadAfterWrite(key:string){
    if(listInFlight.current!==null)void loadList(listInFlight.current);
    const open=threadInFlight.current;if(open&&open.key===key&&current.current===key)void loadThread(key,open.quiet);
  }

  async function earlier(){
    if(!history||history.next_offset===null||more.loading||!selected)return;
    const generation=threadGeneration.current,key=selected.key,since=epoch.current;setMore({loading:true,error:''});
    try{
      const value=await client.get<History>(path(key,`messages?limit=${PAGE}&offset=${history.next_offset}`));
      if(generation!==threadGeneration.current||current.current!==key)return;
      if(scroll.current)anchor.current={top:scroll.current.scrollTop,height:scroll.current.scrollHeight};
      setHistory(existing=>existing&&{...existing,items:newestFirst(merge(existing.items,value.items,item=>item.message_id)),next_offset:value.next_offset});setMore({loading:false,error:''});
    }catch(cause){
      if(generation!==threadGeneration.current)return;
      if(revoked(cause)){revoke(key,since);return;}
      setMore({loading:false,error:fail(cause)});
    }
  }

  async function markRead(throughId?:string,retry=false){
    if(!selected||!history||!history.items.length||readLocks.current.has(selected.key))return;
    if(!retry&&readAttempts.current.has(selected.key))return;
    // Only through the newest message this member has actually been shown.
    const key=selected.key,since=epoch.current,generation=threadGeneration.current;
    const attempt=readAttempts.current.get(key)??(throughId?{through:throughId,key:crypto.randomUUID()}:null);
    if(!attempt)return;
    const through=attempt.through;readAttempts.current.set(key,attempt);readLocks.current.add(key);
    readIssues.current.delete(key);setReading(true);setReadError('');setCountUnconfirmed('');
    try{
      await client.post<{read_sequence:string;read_at:string}>(path(key,'read'),{through_message_id:through},{idempotencyKey:attempt.key});
      readAttempts.current.delete(key);announceInboxChange();
      if(!alive.current)return;
      rereadAfterWrite(key);
      if(listInFlight.current===null)void loadList(true);
      // Newer messages may have arrived meanwhile; their unread count comes from the server, never assumed 0.
      if(!threadInFlight.current){
        try{
          const latest=await client.get<History>(path(key,'messages?limit=1&offset=0'));
          if(!alive.current||generation!==threadGeneration.current||current.current!==key)return;
          const shownNewest=history.items[0].sequence,newest=latest.items[0]?.sequence;
          setHistory(value=>value&&{...value,unread_count:latest.unread_count});
          setNewerUnseen(latest.unread_count>0&&newest!==undefined&&compare(newest,shownNewest)>0);
        }catch(cause){
          if(!alive.current||generation!==threadGeneration.current||current.current!==key)return;
          if(revoked(cause)){revoke(key,since);return;}
          // Not zero and not the old count: re-reading the messages confirms it without another read.
          setCountUnconfirmed(fail(cause));
        }
      }
    }catch(cause){
      if(!unconfirmed(cause))readAttempts.current.delete(key);
      if(!alive.current)return;
      if(revoked(cause)){revoke(key,since);return;}
      const issue=`標為已讀未完成：${fail(cause,'請重試。')}`;readIssues.current.set(key,issue);
      if(current.current===key)setReadError(issue);
    }finally{readLocks.current.delete(key);if(alive.current&&current.current===key)setReading(false);}
  }

  useVisibleChatRead({active:active&&(!singlePane||!picking),identity:selected?.key??null,through:history?.items[0]?.message_id,unread:history?.unread_count??0,
    blocked:status!=='ready'||reading||Boolean(readError)||Boolean(countUnconfirmed)||more.loading||searchOpen,scroll,onRead:through=>void markRead(through)});

  async function send(key:string,stickerId?:string){
    const previous=held.current[key],shown=snapshot.current;
    if(previous?.status==='sending'||sendLocks.current.has(key)||(stickerId!==undefined&&previous))return;
    if(!alive.current||current.current!==key||gone.current.has(key)||shown.status!=='ready'||shown.history?.channel.kind!==kind||shown.history.channel.channel_key!==key)return;
    if(stickerId!==undefined&&!findChatSticker(stickerId))return;
    const extras=richDrafts.get(key),same=previous?.status==='unknown';
    const payload=same?{...previous.payload}:stickerId!==undefined?{sticker_id:stickerId}:chatPayload(drafts[key]??'',extras),body=same?previous.body:payload.body??`[貼圖] ${findChatSticker(payload.sticker_id)?.label}`;
    if(!payload.body&&!payload.sticker_id){setSendErrors(value=>({...value,[key]:'請先輸入訊息內容，或選擇貼圖。'}));return;}
    if(payload.body&&[...payload.body].length>MAX_BODY){setSendErrors(value=>({...value,[key]:`訊息最多 ${MAX_BODY} 字。`}));return;}
    const attempt:Pending={key:same?previous.key:crypto.randomUUID(),body,payload,status:'sending'};
    const since=epoch.current,sessionGeneration=client.sessionGeneration,recipient=shown.history.channel.name;
    sendLocks.current.add(key);
    setPending(value=>({...value,[key]:attempt}));setSendErrors(({[key]:_,...rest})=>rest);
    try{
      const message=await client.post<unknown>(path(key,'messages'),payload,{idempotencyKey:attempt.key});
      if(!alive.current||client.sessionGeneration!==sessionGeneration)return;
      if(!matchesChannelMessageAck(message,{sender:me,kind,channelKey:key,payload}))throw new ApiError({message:'訊息回應未能核對，請以原內容重試確認。',network:true});
      setPending(({[key]:_,...rest})=>rest);
      if(gone.current.has(key))return;
      logConsoleEvent({channel:consoleChannel(kind==='guild'?'chat_sent_guild':kind==='world'?'chat_sent_world':'chat_sent_squad'),level:'success',kind:'status',source:text.unit,message:`已傳送訊息至「${recipient}」。`});
      if(!payload.sticker_id){
        setDrafts(value=>{if((value[key]??'').trim()!==body)return value;const {[key]:_,...rest}=value;return rest;});
        richDrafts.clear(key,extras);
      }
      if(current.current===key){stick.current=true;setHistory(value=>value&&value.channel.kind===kind&&value.channel.channel_key===key?{...value,items:newestFirst(merge([message],value.items,item=>item.message_id)),next_offset:value.next_offset===null?null:value.next_offset+(value.items.some(item=>item.message_id===message.message_id)?0:1)}:value);}
      setChannels(value=>value.map(item=>item.channel_key===key?{...item,last_message_at:message.created_at}:item));
      rereadAfterWrite(key);
    }catch(cause){
      if(!alive.current||client.sessionGeneration!==sessionGeneration)return;
      // The write can commit before its fresh membership read returns 403/404.
      // Retain even the first dispatched attempt before revoke hides its history.
      if(same||unconfirmed(cause)||revoked(cause)){
        setPending(value=>({...value,[key]:{...attempt,status:'unknown'}}));
        setSendErrors(value=>({...value,[key]:`傳送結果未確認：${fail(cause,'請重試。')} 以相同內容重試不會重複寄出。`}));
        if(revoked(cause))revoke(key,since);
      }else{
        setPending(({[key]:_,...rest})=>rest);
        if(revoked(cause)){revoke(key,since);return;}
        setSendErrors(value=>({...value,[key]:`訊息未送出：${fail(cause,'請修改後重試。')}`}));
      }
    }finally{sendLocks.current.delete(key);}
  }

  const key=selected?.key,draft=key?drafts[key]??'':'',attempt=key?pending[key]:undefined,sendError=key?sendErrors[key]:undefined;
  const richDraft=richDrafts.get(key??'');
  const ids={list:`${uid}-list`,title:`${uid}-title`,error:`${uid}-send-error`};
  function switchPane(){setPicking(value=>!value);requestAnimationFrame(()=>{if(picking)heading.current?.focus();else document.getElementById(ids.list)?.focus();});}
  function returnFromWorld(){setPicking(true);onReturnToChats?.();}
  const backLabel=kind==='world'?'← 返回對話列表':compact?`切換${text.unit}`:`← 返回${text.unit}列表`;
  return <div className={`messages-layout member-channels chat-workspace${compact?' is-compact':''}`} data-channel-kind={kind}>
    {singlePane&&selected&&kind!=='world'&&picking&&<button type="button" className="btn btn-ghost messages-switch" aria-expanded={picking} aria-controls={`${uid}-picker`} onClick={switchPane}>回到目前對話</button>}
    {kind==='world'&&mobile&&!compact&&<section hidden={Boolean(selected)&&!picking} className="messages-side stack" aria-labelledby={ids.list}><h2 id={ids.list} className="member-section-title">公開聊天室</h2><button type="button" className="messages-peer" aria-label="世界聊天" onClick={()=>select({kind,channel_key:'world',name:'世界聊天',unread_count:history?.unread_count??0,last_message_at:null})}><span className="chat-room-icon" aria-hidden="true">#</span><span className="chat-peer-copy"><strong>世界聊天</strong><span className="chat-peer-preview">所有會員可見</span></span></button></section>}
    {kind!=='world'&&<section id={`${uid}-picker`} hidden={singlePane&&Boolean(selected)&&!picking} className="messages-side stack" aria-labelledby={ids.list}>
      <h2 id={ids.list} tabIndex={-1} className="member-section-title">{text.unit}頻道</h2>
      {Object.keys(pending).length>0&&<div className="stack" aria-label="待確認的頻道訊息"><p className="messages-meta">待確認的傳送仍保留，可返回原頻道。</p>{Object.keys(pending).map((channelKey,index)=><button key={channelKey} className="btn btn-ghost" type="button" onClick={()=>select({kind,channel_key:channelKey,name:channels.find(item=>item.channel_key===channelKey)?.name??`${text.unit}頻道`,unread_count:0,last_message_at:null})}>回到待確認訊息（{index+1}）</button>)}</div>}
      <label className="field">搜尋{text.unit}頻道<input type="search" value={roomQuery} maxLength={100} onChange={event=>setRoomQuery(event.target.value)} placeholder="輸入頻道名稱"/></label>
      {listStatus==='loading'&&<p role="status">正在讀取{text.unit}頻道…</p>}
      {listStatus==='error'&&<div className="banner banner-error" role="alert">{text.unit}頻道讀取失敗：{listError}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadList()}>重新讀取{text.unit}頻道</button></div></div>}
      {listStatus==='ready'&&<div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={listRefresh.loading} onClick={()=>{if(!listRefresh.loading)void loadList(true);}}>{listRefresh.loading?`正在整理${text.unit}頻道…`:`重新整理${text.unit}頻道`}</button></div>}
      {listRefresh.error&&<p className="banner banner-error" role="alert">{text.unit}頻道重新整理失敗：{listRefresh.error}</p>}
      {listStatus==='ready'&&(channels.length===0&&listNext===null?<div className="stack"><p className="empty">{text.empty}</p><div className="messages-actions"><button className="btn btn-primary" type="button" onClick={()=>onNavigate(text.home)}>{text.homeLabel}</button></div></div>
        :<ul className="messages-list member-channel-list" aria-label={`${text.unit}頻道列表`}>
          {channels.filter(item=>item.name.toLocaleLowerCase().includes(roomQuery.trim().toLocaleLowerCase())).map(item=>{const meta=`${uid}-meta-${item.channel_key}`;return <li key={item.channel_key} className={item.unread_count?'is-unread':undefined}>
            <button type="button" className="messages-peer channel-button" data-channel-key={item.channel_key} aria-label={item.name} aria-describedby={meta}
              aria-current={key===item.channel_key?'true':undefined} onClick={()=>select(item)}>
              <span className="chat-room-icon" aria-hidden="true">{kind==='guild'?'#':'◎'}</span><span className="chat-peer-copy"><strong>{item.name}</strong><span className="messages-meta chat-peer-preview">{item.last_message_at?`最後訊息 ${formatIsoLocal(item.last_message_at)}`:'尚無訊息'}</span></span>
              {item.unread_count>0&&<span className="messages-count" aria-hidden="true">{item.unread_count} 則未讀</span>}
            </button>
            {/* The accessible name stays the channel name; time and unread count are its description. */}
            <span id={meta} hidden>{item.last_message_at?`最後訊息 ${formatIsoLocal(item.last_message_at)}`:'尚無訊息'}{item.unread_count>0?`，${item.unread_count} 則未讀`:'，沒有未讀'}</span>
          </li>;})}
        </ul>)}
      {listMore.error&&<p className="banner banner-error" role="alert">更多{text.unit}頻道讀取失敗：{listMore.error}</p>}
      {roomQuery.trim()&&listStatus==='ready'&&!listRefresh.loading&&!channels.some(item=>item.name.toLocaleLowerCase().includes(roomQuery.trim().toLocaleLowerCase()))&&<p className="empty">沒有符合的頻道，請換個關鍵字。</p>}
      {listStatus==='ready'&&listNext!==null&&<button className="btn btn-ghost" type="button" disabled={listMore.loading} onClick={()=>void moreChannels()}>{listMore.loading?'正在讀取…':listMore.error?`重試載入更多${text.unit}頻道`:`載入更多${text.unit}頻道`}</button>}
    </section>}
    <section hidden={singlePane&&(!selected||picking)} className="messages-thread" data-chat-open={Boolean(selected)&&status!=='gone'&&!picking&&!compact} aria-labelledby={ids.title} aria-busy={status==='loading'}>
      {!selected&&<><h2 id={ids.title}>{text.title}</h2><p className="muted">{text.pick}</p></>}
      {selected&&status==='gone'&&<>
        {singlePane&&(kind!=='world'||onReturnToChats)&&<button type="button" className="btn btn-ghost messages-switch" onClick={kind==='world'?returnFromWorld:switchPane}>{backLabel}</button>}
        <h2 id={ids.title}>{selected.name}</h2>
        {attempt&&<p className="messages-meta" role="status">先前的傳送結果仍未確認，原操作保留。恢復頻道存取後才能重試；重新檢查不會送出訊息。</p>}
        <button className="btn btn-ghost" type="button" onClick={()=>void loadThread(selected.key)}>重新檢查頻道存取</button>
        <div className="banner banner-error" role="alert">目前無法使用此頻道。<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>onNavigate(text.home)}>{text.back}</button></div></div>
      </>}
      {selected&&status!=='gone'&&<>
        <div className="chat-header">{singlePane&&(kind!=='world'||onReturnToChats)&&<button type="button" className="btn btn-ghost chat-back" aria-label={backLabel} title={backLabel} onClick={kind==='world'?returnFromWorld:switchPane}><span aria-hidden="true">‹</span></button>}<div><h2 id={ids.title} ref={heading} tabIndex={-1} aria-label={kind==='world'?'世界聊天':`${history?.channel.name??selected.name}・${text.title}`}>{kind==='world'?'世界聊天':<>{history?.channel.name??selected.name}<span className="chat-sr-only">・{text.title}</span></>}</h2>
        <span className="messages-meta">{kind==='world'?'所有會員可見':kind==='guild'?'公會成員':'群組成員'}{liveError?' · 更新暫停':''}</span></div>{status==='ready'&&history&&<ChatSearch key={`${kind}:${selected.key}`} client={client} resource={`/me/channels/${kind}/${encodeURIComponent(selected.key)}/messages`} title={history.channel.name} me={me} active={active&&(!singlePane||!picking)} onOpenChange={setSearchOpen}/>}</div>
        {liveError&&<p role="status" className="messages-meta">{liveError}</p>}
        {status==='loading'&&<p role="status">正在讀取訊息…</p>}
        {status==='error'&&<div className="banner banner-error" role="alert">訊息讀取失敗：{error}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadThread(selected.key)}>重新讀取訊息</button></div></div>}
        {status==='ready'&&history&&<>
          {/* Also the safe way to check an unconfirmed send: the pending key and draft stay as they are. */}
          <div className="messages-actions messages-refresh"><button className="btn btn-ghost" title="重新讀取訊息" aria-label="重新讀取訊息" type="button" aria-disabled={refresh.loading} onClick={()=>{if(!refresh.loading)void loadThread(selected.key,true);}}>{refresh.loading?'正在讀取訊息…':'重新讀取訊息'}</button></div>
          {refresh.error&&<p className="banner banner-error" role="alert">訊息重新讀取失敗：{refresh.error}</p>}
          <div className="messages-scroll" ref={scroll} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0} aria-label={`${history.channel.name}對話紀錄`} onScroll={()=>{if(scroll.current){stick.current=scroll.current.scrollHeight-scroll.current.scrollTop-scroll.current.clientHeight<80;if(stick.current)setHasNew(false);}}}>
          {history.next_offset!==null&&<button className="btn btn-ghost" type="button" disabled={more.loading} onClick={()=>void earlier()}>{more.loading?'正在讀取…':more.error?'重試載入較早訊息':'載入較早訊息'}</button>}
          {more.error&&<p className="banner banner-error" role="alert">較早訊息讀取失敗：{more.error}</p>}
          {history.items.length===0?<p className="empty">這個頻道還沒有訊息。</p>:<ol className="messages-bubbles" aria-label="頻道訊息">
            {[...history.items].reverse().map(message=>{const mine=message.sender_ref===me;return <li key={message.message_id} className={mine?'is-mine':undefined} data-message-id={message.message_id}>
              <p className="messages-meta">{mine?'你':message.sender_name} · <ChatTime value={message.created_at}/>{mine?' · 已送出':''}</p>
              {message.reply_to&&<ChatQuote reply={message.reply_to}/>}<ChatBody message={message}/>
              <div className="chat-message-actions"><button className="btn btn-ghost" type="button" aria-label={`回覆${mine?'你':message.sender_name}的訊息`} disabled={Boolean(attempt)} onClick={()=>{if(held.current[selected.key])return;richDrafts.change(selected.key,{reply:quoteMessage(message,mine?'你':message.sender_name)});document.getElementById(`${uid}-compose`)?.focus();}}>回覆</button></div>
            </li>;})}
          </ol>}
          {attempt&&<div className="messages-pending" role="status" aria-label="傳送狀態"><ChatBody message={{body:attempt.body,...(attempt.payload.sticker_id?{sticker:{id:findChatSticker(attempt.payload.sticker_id)!.id,label:findChatSticker(attempt.payload.sticker_id)!.label}}:{})}}/><p className="messages-meta">{attempt.status==='sending'?'傳送中…':'尚未確認送出，可用下方按鈕重試'}</p></div>}
          </div>
          {hasNew&&<button className="btn btn-ghost messages-new" type="button" onClick={()=>{stick.current=true;scroll.current?.scrollTo({top:scroll.current.scrollHeight});setHasNew(false);}}>有新訊息 · 回到最新</button>}
          {countUnconfirmed&&<div className="banner banner-error" role="alert">已標為已讀，但目前未讀數未確認：{countUnconfirmed}<div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={refresh.loading} onClick={()=>{if(!refresh.loading)void loadThread(selected.key,true);}}>重新讀取訊息</button></div></div>}
          {reading&&<p className="messages-meta" role="status">正在同步已讀…</p>}
          {!countUnconfirmed&&newerUnseen&&history.unread_count>0&&<p className="messages-meta" role="note">還有 {history.unread_count} 則較新的未讀訊息，顯示後會自動已讀。</p>}
          {readError&&<div className="banner banner-error" role="alert">{readError}<div className="messages-actions"><button className="btn btn-ghost" type="button" disabled={reading} onClick={()=>void markRead(history.items[0]?.message_id,true)}>重試標為已讀</button></div></div>}
          <form className="messages-compose" onSubmit={(event:FormEvent)=>{event.preventDefault();void send(selected.key);}}>
            <ChatExtras target={selected.key} draft={richDraft} disabled={Boolean(attempt)} onChange={value=>{if(!held.current[selected.key])richDrafts.change(selected.key,value);}} onSendSticker={id=>void send(selected.key,id)}/>
            <ChatInput id={`${uid}-compose`} label={kind==='world'?'世界聊天訊息':`在 ${history.channel.name} 發言`} value={draft} sending={Boolean(attempt)} hidden={Boolean(richDraft.sticker_id)} errorId={sendError?ids.error:undefined} mobile={mobile}
              onSend={()=>void send(selected.key)} onChange={value=>{if(!held.current[selected.key])setDrafts(drafts=>({...drafts,[selected.key]:value}));}}/>
            {attempt?.status==='unknown'&&<p className="messages-meta" role="note">{attempt.payload.sticker_id?'貼圖傳送結果尚未確認。重試只會確認原貼圖，其他草稿保留。':'原訊息已保留。請先重試確認結果，再修改內容或傳送貼圖。'}</p>}
            {sendError&&<p id={ids.error} className="banner banner-error" role="alert">{sendError}</p>}
            <div className="messages-actions">
              <button className="btn btn-primary" type="submit" disabled={attempt?.status==='sending'}>{attempt?.status==='sending'?'正在送出…':attempt?.status==='unknown'?'重試送出':kind==='world'?'傳送':'送出'}</button>
            </div>
          </form>
        </>}
      </>}
    </section>
  </div>;
}
