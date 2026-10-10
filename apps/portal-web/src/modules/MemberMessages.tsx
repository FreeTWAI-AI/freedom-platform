import {MemberBlockingAction} from './MemberBlocking';
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type FormEvent,type KeyboardEvent} from 'react';
import {ApiError,type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import type {SessionPayload,TabId} from '../types';
import {MemberAvatar} from './MemberAvatar';
import {MemberChannels} from './MemberChannels';
import {useChatLeaveGuards} from './chat-leave-guards';
import {announceInboxChange,INBOX_ALL_READ,NOTIFICATIONS_READ,type InboxUnread} from './member-inbox';
import {logConsoleEvent} from '../game-console-core';
import {consoleChannel} from '../game-console-routing';
import type {MemberCardData} from './Membership';
import {MemberPresence} from './MemberPresence';
import './MemberSettings.css';
import type {ChatEntry} from './chat-entry';
import type {MessageContent,MessageContentInput} from '../../../../modules/member-communications/content-types';
import {findChatSticker} from '../../../../modules/member-communications/stickers';
import {ChatBody,ChatQuote,ChatExtras,chatPayload,quoteMessage,useRichChatDraft} from './ChatContent';
import {ChatInput,ChatTime,useChatViewport,usePhoneChatBounds,useVisibleChatRead} from './ChatWorkspace';
import {ChatSearch} from './ChatSearch';
import {WorkshopIcon} from '../WorkshopIcon';
import {directMessageReceiptRefreshDue,hasDirectMessageChanges,mergeDirectMessagePage,readLoadedDirectMessageReceipts} from './direct-message-receipts';
import {isFirstImageDecoderRejection,matchesDirectMessageAck,messageImageFileError,messageImageUrl,uploadMessageImage,type MessageImage} from './message-image-client';
import {MessageImagePreview} from './MessageImagePreview';
import {chatPollDue,idleChatPoll,resetChatPoll} from './adaptive-chat-poll';

type ActionTab='members'|'squads'|'guilds'|'guild-workspace'|'messages'|'events';
type NotificationAction={tab:ActionTab;resource_id:string|null};
type Notice={notification_id:string;kind:string;title:string;body:string;created_at:string;read_at:string|null;action:NotificationAction|null};
type NoticePage={items:Notice[];unread_count:number;next_offset:number|null};
type Participant={user_id:string;display_name:string;avatar_url:string|null;last_seen_at:string|null;is_online:boolean};
type Message={message_id:string;sender_ref:string;recipient_ref:string;body:string;created_at:string;read_at:string|null;image?:MessageImage}&MessageContent;
const messageOrder=(a:Message,b:Message)=>a.created_at.localeCompare(b.created_at)||a.message_id.localeCompare(b.message_id);
const newestMessages=(items:Message[])=>[...items].sort((a,b)=>messageOrder(b,a));
type Conversation={participant:Participant;can_send:boolean;last_message:Message;unread_count:number};
type ConversationPage={items:Conversation[];unread_count:number;next_offset:number|null};
type Thread={participant:Participant;can_send:boolean;items:Message[];next_offset:number|null;unread_count:number};
type ConversationActivity={last_message_id:string|null;unread_count:number;can_send:boolean;last_outgoing?:{message_id:string;read_at:string|null}|null};
type MemberPage={items:MemberCardData[];total:number;next_offset:number|null};
type Props={client:PortalClient;session:SessionPayload;messageImagesEnabled?:boolean;memberBlockingEnabled?:boolean;onNavigate:(id:TabId)=>void;onNotificationPeer?:{id:string;sequence:number};registerLeave?:(guard:(()=>boolean)|null)=>void};

const PAGE=20,MAX_BODY=2000,LIVE_POLL_MS=1000;
// Actions map to fixed in-app pages only; a notification can never supply a link.
const actionLabels:Record<ActionTab,string>={members:'前往工坊夥伴',squads:'前往小隊集合',guilds:'前往職業公會','guild-workspace':'前往公會管理',messages:'開啟私訊',events:'前往活動'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(cause:unknown,fallback='暫時無法讀取，請稍後重試。')=>cause instanceof Error&&cause.message?cause.message:fallback;
/** No response, timeout or 5xx: the server may already have applied the write. */
const unconfirmed=(cause:unknown)=>!(cause instanceof ApiError)||cause.network||cause.status===0||cause.status>=500;
const merge=<T,>(current:T[],next:T[],id:(value:T)=>string)=>{const seen=new Set(current.map(id));return [...current,...next.filter(value=>!seen.has(id(value)))];};
const usableAction=(action:NotificationAction|null)=>!action||!Object.hasOwn(actionLabels,action.tab)||action.tab==='messages'&&!uuid.test(action.resource_id??'')?null:action;
const unreadText=(count:InboxUnread)=>count===undefined?'':count===null?'未讀數未確認':count>0?`${count} 則未讀`:'沒有未讀';

type View='guild'|'squad'|'direct'|'world';
const VIEWS:readonly (readonly [View,string,string,TabId])[]=[['direct','私人訊息','私訊','messages'],['guild','公會閒聊','公會','guilds'],['squad','小隊閒聊','群組','squads'],['world','世界聊天','公開','community']];

export function MemberMessages({client,session,messageImagesEnabled=false,memberBlockingEnabled=false,onNavigate,onNotificationPeer,chatEntry,active=true,registerLeave}:Props&{chatEntry?:ChatEntry|null;active?:boolean}){
  const leaveGuards=useChatLeaveGuards(registerLeave);
  const [view,setView]=useState<View>('direct');
  const [listRequest,setListRequest]=useState(0);
  const hub=useRef<HTMLElement>(null);usePhoneChatBounds(hub);
  const [guildUnread,setGuildUnread]=useState<InboxUnread>(),[squadUnread,setSquadUnread]=useState<InboxUnread>(),[directUnread,setDirectUnread]=useState<InboxUnread>(),[worldUnread,setWorldUnread]=useState<InboxUnread>();
  const unread:Record<View,InboxUnread>={guild:guildUnread,squad:squadUnread,direct:directUnread,world:worldUnread};
  useEffect(()=>{if(chatEntry)setView(chatEntry.kind)},[chatEntry?.request]);
  const [openPeer,setOpenPeer]=useState<{id:string;request:number}|null>(null);
  useEffect(()=>{if(onNotificationPeer&&uuid.test(onNotificationPeer.id)){setView('direct');setOpenPeer({id:onNotificationPeer.id,request:onNotificationPeer.sequence});}},[onNotificationPeer?.sequence]);
  const tabs=useRef<Record<string,HTMLButtonElement|null>>({});
  function tabKey(event:KeyboardEvent){
    const index=VIEWS.findIndex(([id])=>id===view),last=VIEWS.length-1;
    const next={ArrowRight:index===last?0:index+1,ArrowDown:index===last?0:index+1,ArrowLeft:index===0?last:index-1,ArrowUp:index===0?last:index-1,Home:0,End:last}[event.key];
    if(next===undefined)return;
    event.preventDefault();
    const id=VIEWS[next][0];setView(id);tabs.current[id]?.focus();
  }
  function returnToChats(){setView('direct');setListRequest(value=>value+1);}
  return <section ref={hub} className="member-messages messages-hub">
    <div className="messages-categories">
    <div className="messages-tabs" role="tablist" aria-label="訊息類型" onKeyDown={tabKey}>
      {VIEWS.map(([id,label,short,icon])=><button key={id} ref={node=>{tabs.current[id]=node;}} type="button" role="tab" id={`messages-tab-${id}`} aria-label={`${label}${unread[id]===undefined?'':`，${unreadText(unread[id])}`}`} data-guide-anchor={id==='direct'?'messages:direct':undefined} aria-controls={`messages-panel-${id}`}
        aria-selected={view===id} tabIndex={view===id?0:-1} className="btn btn-ghost" onClick={()=>setView(id)}><WorkshopIcon name={icon}/><span>{short}</span>{unread[id]!==undefined&&<><span className="chat-sr-only">{unreadText(unread[id])}</span>{unread[id]!==0&&<span className="messages-count chat-category-count" aria-hidden="true">{unread[id]===null?'?':unread[id]!>99?'99+':unread[id]}</span>}</>}</button>)}
    </div>
    <button type="button" className="btn btn-ghost messages-new-group" onClick={()=>onNavigate('squads')} title="前往小隊建立合作群組"><WorkshopIcon name="members"/><span>建立群組</span></button>
    </div>
    {/* Every panel stays mounted so unsent drafts survive switching tabs; chat history is read only after a channel is chosen. */}
    <div id="messages-panel-guild" role="tabpanel" aria-labelledby="messages-tab-guild" hidden={view!=='guild'}>
      <MemberChannels registerLeave={leaveGuards.guild} key={session.user.user_id} client={client} session={session} kind="guild" onUnread={setGuildUnread} onNavigate={onNavigate} active={active&&view==='guild'} openChannel={chatEntry?.kind==='guild'?chatEntry:null}/>
    </div>
    <div id="messages-panel-squad" role="tabpanel" aria-labelledby="messages-tab-squad" hidden={view!=='squad'}>
      <MemberChannels registerLeave={leaveGuards.squad} key={session.user.user_id} client={client} session={session} kind="squad" onUnread={setSquadUnread} onNavigate={onNavigate} active={active&&view==='squad'} openChannel={chatEntry?.kind==='squad'?chatEntry:null}/>
    </div>
    <div id="messages-panel-direct" role="tabpanel" aria-labelledby="messages-tab-direct" hidden={view!=='direct'}>
      <DirectMessages key={session.user.user_id} client={client} session={session} messageImagesEnabled={messageImagesEnabled} registerLeave={leaveGuards.direct} onUnread={setDirectUnread} openPeer={openPeer} active={active&&view==='direct'} listRequest={listRequest} memberBlockingEnabled={memberBlockingEnabled}/>
    </div>
    <div id="messages-panel-world" role="tabpanel" aria-labelledby="messages-tab-world" hidden={view!=='world'}><MemberChannels registerLeave={leaveGuards.world} key={session.user.user_id} client={client} session={session} kind="world" onUnread={setWorldUnread} onNavigate={onNavigate} active={active&&view==='world'} openChannel={chatEntry?.kind==='world'?chatEntry:null} onReturnToChats={returnToChats}/></div>
  </section>;
}

export function Notifications({client,onUnread,onNavigate,onOpenPeer}:{client:PortalClient;onUnread:(count:InboxUnread)=>void;onNavigate:(id:TabId)=>void;onOpenPeer:(id:string)=>void}){
  const [items,setItems]=useState<Notice[]>([]),[nextOffset,setNextOffset]=useState<number|null>(null);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading'),[error,setError]=useState('');
  const [more,setMore]=useState<{loading:boolean;error:string}>({loading:false,error:''});
  const [busy,setBusy]=useState<Record<string,boolean>>({}),[itemErrors,setItemErrors]=useState<Record<string,{message:string;navigate:boolean}>>({});
  // A manual refresh keeps the loaded list (and the focused button) on screen until the new page arrives.
  const [refresh,setRefresh]=useState({loading:false,error:''});
  // inFlight is the quietness of the full read that is still out, or null.
  const generation=useRef(0),inFlight=useRef<boolean|null>(null),keys=useRef(new Map<string,string>()),alive=useRef(true);
  // Late responses after leaving the page must not navigate or overwrite anything.
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  const load=useCallback(async(quiet=false)=>{
    const current=++generation.current;inFlight.current=quiet;setMore({loading:false,error:''});
    if(quiet)setRefresh({loading:true,error:''});else{setStatus('loading');setError('');setRefresh({loading:false,error:''});}
    try{
      const page=await client.get<NoticePage>(`/me/notifications?limit=${PAGE}&offset=0`);
      if(current!==generation.current)return;
      inFlight.current=null;setItems(page.items);setNextOffset(page.next_offset);onUnread(page.unread_count);setStatus('ready');setRefresh({loading:false,error:''});
    }catch(cause){
      if(current!==generation.current)return;
      inFlight.current=null;
      if(quiet){setRefresh({loading:false,error:fail(cause)});onUnread(null);}else{setError(fail(cause));setStatus('error');}
    }
  },[client,onUnread]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{const update=()=>void load(true);window.addEventListener(INBOX_ALL_READ,update);window.addEventListener(NOTIFICATIONS_READ,update);return()=>{window.removeEventListener(INBOX_ALL_READ,update);window.removeEventListener(NOTIFICATIONS_READ,update)}},[load]);
  async function loadMore(){
    if(nextOffset===null||more.loading)return;
    const current=generation.current;setMore({loading:true,error:''});
    try{
      const page=await client.get<NoticePage>(`/me/notifications?limit=${PAGE}&offset=${nextOffset}`);
      if(current!==generation.current)return;
      setItems(value=>merge(value,page.items,item=>item.notification_id));setNextOffset(page.next_offset);onUnread(page.unread_count);setMore({loading:false,error:''});
    }catch(cause){if(current===generation.current)setMore({loading:false,error:fail(cause)});}
  }
  async function refreshUnread(){
    // A failed refresh makes the total unknown instead of leaving a stale number on screen.
    try{const page=await client.get<NoticePage>('/me/notifications?limit=1&offset=0');if(alive.current)onUnread(page.unread_count);}catch{if(alive.current)onUnread(null);}
  }
  function go(action:NotificationAction){
    if(action.tab==='messages'){onOpenPeer(action.resource_id!);return;}
    onNavigate(action.tab);
  }
  async function markRead(item:Notice,then?:NotificationAction){
    const id=item.notification_id;if(busy[id])return;
    setBusy(value=>({...value,[id]:true}));setItemErrors(({[id]:_,...rest})=>rest);
    const key=keys.current.get(id)??crypto.randomUUID();keys.current.set(id,key);
    try{
      const result=await client.post<{notification_id:string;read_at:string}>(`/me/notifications/${encodeURIComponent(id)}/read`,{},{idempotencyKey:key});
      keys.current.delete(id);announceInboxChange();
      if(!alive.current)return;
      setItems(value=>value.map(entry=>entry.notification_id===id?{...entry,read_at:result.read_at}:entry));
      // A list read that was already out may answer with the old state; replace it with one taken now.
      if(inFlight.current!==null)void load(inFlight.current);
      void refreshUnread();
      if(then)go(then);
    }catch(cause){
      if(!unconfirmed(cause))keys.current.delete(id);
      if(!alive.current)return;
      setItemErrors(value=>({...value,[id]:{message:`標為已讀未完成：${fail(cause,'請重試。')}`,navigate:Boolean(then)}}));
    }finally{setBusy(({[id]:_,...rest})=>rest);}
  }
  if(status==='loading')return <p role="status">正在讀取通知…</p>;
  if(status==='error')return <div className="banner banner-error" role="alert">通知讀取失敗：{error}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void load()}>重新讀取通知</button></div></div>;
  return <div className="stack">
    <div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={refresh.loading} onClick={()=>{if(!refresh.loading)void load(true);}}>{refresh.loading?'正在整理通知…':'重新整理通知'}</button></div>
    {refresh.error&&<p className="banner banner-error" role="alert">通知重新整理失敗：{refresh.error}</p>}
    <h2 className="member-section-title">最新通知</h2>
    {items.length===0?<p className="empty">目前沒有通知。</p>:<ul className="messages-list" aria-label="通知">
      {items.map(item=>{
        const id=item.notification_id,action=usableAction(item.action),problem=itemErrors[id];
        return <li key={id} className={item.read_at?undefined:'is-unread'} data-notification={id}>
          <h3>{item.title}</h3>
          <p className="messages-body">{item.body}</p>
          <p className="messages-meta">{formatIsoLocal(item.created_at)} · {item.read_at?'已讀':'未讀'}</p>
          <div className="messages-actions">
            {action&&<button className="btn btn-primary" type="button" disabled={busy[id]} onClick={()=>item.read_at?go(action):void markRead(item,action)}>{actionLabels[action.tab]}</button>}
            {!item.read_at&&<button className="btn btn-ghost" type="button" disabled={busy[id]} onClick={()=>void markRead(item)}>{busy[id]?'正在標記…':'標為已讀'}</button>}
          </div>
          {problem&&<div className="banner banner-error" role="alert">{problem.message}<div className="messages-actions">
            <button className="btn btn-ghost" type="button" disabled={busy[id]} onClick={()=>void markRead(item,problem.navigate&&action?action:undefined)}>重試標為已讀</button>
            {problem.navigate&&action&&<button className="btn btn-ghost" type="button" onClick={()=>go(action)}>不標已讀，直接{actionLabels[action.tab]}</button>}
          </div></div>}
        </li>;
      })}
    </ul>}
    {more.error&&<div className="banner banner-error" role="alert">更多通知讀取失敗：{more.error}</div>}
    {nextOffset!==null&&<div className="messages-actions"><button className="btn btn-ghost" type="button" disabled={more.loading} onClick={()=>void loadMore()}>{more.loading?'正在讀取…':more.error?'重試載入更多通知':'載入更多通知'}</button></div>}
  </div>;
}

type ImageSelection={peer:string;user:string;file:File;key:string;imageId?:string};
type ImagePayload=MessageContentInput&{image_id?:string};
type Pending={key:string;body:string;payload:ImagePayload;status:'sending'|'unknown';stage?:'upload'|'message';selectionKey?:string};

function DirectMessageImage({peer,messageId}:{peer:string;messageId:string}){
  const [broken,setBroken]=useState(false);
  const url=messageImageUrl(peer,messageId);
  return broken?<p className="messages-meta" role="status">圖片無法載入</p>:<a className="message-image-link" href={url} target="_blank" rel="noopener"><img className="message-image" src={url} loading="lazy" decoding="async" alt="傳送的圖片" onError={()=>setBroken(true)}/></a>;
}

export function DirectMessages({client,session,messageImagesEnabled=false,memberBlockingEnabled=false,onUnread,openPeer,active=true,compact=false,listRequest=0,registerLeave}:{client:PortalClient;session:SessionPayload;messageImagesEnabled?:boolean;memberBlockingEnabled?:boolean;onUnread:(count:InboxUnread)=>void;openPeer:{id:string;request:number}|null;active?:boolean;compact?:boolean;listRequest?:number;registerLeave?:(guard:(()=>boolean)|null)=>void}){
  const me=session.user.user_id,uid=useId();
  const mobile=useChatViewport(),singlePane=compact||mobile;
  const richDrafts=useRichChatDraft();
  const ids={list:`${uid}-conversations`,thread:`${uid}-thread`,error:`${uid}-send-error`};
  const [conversations,setConversations]=useState<Conversation[]>([]),[convNext,setConvNext]=useState<number|null>(null);
  const [convStatus,setConvStatus]=useState<'loading'|'ready'|'error'>('loading'),[convError,setConvError]=useState(''),[convMore,setConvMore]=useState({loading:false,error:''});
  const [peer,setPeer]=useState<string|null>(null),[thread,setThread]=useState<Thread|null>(null);
  const [blockingPeers,setBlockingPeers]=useState<string[]>([]);
  useEffect(()=>{if(memberBlockingEnabled&&peer)setBlockingPeers(value=>value.includes(peer)?value:[...value,peer]);},[memberBlockingEnabled,peer]);
  const [picking,setPicking]=useState(true);
  useEffect(()=>{if(!listRequest)return;setPicking(true);const frame=requestAnimationFrame(()=>document.getElementById(ids.list)?.focus());return()=>cancelAnimationFrame(frame);},[listRequest]);
  const [threadStatus,setThreadStatus]=useState<'idle'|'loading'|'ready'|'error'>('idle'),[threadError,setThreadError]=useState(''),[threadMore,setThreadMore]=useState({loading:false,error:''});
  const [drafts,setDrafts]=useState<Record<string,string>>({}),[pending,setPendingState]=useState<Record<string,Pending>>({}),[sendErrors,setSendErrors]=useState<Record<string,string>>({});
  // Guards and retries must see the tuple in the same event that starts the write,
  // before React commits state or runs effects. State is only the rendered mirror.
  const held=useRef<Record<string,Pending>>({});
  function setPending(update:(value:Record<string,Pending>)=>Record<string,Pending>){
    held.current=update(held.current);setPendingState(held.current);
  }
  const [reading,setReading]=useState(false),[readError,setReadError]=useState('');
  const [searchOpen,setSearchOpen]=useState(false);
  const [selection,setSelection]=useState<ImageSelection|null>(null);
  const selectionRef=useRef<ImageSelection|null>(null),selections=useRef(new Map<string,ImageSelection>()),fileInput=useRef<HTMLInputElement>(null),sendLocks=useRef(new Set<string>());
  function clearImage(){
    const value=selectionRef.current;if(value&&held.current[value.peer])return;
    if(value)selections.current.delete(value.peer);
    selectionRef.current=null;setSelection(null);
  }
  // Conversation changes only select a preview. Original bytes and upload keys
  // stay in this session's memory until confirmation or an explicit draft removal.
  useLayoutEffect(()=>{const value=peer?selections.current.get(peer)??null:null;selectionRef.current=value;setSelection(value);},[peer]);
  useEffect(()=>()=>{selections.current.clear();selectionRef.current=null;held.current={};},[]);
  useEffect(()=>{
    const leave=(event:BeforeUnloadEvent)=>{if(Object.keys(held.current).length>0){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);
  },[]);
  function attachImage(files:File[]){
    if(!peer||messageImagesEnabled!==true||sendLocks.current.has(peer)||held.current[peer])return;
    const error=files.length!==1?'每則訊息只能附加一張圖片。':messageImageFileError(files[0]);
    if(error){setSendErrors(value=>({...value,[peer]:error}));return;}
    clearImage();
    const value={peer,user:me,file:files[0],key:crypto.randomUUID()};
    selections.current.set(peer,value);selectionRef.current=value;setSelection(value);richDrafts.change(peer,{sticker_id:undefined});
    setSendErrors(({[peer]:_,...rest})=>rest);
  }
  useLayoutEffect(()=>{
    registerLeave?.(()=>{
      if(Object.keys(held.current).length===0)return true;
      window.alert('訊息傳送結果尚未確認。請回到原對話，使用重試送出確認結果後再離開。');return false;
    });
    return()=>registerLeave?.(null);
  },[registerLeave]);
  // Manual refreshes keep the loaded list/thread (and the focused button) on screen until the new page arrives.
  const [convRefresh,setConvRefresh]=useState({loading:false,error:''}),[threadRefresh,setThreadRefresh]=useState({loading:false,error:''});
  // The in-flight refs record the full read that is still out, so a confirmed write can supersede it.
  const convInFlight=useRef<boolean|null>(null),threadInFlight=useRef<{id:string;quiet:boolean}|null>(null);
  const convGeneration=useRef(0),threadGeneration=useRef(0),currentPeer=useRef<string|null>(null),heading=useRef<HTMLHeadingElement>(null),focusThread=useRef(false),alive=useRef(true);
  const readAttempts=useRef(new Map<string,{through:string;key:string}>()),readLocks=useRef(new Set<string>()),readIssues=useRef(new Map<string,string>());
  const scroll=useRef<HTMLDivElement>(null),stick=useRef(true),anchor=useRef<{height:number;top:number}|null>(null),moreState=useRef(threadMore);
  const polling=useRef(false),retryAt=useRef(0),failures=useRef(0),listCheckedAt=useRef(0);
  const idlePoll=useRef(resetChatPoll());
  const receiptRefresh=useRef(new Map<string,symbol>());
  const receiptCheckedAt=useRef(new Map<string,number>());
  const [liveError,setLiveError]=useState('');
  const snapshot=useRef({thread,threadStatus,reading,active,sending:false,readingThread:true});snapshot.current={thread,threadStatus,reading,active,readingThread:!singlePane||!picking,sending:pending[peer??'']?.status==='sending'};
  const [hasNew,setHasNew]=useState(false);moreState.current=threadMore;
  useLayoutEffect(()=>{const node=scroll.current;if(!node)return;if(anchor.current){node.scrollTop=anchor.current.top+node.scrollHeight-anchor.current.height;anchor.current=null;}else if(stick.current){node.scrollTop=node.scrollHeight;setHasNew(false);}},[thread,peer,pending[peer??''],picking,singlePane]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;convGeneration.current++;threadGeneration.current++;};},[]);

  const loadConversations=useCallback(async(quiet=false)=>{
    listCheckedAt.current=Date.now();
    const current=++convGeneration.current;convInFlight.current=quiet;setConvMore({loading:false,error:''});
    if(quiet)setConvRefresh({loading:true,error:''});else{setConvStatus('loading');setConvError('');setConvRefresh({loading:false,error:''});}
    try{
      const page=await client.get<ConversationPage>(`/me/conversations?limit=${PAGE}&offset=0`);
      if(current!==convGeneration.current)return;
      convInFlight.current=null;setConversations(page.items);setConvNext(page.next_offset);onUnread(page.unread_count);setConvStatus('ready');setConvRefresh({loading:false,error:''});
    }catch(cause){
      if(current!==convGeneration.current)return;
      convInFlight.current=null;
      // The list on screen is kept, but its total is no longer confirmed.
      if(quiet){setConvRefresh({loading:false,error:fail(cause)});onUnread(null);}else{setConvError(fail(cause));setConvStatus('error');}
    }
  },[client,onUnread]);
  useEffect(()=>{void loadConversations();},[loadConversations]);
  useEffect(()=>{const update=()=>void loadConversations(true);window.addEventListener(INBOX_ALL_READ,update);return()=>window.removeEventListener(INBOX_ALL_READ,update)},[loadConversations]);
  async function moreConversations(){
    if(convNext===null||convMore.loading)return;
    const current=convGeneration.current;setConvMore({loading:true,error:''});
    try{
      const page=await client.get<ConversationPage>(`/me/conversations?limit=${PAGE}&offset=${convNext}`);
      if(current!==convGeneration.current)return;
      setConversations(value=>merge(value,page.items,item=>item.participant.user_id));setConvNext(page.next_offset);onUnread(page.unread_count);setConvMore({loading:false,error:''});
    }catch(cause){if(current===convGeneration.current)setConvMore({loading:false,error:fail(cause)});}
  }

  const loadThread=useCallback(async(id:string,quiet=false)=>{
    const current=++threadGeneration.current;threadInFlight.current={id,quiet};
    idlePoll.current=resetChatPoll();
    const receiptVersion=receiptRefresh.current.get(id);
    setThreadMore({loading:false,error:''});if(!quiet)setReadError(readIssues.current.get(id)??'');
    if(quiet)setThreadRefresh({loading:true,error:''});else{setThreadStatus('loading');setThreadError('');setThreadRefresh({loading:false,error:''});setThread(null);}
    try{
      const value=await client.get<Thread>(`/me/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}&offset=0`,{background:quiet});
      // A slower response for a previously selected member must never replace the open conversation.
      if(current!==threadGeneration.current||currentPeer.current!==id)return;
      const receipts=quiet?await readLoadedDirectMessageReceipts(value,snapshot.current.thread?.items??[],me,
        offset=>client.get<Thread>(`/me/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}&offset=${offset}`,{background:true}),
        ()=>alive.current&&current===threadGeneration.current&&currentPeer.current===id):undefined;
      if(current!==threadGeneration.current||currentPeer.current!==id||receipts===null)return;
      threadInFlight.current=null;
      if(receiptRefresh.current.get(id)===receiptVersion)receiptRefresh.current.delete(id);
      receiptCheckedAt.current.set(id,Date.now());
      setThread(existing=>{
        if(!quiet||!existing)return value;
        const fresh=value.items.filter(item=>!existing.items.some(known=>known.message_id===item.message_id));
        if(fresh.length&&!stick.current)setHasNew(true);
        // A recent page cannot tell how many messages arrived while this tab was hidden.
        // Restart older paging behind it when new ids appear, so a gap is never skipped.
        return {...value,items:mergeDirectMessagePage(value.items,existing.items,receipts),next_offset:fresh.length?value.next_offset:existing.next_offset};
      });setThreadStatus('ready');setThreadRefresh({loading:false,error:''});setLiveError('');return true;
    }catch(cause){
      if(current===threadGeneration.current)threadInFlight.current=null;
      if(current!==threadGeneration.current||currentPeer.current!==id)return;
      if(cause instanceof ApiError&&(cause.status===403||cause.status===404)){setThread(null);setThreadStatus('error');setThreadError(fail(cause));return;}
      if(quiet)setThreadRefresh({loading:false,error:fail(cause)});else{setThreadError(fail(cause));setThreadStatus('error');}
      return false;
    }
  },[client,me]);
  useEffect(()=>{
    const update=()=>{if(currentPeer.current)void loadThread(currentPeer.current,true);};
    window.addEventListener(INBOX_ALL_READ,update);
    return()=>window.removeEventListener(INBOX_ALL_READ,update);
  },[loadThread]);
  const live=useRef({pullLatest});live.current={pullLatest};
  async function pullLatest(){
    const shown=snapshot.current,id=currentPeer.current;
    if(!shown.active||document.visibilityState!=='visible'||!navigator.onLine||polling.current||Date.now()<retryAt.current)return;
    // Other conversations remain discoverable without reloading their previews every second.
    if(convInFlight.current===null&&Date.now()-listCheckedAt.current>=8000)void loadConversations(true);
    if(!shown.readingThread||!id||shown.threadStatus!=='ready'||!shown.thread||shown.reading||shown.sending||threadInFlight.current||moreState.current.loading)return;
    const refreshDue=receiptRefresh.current.has(id)||directMessageReceiptRefreshDue(shown.thread.items,me,receiptCheckedAt.current.get(id)??0,Date.now());
    if(!refreshDue&&!chatPollDue(idlePoll.current,Date.now(),retryAt.current))return;
    polling.current=true;const generation=threadGeneration.current,schedule=idlePoll.current,checkedAt=Date.now();
    try{
      const activity=await client.get<ConversationActivity>(`/me/conversations/${encodeURIComponent(id)}/activity`,{background:true});
      if(!alive.current||generation!==threadGeneration.current||currentPeer.current!==id||!snapshot.current.active||snapshot.current.sending)return;
      const receiptsDue=directMessageReceiptRefreshDue(shown.thread.items,me,receiptCheckedAt.current.get(id)??0,Date.now());
      if(!hasDirectMessageChanges(activity,shown.thread,receiptRefresh.current.has(id)||receiptsDue)){if(idlePoll.current===schedule)idlePoll.current=idleChatPoll(schedule,checkedAt);failures.current=0;retryAt.current=0;setLiveError('');return;}
      idlePoll.current=resetChatPoll();
      const nextGeneration=threadGeneration.current+1,refreshed=await loadThread(id,true);
      if(!alive.current||currentPeer.current!==id||threadGeneration.current!==nextGeneration)return;
      if(!refreshed){retryAt.current=Date.now()+Math.min(60000,2000*2**Math.min(++failures.current,5));setLiveError('新訊息更新暫停，會自動重試。草稿仍保留，也可手動重讀。');return;}
      failures.current=0;retryAt.current=0;setLiveError('');
      if(convInFlight.current===null)void loadConversations(true);
      announceInboxChange();
    }catch(cause){
      if(!alive.current||generation!==threadGeneration.current||currentPeer.current!==id)return;
      if(cause instanceof ApiError&&(cause.status===403||cause.status===404)){setThread(null);setThreadStatus('error');setThreadError(fail(cause));onUnread(null);return;}
      retryAt.current=Date.now()+Math.min(60000,2000*2**Math.min(++failures.current,5));setLiveError('新訊息更新暫停，會自動重試。草稿仍保留，也可手動重讀。');
    }finally{polling.current=false;}
  }
  useEffect(()=>{
    if(!active)return;
    const refresh=()=>void live.current.pullLatest();
    const resume=()=>{idlePoll.current=resetChatPoll();retryAt.current=0;refresh();};
    const visible=()=>{if(document.visibilityState==='visible'){idlePoll.current=resetChatPoll();refresh();}};
    idlePoll.current=resetChatPoll();refresh();const timer=window.setInterval(refresh,LIVE_POLL_MS);document.addEventListener('visibilitychange',visible);window.addEventListener('focus',resume);window.addEventListener('online',resume);
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',resume);window.removeEventListener('online',resume)};
  },[active,client,singlePane,picking]);
  const select=useCallback((id:string,moveFocus:boolean)=>{
    if(id===me)return;
    stick.current=true;anchor.current=null;setHasNew(false);setLiveError('');retryAt.current=0;
    currentPeer.current=id;focusThread.current=moveFocus;setPeer(id);setPicking(false);void loadThread(id);
    setReading(readLocks.current.has(id));
  },[loadThread,me]);
  useEffect(()=>{if(openPeer)select(openPeer.id,true);},[openPeer,select]);
  // A read that was already out when a write was confirmed may answer with the state before it.
  // Starting a new one supersedes it (and its busy flag), so the screen settles on a snapshot taken after the write.
  function rereadAfterWrite(id:string){
    if(convInFlight.current!==null)void loadConversations(convInFlight.current);
    const open=threadInFlight.current;if(open&&open.id===id&&currentPeer.current===id)void loadThread(id,open.quiet);
  }
  useEffect(()=>{if(threadStatus==='ready'&&focusThread.current){focusThread.current=false;heading.current?.focus();}},[threadStatus]);

  async function earlier(){
    if(!thread||thread.next_offset===null||threadMore.loading||!peer)return;
    const current=threadGeneration.current,id=peer;setThreadMore({loading:true,error:''});
    try{
      const value=await client.get<Thread>(`/me/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}&offset=${thread.next_offset}`);
      if(current!==threadGeneration.current||currentPeer.current!==id)return;
      // This page may predate a concurrent quiet refresh's snapshot. Ensure its
      // newly loaded outgoing rows are included in the next receipt read.
      if(value.items.some(item=>item.sender_ref===me&&item.read_at===null))receiptRefresh.current.set(id,Symbol());
      if(scroll.current)anchor.current={top:scroll.current.scrollTop,height:scroll.current.scrollHeight};
      setThread(existing=>existing&&{...existing,items:newestMessages(merge(existing.items,value.items,item=>item.message_id)),next_offset:value.next_offset});setThreadMore({loading:false,error:''});
    }catch(cause){if(current===threadGeneration.current)setThreadMore({loading:false,error:fail(cause)});}
  }

  async function markRead(through?:string,retry=false){
    if(!snapshot.current.active||!snapshot.current.readingThread||!peer||!thread||readLocks.current.has(peer))return;
    if(!retry&&readAttempts.current.has(peer))return;
    const id=peer,generation=threadGeneration.current,target=thread.items.find(item=>item.message_id===through);
    const attempt=readAttempts.current.get(id)??(target?{through:target.message_id,key:crypto.randomUUID()}:null);
    if(!attempt)return;
    readAttempts.current.set(id,attempt);readLocks.current.add(id);readIssues.current.delete(id);setReading(true);setReadError('');
    try{
      const boundary=thread.items.find(item=>item.message_id===attempt.through);
      const result=await client.post<{user_id:string;read_at:string;updated_count:number}>(`/me/conversations/${encodeURIComponent(id)}/read`,{through_message_id:attempt.through},{idempotencyKey:attempt.key});
      readAttempts.current.delete(id);announceInboxChange();
      if(!alive.current||!snapshot.current.active||!snapshot.current.readingThread||generation!==threadGeneration.current||currentPeer.current!==id)return;
      if(currentPeer.current===id&&boundary)setThread(value=>value&&value.participant.user_id===id?{...value,items:value.items.map(message=>message.sender_ref===id&&!message.read_at&&messageOrder(message,boundary)<=0?{...message,read_at:result.read_at}:message)}:value);
      // Replay counts describe the original command, not the current UI snapshot.
      // Re-read after ACK instead of subtracting that count from possibly newer mail.
      void loadConversations(true);
      if(currentPeer.current===id)await loadThread(id,true);
    }catch(cause){
      if(!unconfirmed(cause))readAttempts.current.delete(id);
      const issue=`標為已讀未完成：${fail(cause,'請重試。')}`;readIssues.current.set(id,issue);
      // A reopened copy of the same conversation still owns this keyed attempt.
      if(alive.current&&currentPeer.current===id)setReadError(issue);
    }finally{readLocks.current.delete(id);if(alive.current&&currentPeer.current===id)setReading(false);}
  }

  useVisibleChatRead({active:active&&(!singlePane||!picking),identity:peer,through:thread?.items[0]?.message_id,unread:thread?.unread_count??0,
    blocked:threadStatus!=='ready'||reading||Boolean(readError)||threadMore.loading||searchOpen,scroll,onRead:through=>void markRead(through)});

  async function send(id:string,stickerId?:string){
    idlePoll.current=resetChatPoll();
    const previous=held.current[id];
    if(previous?.status==='sending'||sendLocks.current.has(id)||(stickerId!==undefined&&previous))return;
    const shown=snapshot.current;
    if(!alive.current||currentPeer.current!==id||shown.threadStatus!=='ready'||shown.thread?.participant.user_id!==id||!shown.thread.can_send)return;
    if(stickerId!==undefined&&!findChatSticker(stickerId))return;
    const selected=selections.current.get(id);
    const image=stickerId===undefined&&!previous?.payload.sticker_id&&selected?.user===me&&(messageImagesEnabled===true||previous?.selectionKey===selected.key)?selected:null;
    const extras=richDrafts.get(id),payload:ImagePayload=previous?.status==='unknown'?{...previous.payload}:stickerId!==undefined?{sticker_id:stickerId}:chatPayload(drafts[id]??'',extras),body=previous?.status==='unknown'?previous.body:payload.body||(image?'[圖片]':`[貼圖] ${findChatSticker(payload.sticker_id)?.label}`);
    if(image&&payload.sticker_id){setSendErrors(value=>({...value,[id]:'圖片與貼圖不能同時傳送，請移除其中一項。'}));return;}
    if(!payload.body&&!payload.sticker_id&&!image){setSendErrors(value=>({...value,[id]:'請先輸入訊息內容，或選擇貼圖。'}));return;}
    if(payload.body&&[...payload.body].length>MAX_BODY){setSendErrors(value=>({...value,[id]:`訊息最多 ${MAX_BODY} 字。`}));return;}
    if(image&&!payload.body)delete payload.body;
    if(image?.imageId)payload.image_id=image.imageId;
    const same=previous?.status==='unknown';
    const attempt:Pending={key:same?previous.key:crypto.randomUUID(),body,payload,status:'sending',stage:image?image.imageId?'message':'upload':undefined,selectionKey:image?.key};
    const sessionGeneration=client.sessionGeneration;
    sendLocks.current.add(id);
    setPending(value=>({...value,[id]:attempt}));setSendErrors(({[id]:_,...rest})=>rest);
    try{
      if(image&&!image.imageId){
        const uploaded=await uploadMessageImage(client,id,image.file,image.key);
        if(!alive.current||client.sessionGeneration!==sessionGeneration||selections.current.get(id)!==image){setPending(({[id]:_,...rest})=>rest);return;}
        image.imageId=uploaded.image_id;if(currentPeer.current===id)setSelection({...image});payload.image_id=uploaded.image_id;
        attempt.stage='message';setPending(value=>({...value,[id]:{...attempt}}));
      }
      const message=await client.post<unknown>(`/me/conversations/${encodeURIComponent(id)}/messages`,payload,{idempotencyKey:attempt.key});
      if(!alive.current||client.sessionGeneration!==sessionGeneration)return;
      if(!matchesDirectMessageAck(message,{sender:me,recipient:id,payload}))throw new ApiError({message:'訊息回應未能核對，請以原內容重試確認。',network:true});
      // A new outgoing sentinel can hide a receipt change for the previous one.
      // Keep this dirty until a successful read taken after this send completes.
      receiptRefresh.current.set(id,Symbol());
      const recipient=conversations.find(item=>item.participant.user_id===id)?.participant.display_name??(thread?.participant.user_id===id?thread.participant.display_name:'工坊夥伴');
      logConsoleEvent({channel:consoleChannel('chat_sent_direct'),level:'success',kind:'status',source:'私訊',message:`已傳送私人訊息給 ${recipient}。`});
      setPending(({[id]:_,...rest})=>rest);
      if(!payload.sticker_id)setDrafts(value=>{if((value[id]??'').trim()!==(payload.body??''))return value;const {[id]:_,...rest}=value;return rest;});
      if(image){selections.current.delete(id);if(selectionRef.current===image){selectionRef.current=null;setSelection(null);}}
      if(!payload.sticker_id)richDrafts.clear(id,extras);
      if(currentPeer.current===id){stick.current=true;setThread(value=>value&&value.participant.user_id===id?{...value,items:newestMessages(merge([message],value.items,item=>item.message_id)),next_offset:value.next_offset===null?null:value.next_offset+(value.items.some(item=>item.message_id===message.message_id)?0:1)}:value);}
      setConversations(value=>{
        const existing=value.find(item=>item.participant.user_id===id);
        const participant=existing?.participant??(thread?.participant.user_id===id?thread.participant:null);
        if(!participant)return value;
        return [{participant,can_send:existing?.can_send??true,unread_count:existing?.unread_count??0,last_message:message},...value.filter(item=>item.participant.user_id!==id)];
      });
      rereadAfterWrite(id);
    }catch(cause){
      if(!alive.current||client.sessionGeneration!==sessionGeneration)return;
      if(image&&selections.current.get(id)!==image){setPending(({[id]:_,...rest})=>rest);return;}
      // A later definite rejection cannot disprove an earlier unknown commit.
      // The first upload decoder rejection also precedes any prepared image.
      const rejectedImage=image&&isFirstImageDecoderRejection(cause,attempt.stage,same);
      // A fresh post-commit member check may refuse onboarding without revoking the session.
      const uncertainMember=cause instanceof ApiError&&cause.status===403&&cause.code==='onboarding_required';
      if((image&&!rejectedImage)||same||unconfirmed(cause)||uncertainMember){
        setPending(value=>({...value,[id]:{...attempt,status:'unknown'}}));
        setSendErrors(value=>({...value,[id]:attempt.stage==='upload'?`圖片上傳未完成：${fail(cause,'請重試。')} 圖片與文字已保留，可重試送出。`:`${same||unconfirmed(cause)||uncertainMember?'傳送結果未確認':'訊息未送出'}：${fail(cause,'請重試。')} 以相同內容重試不會重複寄出。`}));
      }else{
        setPending(({[id]:_,...rest})=>rest);
        setSendErrors(value=>({...value,[id]:`訊息未送出：${fail(cause,'請修改後重試。')}`}));
      }
    }finally{sendLocks.current.delete(id);}
  }

  const participant=thread?.participant??conversations.find(item=>item.participant.user_id===peer)?.participant,draft=peer?drafts[peer]??'':'',attempt=peer?pending[peer]:undefined,sendError=peer?sendErrors[peer]:undefined;
  const richDraft=richDrafts.get(peer??'');
  function switchPane(){setPicking(value=>!value);requestAnimationFrame(()=>{if(picking)heading.current?.focus();else document.getElementById(ids.list)?.focus();});}
  return <div className={`messages-layout chat-workspace${compact?' is-compact':''}`}>
    {singlePane&&peer&&picking&&<button type="button" className="btn btn-ghost messages-switch" aria-expanded={picking} aria-controls={`${uid}-picker`} onClick={switchPane}>回到目前對話</button>}
    <div id={`${uid}-picker`} hidden={singlePane&&Boolean(peer)&&!picking} className="messages-side">
      <MemberPicker client={client} me={me} onSelect={id=>select(id,true)}/>
      <section className="stack" aria-labelledby={ids.list}>
        <h2 id={ids.list} tabIndex={-1} className="member-section-title">對話</h2>
        {convStatus==='loading'&&<p role="status">正在讀取對話…</p>}
        {convStatus==='error'&&<div className="banner banner-error" role="alert">對話讀取失敗：{convError}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadConversations()}>重新讀取對話</button></div></div>}
        {convStatus==='ready'&&<div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={convRefresh.loading} onClick={()=>{if(!convRefresh.loading)void loadConversations(true);}}>{convRefresh.loading?'正在整理對話…':'重新整理對話'}</button></div>}
        {convRefresh.error&&<p className="banner banner-error" role="alert">對話重新整理失敗：{convRefresh.error}</p>}
        {convStatus==='ready'&&(conversations.length===0?<p className="empty">還沒有私訊。可搜尋會員開始對話。</p>:<ul className="messages-list" aria-label="對話列表">
          {conversations.map(item=><li key={item.participant.user_id} className={item.unread_count?'is-unread':undefined}>
            <button type="button" className="messages-peer" aria-current={peer===item.participant.user_id?'true':undefined} onClick={()=>select(item.participant.user_id,true)}>
              <MemberAvatar nickname={item.participant.display_name} avatarUrl={item.participant.avatar_url}/>
              <span className="chat-peer-copy"><strong>{item.participant.display_name}</strong><MemberPresence online={item.participant.is_online} lastSeen={item.participant.last_seen_at}/><span className="chat-peer-preview">{item.last_message.sender_ref===me?'你：':''}{messageImagesEnabled===true&&item.last_message.image&&item.last_message.body==='[圖片]'?'圖片':item.last_message.body.slice(0,40)}</span></span>
              <span className="chat-peer-tail"><ChatTime value={item.last_message.created_at}/>{item.unread_count>0&&<span className="messages-count">{item.unread_count} 則未讀</span>}</span>
            </button>
          </li>)}
        </ul>)}
        {convMore.error&&<p className="banner banner-error" role="alert">更多對話讀取失敗：{convMore.error}</p>}
        {convStatus==='ready'&&convNext!==null&&<button className="btn btn-ghost" type="button" disabled={convMore.loading} onClick={()=>void moreConversations()}>{convMore.loading?'正在讀取…':convMore.error?'重試載入更多對話':'載入更多對話'}</button>}
      </section>
    </div>
    <section hidden={singlePane&&(!peer||picking)} className="messages-thread" data-chat-open={Boolean(peer)&&!picking&&!compact} aria-labelledby={ids.thread} aria-busy={threadStatus==='loading'}>
      {!peer&&<><h2 id={ids.thread}>私人訊息</h2><p className="muted">從對話列表或會員搜尋選擇對象。</p></>}
      {peer&&<>
        <div className="chat-header">{singlePane&&<button type="button" className="btn btn-ghost chat-back" aria-label={compact?'切換對象':'← 返回對話列表'} title="返回對話列表" aria-controls={`${uid}-picker`} onClick={switchPane}><span aria-hidden="true">‹</span></button>}{participant&&<MemberAvatar nickname={participant.display_name} avatarUrl={participant.avatar_url}/>}<div>
          <h2 id={ids.thread} ref={heading} tabIndex={-1}>{participant?<><span className="chat-sr-only">與 </span>{participant.display_name}<span className="chat-sr-only"> 的對話</span></>:'讀取對話中'}</h2>
          {participant&&<MemberPresence online={participant.is_online} lastSeen={participant.last_seen_at}/>}
        </div>{threadStatus==='ready'&&participant&&<ChatSearch key={peer} client={client} resource={`/me/conversations/${encodeURIComponent(peer)}/messages`} title={participant.display_name} me={session.user.user_id} active={active&&(!singlePane||!picking)} messageImagesEnabled={messageImagesEnabled===true} onOpenChange={setSearchOpen}/>}</div>
        {memberBlockingEnabled&&blockingPeers.map(id=><div key={`${me}:${id}`} hidden={peer!==id}><MemberBlockingAction client={client} userId={id} nickname={id===peer?(participant?.display_name??'這位會員'):(conversations.find(item=>item.participant.user_id===id)?.participant.display_name??'這位會員')} onChanged={async()=>{await Promise.all([loadConversations(true),alive.current&&currentPeer.current===id?loadThread(id,true):Promise.resolve()]);}}/></div>)}
        {liveError&&<p className="messages-meta" role="status">{liveError}</p>}
        {threadStatus==='loading'&&<p role="status">正在讀取訊息…</p>}
        {threadStatus==='error'&&<div className="banner banner-error" role="alert">訊息讀取失敗：{threadError}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadThread(peer)}>重新讀取訊息</button></div></div>}
        {threadStatus==='ready'&&thread&&<>
          {/* Also the safe way to check an unconfirmed send: the pending key and draft stay as they are. */}
          <div className="messages-actions messages-refresh"><button className="btn btn-ghost" title="重新讀取訊息" aria-label="重新讀取訊息" type="button" aria-disabled={threadRefresh.loading} onClick={()=>{if(!threadRefresh.loading)void loadThread(peer,true);}}>{threadRefresh.loading?'正在讀取訊息…':'重新讀取訊息'}</button></div>
          {threadRefresh.error&&<p className="banner banner-error" role="alert">訊息重新讀取失敗：{threadRefresh.error}</p>}
          <div ref={scroll} className="messages-scroll" role="log" aria-live="polite" aria-relevant="additions" tabIndex={0} aria-label={`與${thread.participant.display_name}的對話紀錄`} onScroll={()=>{if(scroll.current){stick.current=scroll.current.scrollHeight-scroll.current.scrollTop-scroll.current.clientHeight<80;if(stick.current)setHasNew(false);}}}>
          {thread.next_offset!==null&&<button className="btn btn-ghost" type="button" disabled={threadMore.loading} onClick={()=>void earlier()}>{threadMore.loading?'正在讀取…':threadMore.error?'重試載入較早訊息':'載入較早訊息'}</button>}
          {threadMore.error&&<p className="banner banner-error" role="alert">較早訊息讀取失敗：{threadMore.error}</p>}
          {thread.items.length===0?<p className="empty">還沒有訊息。</p>:<ol className="messages-bubbles" aria-label="訊息">
            {[...thread.items].reverse().map(message=>{const mine=message.sender_ref!==thread.participant.user_id;return <li key={message.message_id} className={mine?'is-mine':undefined} data-message-id={message.message_id}>
              <p className="messages-meta">{mine?'你':thread.participant.display_name} · <ChatTime value={message.created_at}/>{mine?message.read_at?' · 對方已讀':' · 已送出':!message.read_at?' · 未讀':''}</p>
              {message.reply_to&&<ChatQuote reply={message.reply_to}/>}
              {messageImagesEnabled===true&&message.image&&<DirectMessageImage peer={peer} messageId={message.message_id}/>}
              {!(messageImagesEnabled===true&&message.image&&message.body==='[圖片]')&&<ChatBody message={message}/>}
              {thread.can_send&&<div className="chat-message-actions"><button className="btn btn-ghost" type="button" aria-label={`回覆${mine?'你':thread.participant.display_name}的訊息`} disabled={Boolean(attempt)} onClick={()=>{if(held.current[peer])return;richDrafts.change(peer,{reply:quoteMessage(message,mine?'你':thread.participant.display_name)});document.getElementById(`${uid}-compose`)?.focus();}}>回覆</button></div>}
            </li>;})}
          </ol>}
          {attempt&&<div className="messages-pending" role="status" aria-label="傳送狀態"><ChatBody message={{body:attempt.body,...(attempt.payload.sticker_id?{sticker:{id:findChatSticker(attempt.payload.sticker_id)!.id,label:findChatSticker(attempt.payload.sticker_id)!.label}}:{})}}/><p className="messages-meta">{attempt.status==='sending'?attempt.stage==='upload'?'上傳圖片中…':attempt.stage==='message'?'傳送訊息中…':'傳送中…':'尚未確認送出，可用下方按鈕重試'}</p></div>}
          </div>
          {hasNew&&<button className="btn btn-ghost messages-new" type="button" onClick={()=>{stick.current=true;scroll.current?.scrollTo({top:scroll.current.scrollHeight});setHasNew(false);}}>有新訊息 · 回到最新</button>}
          {reading&&<p className="messages-meta" role="status">正在同步已讀…</p>}
          {readError&&<div className="banner banner-error" role="alert">{readError}<div className="messages-actions"><button className="btn btn-ghost" type="button" disabled={reading} onClick={()=>void markRead(thread.items[0]?.message_id,true)}>重試標為已讀</button></div></div>}
          {thread.can_send?<form className={`messages-compose${messageImagesEnabled===true?' has-image-controls':''}`} onSubmit={(event:FormEvent)=>{event.preventDefault();void send(peer);}} onPaste={event=>{
            if(messageImagesEnabled!==true||!(event.target instanceof HTMLTextAreaElement))return;
            const files=Array.from(event.clipboardData.files);
            if(!files.length)for(const item of Array.from(event.clipboardData.items)){if(item.kind==='file'){const file=item.getAsFile();if(file)files.push(file);}}
            if(files.length){event.preventDefault();attachImage(files);}
          }}>
            <ChatExtras key={selection?.key??peer} target={peer} draft={richDraft} disabled={Boolean(attempt)} onChange={value=>{if(held.current[peer])return;richDrafts.change(peer,value);}} onSendSticker={id=>void send(peer,id)}/>
            {messageImagesEnabled===true&&<div className="message-image-controls">
              <input ref={fileInput} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';if(files.length)attachImage(files);}}/>
              <button className="btn btn-ghost" type="button" disabled={Boolean(attempt)} onClick={()=>fileInput.current?.click()}>附加圖片</button>
              <span className="messages-meta">{selection?'每則限一張圖片；點選貼圖會保留這張圖片草稿。':'JPEG、PNG、WebP · 最多 2 MiB'}</span>
            </div>}
            {messageImagesEnabled===true&&selection?.peer===peer&&selection.user===me&&<div className="message-image-preview" aria-label="待送出的圖片">
              <MessageImagePreview key={selection.key} file={selection.file}/><span>{selection.file.name||'剪貼簿圖片'}<small>{(selection.file.size/1024).toFixed(1)} KiB</small></span>
              <button className="btn btn-ghost" type="button" disabled={Boolean(attempt)} onClick={clearImage}>移除</button>
            </div>}
            <ChatInput id={`${uid}-compose`} label={`寫給 ${thread.participant.display_name} 的訊息`} value={draft} sending={Boolean(attempt)} hidden={Boolean(richDraft.sticker_id)} errorId={sendError?ids.error:undefined} mobile={mobile}
              onSend={()=>void send(peer)} onChange={text=>{idlePoll.current=resetChatPoll();if(!held.current[peer])setDrafts(value=>({...value,[peer]:text}));}}/>
            {attempt?.status==='unknown'&&<p className="messages-meta" role="note">{attempt.payload.sticker_id?'貼圖傳送結果尚未確認。重試只會確認原貼圖，其他草稿保留。':'原訊息與圖片已保留。請先重試確認結果，再修改內容或附件。'}</p>}
            {sendError&&<p id={ids.error} className="banner banner-error" role="alert">{sendError}</p>}
            <div className="messages-actions">
              <button className="btn btn-primary" type="submit" disabled={attempt?.status==='sending'}>{attempt?.status==='sending'?attempt.stage==='upload'?'上傳圖片中…':attempt.stage==='message'?'傳送訊息中…':'正在送出…':attempt?.status==='unknown'?'重試送出':'送出'}</button>
            </div>
          </form>:<p className="muted" role="note">{memberBlockingEnabled?'目前無法傳送私訊，仍可查看過去的訊息。草稿保留，不會自動送出。':'對方目前無法接收私訊，仍可查看過去的訊息。'}</p>}
        </>}
      </>}
    </section>
  </div>;
}

