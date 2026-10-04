import {useEffect,useLayoutEffect,useRef,useState} from 'react';
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
    {!hidden&&<p id={help} className="messages-meta chat-input-help">{mobile?'換行請按鍵盤 Enter，傳送請按送出':'Enter 送出 · Shift+Enter 換行'}<span>{[...value].length}／2000 字</span></p>}
  </>;
}

export function ChatTime({value}:{value:string}){
  const date=new Date(value),today=new Date();
  const sameDay=date.toDateString()===today.toDateString();
  return <time dateTime={value} title={date.toLocaleString('zh-TW')}>{date.toLocaleString('zh-TW',{...(sameDay?{}:{month:'numeric',day:'numeric',...(date.getFullYear()===today.getFullYear()?{}:{year:'numeric'})}),hour:'2-digit',minute:'2-digit',hour12:false})}</time>;
}
