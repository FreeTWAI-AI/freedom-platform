import {useCallback,useEffect,useState} from 'react';
import type {PortalClient} from './api';
import type {SessionPayload,TabId} from './types';
import type {GameConsoleChannel} from './game-console-core';
import {MemberChannels} from './modules/MemberChannels';
import {DirectMessages} from './modules/MemberMessages';
import type {InboxUnread} from './modules/member-inbox';

type Chat='guild'|'squad'|'direct'|'world_chat';
const isChat=(value:GameConsoleChannel):value is Chat=>['guild','squad','direct','world_chat'].includes(value);
/** The dock and the message page use identical room controls, draft safety and access checks. */
export function GameConsoleComposer({client,session,enabled,channel,active,onUnread,onNavigate}:{
  client?:PortalClient;session?:SessionPayload;enabled:boolean;channel:GameConsoleChannel;active:boolean;
  onUnread:(channel:Chat,count:InboxUnread)=>void;onNavigate:(id:TabId)=>void;
}){
  const [visited,setVisited]=useState<Chat[]>([]);
  useEffect(()=>{if(active&&isChat(channel))setVisited(value=>value.includes(channel)?value:[...value,channel])},[active,channel]);
  const guild=useCallback((count:InboxUnread)=>onUnread('guild',count),[onUnread]);
  const squad=useCallback((count:InboxUnread)=>onUnread('squad',count),[onUnread]);
  const direct=useCallback((count:InboxUnread)=>onUnread('direct',count),[onUnread]);
  const world=useCallback((count:InboxUnread)=>onUnread('world_chat',count),[onUnread]);
  if(!enabled||!client||!session)return isChat(channel)?<div id="game-console-chats" role="tabpanel" aria-labelledby={`game-console-tab-${channel}`} className="game-console-action"><p>先選擇公會，即可開始與夥伴聊天。</p></div>:null;
  return <div id="game-console-chats" role="tabpanel" aria-labelledby={`game-console-tab-${channel}`} className="game-console-chats" hidden={!isChat(channel)}>
    {visited.includes('guild')&&<div hidden={channel!=='guild'}><MemberChannels client={client} session={session} kind="guild" compact active={active&&channel==='guild'} onUnread={guild} onNavigate={onNavigate}/></div>}
    {visited.includes('squad')&&<div hidden={channel!=='squad'}><MemberChannels client={client} session={session} kind="squad" compact active={active&&channel==='squad'} onUnread={squad} onNavigate={onNavigate}/></div>}
    {visited.includes('direct')&&<div hidden={channel!=='direct'}><DirectMessages client={client} session={session} compact active={active&&channel==='direct'} onUnread={direct} openPeer={null}/></div>}
    {visited.includes('world_chat')&&<div hidden={channel!=='world_chat'}><MemberChannels client={client} session={session} kind="world" compact active={active&&channel==='world_chat'} onUnread={world} onNavigate={onNavigate}/></div>}
  </div>;
}