function MemberPicker({client,me,onSelect}:{client:PortalClient;me:string;onSelect:(id:string)=>void}){
  const uid=useId();
  const [query,setQuery]=useState(''),[searched,setSearched]=useState<string|null>(null);
  const [results,setResults]=useState<MemberCardData[]>([]),[next,setNext]=useState<number|null>(null);
  const [status,setStatus]=useState<'idle'|'loading'|'ready'|'error'>('idle'),[error,setError]=useState(''),[more,setMore]=useState({loading:false,error:''});
  const generation=useRef(0);
  const url=(search:string,offset:number)=>`/members?${new URLSearchParams({search,limit:String(PAGE),offset:String(offset)})}`;
  async function search(event?:FormEvent){
    event?.preventDefault();
    const text=query.trim();if(!text)return;
    const current=++generation.current;setSearched(text);setStatus('loading');setError('');setMore({loading:false,error:''});
    try{
      const page=await client.get<MemberPage>(url(text,0));
      if(current!==generation.current)return;
      setResults(page.items);setNext(page.next_offset);setStatus('ready');
    }catch(cause){if(current===generation.current){setError(fail(cause));setStatus('error');}}
  }
  async function loadMore(){
    if(next===null||searched===null||more.loading)return;
    const current=generation.current;setMore({loading:true,error:''});
    try{
      const page=await client.get<MemberPage>(url(searched,next));
      if(current!==generation.current)return;
      setResults(value=>merge(value,page.items,item=>item.user_id));setNext(page.next_offset);setMore({loading:false,error:''});
    }catch(cause){if(current===generation.current)setMore({loading:false,error:fail(cause)});}
  }
  const visible=results.filter(item=>item.user_id!==me&&!item.is_self);
  return <section className="stack messages-search" aria-labelledby={`${uid}-picker`}>
    <h2 id={`${uid}-picker`} className="member-section-title">新對話</h2>
    <form className="stack" role="search" onSubmit={event=>void search(event)}>
      <label className="field"><span>搜尋會員</span><input type="search" value={query} maxLength={100} onChange={event=>setQuery(event.target.value)}/></label>
      <button className="btn btn-ghost" type="submit" disabled={!query.trim()||status==='loading'}>{status==='loading'?'搜尋中…':'搜尋會員'}</button>
    </form>
    {status==='error'&&<div className="banner banner-error" role="alert">會員搜尋失敗：{error}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void search()}>重試搜尋</button></div></div>}
    {status==='ready'&&(visible.length===0&&next===null?<p className="empty">找不到符合「{searched}」的會員。</p>:<ul className="messages-list" aria-label="會員搜尋結果">
      {visible.map(item=><li key={item.user_id}><button type="button" className="messages-peer" onClick={()=>onSelect(item.user_id)}>
        <MemberAvatar nickname={item.nickname} avatarUrl={item.avatar_url}/><span>傳訊給 <strong>{item.nickname}</strong></span></button></li>)}
    </ul>)}
    {more.error&&<p className="banner banner-error" role="alert">更多會員讀取失敗：{more.error}</p>}
    {status==='ready'&&next!==null&&<button className="btn btn-ghost" type="button" disabled={more.loading} onClick={()=>void loadMore()}>{more.loading?'正在讀取…':more.error?'重試載入更多會員':'載入更多會員'}</button>}
  </section>;
}
