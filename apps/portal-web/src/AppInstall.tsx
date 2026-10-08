import {createContext,useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {useLanguage} from './language';
import './AppInstall.css';

type InstallEvent=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:'accepted'|'dismissed'}>};
type InstallContext={installed:boolean;open:(trigger:HTMLElement|null)=>void};
const Context=createContext<InstallContext>({installed:false,open:()=>{}});
const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||(navigator as Navigator&{standalone?:boolean}).standalone===true;

/** Installation is offered explicitly. Browser acceptance is not an installation receipt. */
export function AppInstallProvider({children}:{children:ReactNode}){
  const {t}=useLanguage();
  const [installed,setInstalled]=useState(standalone),[open,setOpen]=useState(false),[available,setAvailable]=useState(false);
  const [pending,setPending]=useState(false),[notice,setNotice]=useState<'accepted'|'dismissed'|'failed'|null>(null);
  const prompt=useRef<InstallEvent|null>(null),busy=useRef(false),trigger=useRef<HTMLElement|null>(null),dialog=useRef<HTMLDialogElement>(null);
  const alive=useRef(true),title=useId();
  const apple=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  useEffect(()=>{
    alive.current=true;
    const media=window.matchMedia('(display-mode: standalone)');
    const mode=()=>setInstalled(standalone());
    const ready=(event:Event)=>{
      if(typeof (event as InstallEvent).prompt!=='function'||!(event as InstallEvent).userChoice)return;
      event.preventDefault();prompt.current=event as InstallEvent;setAvailable(true);
    };
    const done=()=>{prompt.current=null;setAvailable(false);setInstalled(true);setOpen(false);};
    media.addEventListener('change',mode);window.addEventListener('beforeinstallprompt',ready);window.addEventListener('appinstalled',done);
    return()=>{alive.current=false;media.removeEventListener('change',mode);window.removeEventListener('beforeinstallprompt',ready);window.removeEventListener('appinstalled',done);};
  },[]);
  useEffect(()=>{
    const node=dialog.current;
    if(open&&!installed&&!node?.open)node?.showModal();
    else if(!open||installed)node?.close();
  },[open,installed]);
  useEffect(()=>{
    let frame=0;
    const sync=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
      const color=getComputedStyle(document.body).backgroundColor;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content',color);
    });};
    const observer=new MutationObserver(sync);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});sync();
    return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[]);
  function closed(){setOpen(false);if(trigger.current?.isConnected)trigger.current.focus({preventScroll:true});}
  async function install(){
    const event=prompt.current;if(!event||busy.current)return;
    busy.current=true;setPending(true);setNotice(null);
    // Each event can be consumed once, including a rejected or dismissed prompt.
    prompt.current=null;setAvailable(false);
    try{await event.prompt();const choice=await event.userChoice;if(alive.current)setNotice(choice.outcome==='accepted'?'accepted':'dismissed');}
    catch{if(alive.current)setNotice('failed');}
    finally{busy.current=false;if(alive.current)setPending(false);}
  }
  return <Context.Provider value={{installed,open(node){if(installed)return;trigger.current=node;setNotice(null);setOpen(true);}}}>
    <ConnectionStatus/>{children}
    <dialog ref={dialog} className="app-install-dialog" aria-labelledby={title} onCancel={()=>setOpen(false)} onClose={closed}>
      <header><h2 id={title}>{t('install.title')}</h2><button type="button" className="btn btn-ghost" aria-label={t('install.close')} onClick={()=>setOpen(false)}>×</button></header>
      <img className="app-install-brand" src="/brand/freedom-workshop.webp" alt="自由工坊" width="1280" height="720"/>
      <p>{t('install.intro')}</p>
      {available&&<button type="button" className="btn btn-primary" disabled={pending} onClick={()=>void install()}>{t(pending?'install.pending':'install.confirm')}</button>}
      {pending&&<p role="status">{t('install.pending')}</p>}
      {notice&&<p role="status">{t(`install.${notice}`)}</p>}
      <ol>{(apple?['appleShare','appleAdd','appleOpen'] as const:['browserMenu','browserAdd','browserOpen'] as const).map(key=><li key={key}>{t(`install.${key}`)}</li>)}</ol>
      <p className="field-hint">{t('install.online')}</p>
      <button type="button" className="btn btn-ghost" onClick={()=>setOpen(false)}>{t('install.later')}</button>
    </dialog>
  </Context.Provider>;
}

export function InstallAppButton(){
  const {installed,open}=useContext(Context),{t}=useLanguage();
  if(installed)return null;
  return <button type="button" className="btn btn-ghost app-install-trigger" onClick={event=>open(event.currentTarget)}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/></svg>{t('install.title')}</button>;
}
export const useAppInstall=()=>useContext(Context);

function ConnectionStatus(){
  const {t}=useLanguage();const [offline,setOffline]=useState(()=>!navigator.onLine),banner=useRef<HTMLDivElement>(null);
  useEffect(()=>{const sync=()=>setOffline(!navigator.onLine);window.addEventListener('online',sync);window.addEventListener('offline',sync);return()=>{window.removeEventListener('online',sync);window.removeEventListener('offline',sync);};},[]);
  useEffect(()=>{
    const root=document.documentElement;
    if(!offline){root.style.removeProperty('--connection-status-height');delete root.dataset.deviceOffline;return;}
    root.dataset.deviceOffline='true';
    const size=()=>root.style.setProperty('--connection-status-height',`${banner.current?.getBoundingClientRect().height??0}px`);
    const observer=new ResizeObserver(size);if(banner.current)observer.observe(banner.current);size();
    return()=>{observer.disconnect();root.style.removeProperty('--connection-status-height');delete root.dataset.deviceOffline;};
  },[offline,t]);
  return offline?<div ref={banner} className="app-connection-status" role="status" aria-live="polite" aria-atomic="true">
    <span className="request-feedback is-offline">{t('request.offline')}</span>{' '}<span>{t('request.draftHint')}</span>
  </div>:null;
}
