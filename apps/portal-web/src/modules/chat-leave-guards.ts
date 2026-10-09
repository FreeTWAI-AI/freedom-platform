import {useLayoutEffect,useState} from 'react';

export type ChatLeaveGuard=()=>boolean;
export type RegisterChatLeave=(guard:ChatLeaveGuard|null)=>void;
type Chat='direct'|'guild'|'squad'|'world';
/** Each mounted child owns one slot. Unregistering it cannot release its siblings. */
export function createChatLeaveGuards(){
  const guards=new Map<Chat,ChatLeaveGuard>();
  const register=(chat:Chat):RegisterChatLeave=>guard=>{if(guard)guards.set(chat,guard);else guards.delete(chat);};
  return {
    direct:register('direct'),guild:register('guild'),squad:register('squad'),world:register('world'),
    canLeave:()=>{for(const guard of guards.values())if(!guard())return false;return true;},
  };
}
/** Keep one stable aggregate registered with the existing page/session guard. */
export function useChatLeaveGuards(registerLeave?:RegisterChatLeave){
  const [guards]=useState(createChatLeaveGuards);
  useLayoutEffect(()=>{
    registerLeave?.(guards.canLeave);
    return()=>registerLeave?.(null);
  },[registerLeave,guards]);
  return guards;
}
