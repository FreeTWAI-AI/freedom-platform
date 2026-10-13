import {useEffect,useId,useRef,useState} from 'react';
import type {TabId} from './types';
import './ShareLauncher.css';

export type ShareTarget='post'|'work'|'resource'|'product'|'product-start'|'product-store'|'product-supply'|'collaborate'|'cocreate';
export const SHARE_TARGETS:Record<ShareTarget,{tab:TabId;selector:string;label:string;activate?:boolean;hash?:string}>={
  post:{tab:'social',selector:'[data-guide-anchor="social:composer"] .social-write-trigger',label:'發文',activate:true},
  work:{tab:'showcase',selector:'[data-guide-anchor="showcase:title"]',label:'分享作品'},
  resource:{tab:'opensource',selector:'[data-guide-anchor="opensource:repository"]',label:'分享開源資源'},
  product:{tab:'supplier',selector:'[data-guide-anchor="supplier:import-results"] input[type="file"]',label:'上傳商品成果'},
  'product-start':{tab:'supplier',selector:'[data-guide-anchor="supplier:download-kit"] button',label:'準備商品'},
  'product-store':{tab:'stores',hash:'#stores',selector:'[data-share-entry="stores"]',label:'在站內商店刊登'},
  'product-supply':{tab:'stores',hash:'#stores/supply',selector:'.hosted-store > h2',label:'供貨給其他店家'},
  collaborate:{tab:'showcase',selector:'[data-share-entry="collaboration"]',label:'找人合作'},
  cocreate:{tab:'cocreation',selector:'[data-share-entry="cocreation"]',label:'發起共創邀請'},
};

// With `guided`, the same dialog also says who can see each result and what is only a draft, and adds the
// collaboration entries. It never collects content: every option still opens the original form.
export function ShareLauncher({onChoose,disabled=false,guided=false,storesEnabled=false,onMyContent}:{onChoose:(target:ShareTarget)=>void;disabled?:boolean;guided?:boolean;storesEnabled?:boolean;onMyContent?:()=>void}){
  const id=useId(),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false),[product,setProduct]=useState(false);
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();},[open]);
  function close(){dialog.current?.close();setOpen(false);trigger.current?.focus({preventScroll:true});}
  function choose(target:ShareTarget){close();onChoose(target);}
  const fact=(text:string)=>guided?<span className="share-launcher-fact">{text}</span>:null;
  return <>
    <button ref={trigger} type="button" className="btn btn-primary share-launcher-trigger" aria-label="分享或提交" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={()=>{setProduct(false);setOpen(true);}}>＋分享</button>
    <dialog ref={dialog} className="share-launcher-dialog" aria-labelledby={id} onCancel={event=>{event.preventDefault();close();}} onClose={()=>setOpen(false)}>
      <header><h2 id={id}>{product?'你的商品準備好了嗎？':'你想分享什麼？'}</h2><button type="button" className="btn btn-ghost" aria-label="關閉分享選單" onClick={close}>關閉</button></header>
      <div className="share-launcher-options">
        {product?<>
          {storesEnabled&&<>
            <button type="button" aria-label="在站內商店刊登" onClick={()=>choose('product-store')}><strong>在站內商店刊登</strong><span>建立或進入你的商店，新增商品後預覽並發布。</span>{fact('尚未發布的內容不是公開頁；只有按「發布展示頁」才會公開 /shops/ 展示頁。')}</button>
            <button type="button" aria-label="供貨給其他店家" onClick={()=>choose('product-supply')}><strong>供貨給其他店家</strong><span>不開零售店，也能建立供貨商品庫。</span>{fact('商品與供貨條件先儲存為私人草稿。公開供貨版本後，同社群店主才能看到。這不會發布買家可見的零售展示頁。')}</button>
          </>}
          <button type="button" aria-label="我已有商品成果檔" onClick={()=>choose('product')}><strong>我已有商品成果檔</strong><span>上傳商品／商店檔案，預覽後確認。</span></button>
          <button type="button" aria-label="我還沒準備商品" onClick={()=>choose('product-start')}><strong>我還沒準備商品</strong><span>取得開店任務，交給自己的 AI 整理。</span></button>
          <button type="button" className="share-launcher-back" onClick={()=>setProduct(false)}>← 返回分享選單</button>
        </>:<>
          <button type="button" aria-label="發文" onClick={()=>choose('post')}><strong>發文</strong><span>分享近況、想法，或問個問題。</span>{fact('同社群會員可見；送出即發布，沒有草稿。')}</button>
          <button type="button" aria-label="分享作品" onClick={()=>choose('work')}><strong>分享作品</strong><span>設計、影片、文章、工具都可以。</span>{fact('最少填標題、一句話介紹並本人同意；成功分享後社群成員可見。未送出的內容不是公開作品。')}</button>
          <button type="button" aria-label="刊登商品" onClick={()=>setProduct(true)}><strong>刊登商品</strong><span>開始準備，或提交做好的商品成果。</span></button>
          <button type="button" aria-label="分享開源資源" onClick={()=>choose('resource')}><strong>分享開源資源</strong><span>貼 GitHub 網址，預覽後分享。</span>{fact('預覽不是公開；確認並通過來源與授權檢查後才會公開。')}</button>
          {guided&&<>
            <button type="button" aria-label="找人合作" onClick={()=>choose('collaborate')}><strong>找人合作</strong><span>向作品作者提出合作需求。</span>{fact('只有你與作者看得到，不是公開貼文，也不代表對方已接受。')}</button>
            <button type="button" aria-label="發起共創邀請" onClick={()=>choose('cocreate')}><strong>發起共創邀請</strong><span>邀請夥伴一起改進你已登錄的開源作品。</span>{fact('送出前不是邀請；修改仍由維護者審查。')}</button>
            <p className="share-launcher-note">選擇只會前往原表單，不會代你發布。未送出的輸入只保留在目前登入工作階段，重新整理或登出會清除。</p>
          </>}
        </>}
        {onMyContent && <button type="button" onClick={()=>{close();onMyContent();}}><strong>我的內容</strong><span>繼續私人草稿，查看發布與審核狀態。</span></button>}
      </div>
    </dialog>
  </>;
}
