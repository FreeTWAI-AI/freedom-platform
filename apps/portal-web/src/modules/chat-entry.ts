export type ChatEntry={kind:'guild'|'squad'|'world';key:string;request:number};
export const CHAT_ENTRY_EVENT='freedom-open-channel';
/** Navigation intent only. The server still checks access to every selected room. */
export function openMemberChat(kind:ChatEntry['kind'],key:string){
  window.dispatchEvent(new CustomEvent(CHAT_ENTRY_EVENT,{detail:{kind,key}}));
}
export function isChatEntry(value:unknown):value is Pick<ChatEntry,'kind'|'key'>{
  if(!value||typeof value!=='object')return false;
  const entry=value as Record<string,unknown>;
  return ['guild','squad','world'].includes(String(entry.kind))&&typeof entry.key==='string'&&entry.key.length>0&&entry.key.length<=120&&(entry.kind!=='world'||entry.key==='world');
}
