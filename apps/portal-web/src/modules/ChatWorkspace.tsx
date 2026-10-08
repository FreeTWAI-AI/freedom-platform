import {useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react';
import './ChatWorkspace.css';

/** The console is always a single pane; the full inbox uses one pane on phones. */
export function useChatViewport(){
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width:760px)').matches);
  useEffect(()=>{
    const media=window.matchMedia('(max-width:760px)'),update=()=>setMobile(media.matches);
    update();media.addEventListener('change',update);
    return()=>media.removeEventListener('change',update);
  },[]);
  return mobile;
}

/** Keep a phone's fixed conversation inside the visual viewport when its keyboard opens. */
export function usePhoneChatBounds(hub:RefObject<HTMLElement|null>){
  const mobile=useChatViewport();
  useLayoutEffect(()=>{
    const frame=hub.current?.closest<HTMLElement>('.app-frame');
    if(!mobile||!frame)return;
    const viewport=window.visualViewport;
    const update=()=>{frame.style.setProperty('--chat-viewport-height',`${viewport?.height??innerHeight}px`);frame.style.setProperty('--chat-viewport-offset',`${viewport?.offsetTop??0}px`);};
    update();viewport?.addEventListener('resize',update);viewport?.addEventListener('scroll',update);window.addEventListener('resize',update);
    return()=>{viewport?.removeEventListener('resize',update);viewport?.removeEventListener('scroll',update);window.removeEventListener('resize',update);frame.style.removeProperty('--chat-viewport-height');frame.style.removeProperty('--chat-viewport-offset');};
  },[mobile,hub]);
}

/** A rendered, visible latest bubble is the read boundary; hidden panels and history browsing never write. */
export function useVisibleChatRead({active,identity,through,unread,blocked,scroll,onRead}:{
  active:boolean;identity:string|null;through:string|undefined;unread:number;blocked:boolean;
  scroll:RefObject<HTMLDivElement|null>;onRead:(through:string)=>void;
}){
  const action=useRef(onRead);action.current=onRead;
  // Keep the attempted boundary across remounts of the log and quiet GET refreshes.
  // An unknown write result is retried only with the explicit recovery control and its original key.
  const attempted=useRef(new Map<string,string>());
  useEffect(()=>{
    if(!active||!identity||!through||unread<=0||blocked)return;
    const log=scroll.current,bubble=log?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(through)}"]`);
    if(!log||!bubble)return;
    let frame=0;
    const check=()=>{
      frame=0;
      if(document.visibilityState!=='visible'||!navigator.onLine||attempted.current.get(identity)===through)return;
      if(log.scrollHeight-log.scrollTop-log.clientHeight>=80)return;
      const box=bubble.getBoundingClientRect(),bounds=log.getBoundingClientRect();
      const top=Math.max(0,bounds.top),bottom=Math.min(innerHeight,bounds.bottom),left=Math.max(0,bounds.left),right=Math.min(innerWidth,bounds.right);
      if(bottom<=top||right<=left||box.bottom<=top||box.top>=bottom||box.right<=left||box.left>=right)return;
      attempted.current.set(identity,through);action.current(through);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(check)};
    const observer=new IntersectionObserver(schedule);observer.observe(bubble);
    schedule();window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
    window.addEventListener('focus',schedule);window.addEventListener('online',schedule);document.addEventListener('visibilitychange',schedule);
    return()=>{cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);
      window.removeEventListener('focus',schedule);window.removeEventListener('online',schedule);document.removeEventListener('visibilitychange',schedule);};
  },[active,identity,through,unread,blocked,scroll]);
}

export function ChatInput({id,label,value,onChange,onSend,sending,hidden,errorId,mobile}:{
  id:string;label:string;value:string;onChange:(value:string)=>void;onSend:()=>void;
  sending:boolean;hidden:boolean;errorId?:string;mobile:boolean;
}){
  const input=useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(()=>{
    const node=input.current;if(!node||hidden)return;
    node.style.height='auto';node.style.height=`${Math.min(128,Math.max(44,node.scrollHeight))}px`;
  },[value,hidden,mobile]);
  const help=`${id}-help`;
  return <>
    <label className="field chat-input" hidden={hidden}>
      <span className="chat-sr-only">{label}</span>
      <textarea ref={input} id={id} value={value} rows={1} placeholder="輸入訊息…" readOnly={sending}
        aria-describedby={[help,errorId].filter(Boolean).join(' ')}
        onKeyDown={event=>{if(!mobile&&event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();onSend();}}}
        onChange={event=>onChange(event.target.value)}/>
    </label>
    {!hidden&&<p id={help} className="messages-meta chat-input-help" data-near-limit={[...value].length>=1800}>{mobile?'換行請按鍵盤 Enter，傳送請按送出':'Enter 送出 · Shift+Enter 換行'}<span>{[...value].length}／2000 字</span></p>}
  </>;
}

export function ChatTime({value}:{value:string}){
  const date=new Date(value),today=new Date();
  const sameDay=date.toDateString()===today.toDateString();
  return <time dateTime={value} title={date.toLocaleString('zh-TW')}>{date.toLocaleString('zh-TW',{...(sameDay?{}:{month:'numeric',day:'numeric',...(date.getFullYear()===today.getFullYear()?{}:{year:'numeric'})}),hour:'2-digit',minute:'2-digit',hour12:false})}</time>;
}
