import {lazy,useCallback,useEffect,useState} from 'react';
import {PageLoadBoundary} from './LazyPage';
import type {PortalClient} from './api';
import type {SessionPayload,TabId} from './types';
import type {GameConsoleChannel} from './game-console-core';
const MemberChannels=lazy(()=>import('./modules/MemberChannels').then(m=>({default:m.MemberChannels})));
const DirectMessages=lazy(()=>import('./modules/MemberMessages').then(m=>({default:m.DirectMessages})));
import type {InboxUnread} from './modules/member-inbox';
import type {SiteConfig} from './modules/Community';

type Chat='guild'|'squad'|'direct'|'world_chat';
const isChat=(value:GameConsoleChannel):value is Chat=>['guild','squad','direct','world_chat'].includes(value);
/** The dock and the message page use identical room controls, draft safety and access checks. */
export function GameConsoleComposer({client,session,enabled,channel,active,onUnread,onNavigate,memberBlockingEnabled=false}:{
  client?:PortalClient;session?:SessionPayload;enabled:boolean;channel:GameConsoleChannel;active:boolean;memberBlockingEnabled?:boolean;
  onUnread:(channel:Chat,count:InboxUnread)=>void;onNavigate:(id:TabId)=>void;
}){
  const [visited,setVisited]=useState<Chat[]>([]);
  const [imageSite,setImageSite]=useState<{client:PortalClient;enabled:boolean}|null>(null);
  // The console can also run in a popout without App's site configuration.
  useEffect(()=>{
    if(!client||!session)return;
    let alive=true;
    void client.get<SiteConfig>('/site',{coalesce:true}).then(site=>{if(alive)setImageSite({client,enabled:site.message_images_enabled===true});}).catch(()=>{if(alive)setImageSite(null);});
    return()=>{alive=false;};
  },[client,session?.user.user_id]);
  useEffect(()=>{if(active&&isChat(channel))setVisited(value=>value.includes(channel)?value:[...value,channel])},[active,channel]);
  const guild=useCallback((count:InboxUnread)=>onUnread('guild',count),[onUnread]);
  const squad=useCallback((count:InboxUnread)=>onUnread('squad',count),[onUnread]);
  const direct=useCallback((count:InboxUnread)=>onUnread('direct',count),[onUnread]);
  const world=useCallback((count:InboxUnread)=>onUnread('world_chat',count),[onUnread]);
  if(!enabled||!client||!session)return isChat(channel)?<div id="game-console-chats" role="tabpanel" aria-labelledby={`game-console-tab-${channel}`} className="game-console-action"><p>先選擇公會，即可開始與夥伴聊天。</p></div>:null;
  return <div id="game-console-chats" role="tabpanel" aria-labelledby={`game-console-tab-${channel}`} className="game-console-chats" hidden={!isChat(channel)}>
    {visited.includes('guild')&&<div hidden={channel!=='guild'}><PageLoadBoundary label="公會聊天"><MemberChannels client={client} session={session} kind="guild" compact active={active&&channel==='guild'} onUnread={guild} onNavigate={onNavigate}/></PageLoadBoundary></div>}
    {visited.includes('squad')&&<div hidden={channel!=='squad'}><PageLoadBoundary label="小隊聊天"><MemberChannels client={client} session={session} kind="squad" compact active={active&&channel==='squad'} onUnread={squad} onNavigate={onNavigate}/></PageLoadBoundary></div>}
    {visited.includes('direct')&&<div hidden={channel!=='direct'}><PageLoadBoundary label="私訊"><DirectMessages key={session.user.user_id} client={client} session={session} messageImagesEnabled={imageSite?.client===client&&imageSite.enabled===true} compact active={active&&channel==='direct'} onUnread={direct} openPeer={null} memberBlockingEnabled={memberBlockingEnabled}/></PageLoadBoundary></div>}
    {visited.includes('world_chat')&&<div hidden={channel!=='world_chat'}><PageLoadBoundary label="世界聊天"><MemberChannels client={client} session={session} kind="world" compact active={active&&channel==='world_chat'} onUnread={world} onNavigate={onNavigate}/></PageLoadBoundary></div>}
  </div>;
}
