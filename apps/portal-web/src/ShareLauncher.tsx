import {useEffect,useId,useRef,useState} from 'react';
import type {TabId} from './types';
import './ShareLauncher.css';

export type ShareTarget='post'|'work'|'resource'|'product'|'product-start';
export const SHARE_TARGETS:Record<ShareTarget,{tab:TabId;selector:string;label:string;activate?:boolean}>={
  post:{tab:'social',selector:'[data-guide-anchor="social:composer"] .social-write-trigger',label:'發文',activate:true},
  work:{tab:'showcase',selector:'[data-guide-anchor="showcase:title"]',label:'分享作品'},
  resource:{tab:'opensource',selector:'[data-guide-anchor="opensource:repository"]',label:'分享開源資源'},
  product:{tab:'supplier',selector:'[data-guide-anchor="supplier:import-results"] input[type="file"]',label:'上傳商品成果'},
  'product-start':{tab:'supplier',selector:'[data-guide-anchor="supplier:download-kit"] button',label:'準備商品'},
};

export function ShareLauncher({onChoose,disabled=false}:{onChoose:(target:ShareTarget)=>void;disabled?:boolean}){
  const id=useId(),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false),[product,setProduct]=useState(false);
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();},[open]);
  function close(){dialog.current?.close();setOpen(false);trigger.current?.focus({preventScroll:true});}
  function choose(target:ShareTarget){close();onChoose(target);}
  return <>
    <button ref={trigger} type="button" className="btn btn-primary share-launcher-trigger" aria-label="分享或提交" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={()=>{setProduct(false);setOpen(true);}}>＋分享</button>
    <dialog ref={dialog} className="share-launcher-dialog" aria-labelledby={id} onCancel={event=>{event.preventDefault();close();}} onClose={()=>setOpen(false)}>
      <header><h2 id={id}>{product?'你的商品準備好了嗎？':'你想分享什麼？'}</h2><button type="button" className="btn btn-ghost" aria-label="關閉分享選單" onClick={close}>關閉</button></header>
      <div className="share-launcher-options">
        {product?<>
          <button type="button" aria-label="我已有商品成果檔" onClick={()=>choose('product')}><strong>我已有商品成果檔</strong><span>上傳商品／商店檔案，預覽後確認。</span></button>
          <button type="button" aria-label="我還沒準備商品" onClick={()=>choose('product-start')}><strong>我還沒準備商品</strong><span>取得開店任務，交給自己的 AI 整理。</span></button>
          <button type="button" className="share-launcher-back" onClick={()=>setProduct(false)}>← 返回分享選單</button>
        </>:<>
          <button type="button" aria-label="發文" onClick={()=>choose('post')}><strong>發文</strong><span>分享近況、想法，或問個問題。</span></button>
          <button type="button" aria-label="分享作品" onClick={()=>choose('work')}><strong>分享作品</strong><span>設計、影片、文章、工具都可以。</span></button>
          <button type="button" aria-label="刊登商品" onClick={()=>setProduct(true)}><strong>刊登商品</strong><span>開始準備，或提交做好的商品成果。</span></button>
          <button type="button" aria-label="分享開源資源" onClick={()=>choose('resource')}><strong>分享開源資源</strong><span>貼 GitHub 網址，預覽後分享。</span></button>
        </>}
      </div>
    </dialog>
  </>;
}
