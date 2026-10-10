import { useState } from 'react';
import { ApiError, type PortalClient } from '../api';

export function EmailVerificationPanel({client,email,verified}:{client:PortalClient;email:string;verified:boolean}){
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  async function send(){
    setBusy(true);setNotice('');setError('');
    try{
      await client.post('/me/account/email-verification/request',{});
      setNotice('驗證信已寄送，請於 30 分鐘內開啟信中連結。每小時最多寄送三次。');
    }catch(cause){
      setError(cause instanceof ApiError&&cause.code==='email_verification_unavailable'?'驗證信郵件服務尚未設定完成。':cause instanceof ApiError&&cause.code==='email_verification_send_failed'?'驗證信寄送失敗，請稍後重試。':cause instanceof Error?cause.message:'寄送未完成，請稍後重試。');
    }finally{setBusy(false);}
  }
  return <section className="card stack email-settings"><h3>登入信箱驗證</h3><p>{email} · {verified?'已驗證':'尚未驗證'}</p>{!verified&&<div><button className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void send()}>{busy?'寄送中…':notice?'重寄驗證信':'寄送驗證信'}</button></div>}{notice&&<p role="status">{notice}</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}</section>;
}

export function EmailVerificationConfirm({client,token}:{client:PortalClient;token:string}){
  const [busy,setBusy]=useState(false),[verified,setVerified]=useState(false),[error,setError]=useState('');
  async function confirm(){
    setBusy(true);setError('');
    try{
      await client.post('/auth/email-verification/confirm',{token},{skipAuthHandler:true,suppressConsole:true});
      setVerified(true);
      window.history.replaceState(null,'',window.location.pathname+window.location.search);
    }catch(cause){setError(cause instanceof Error?cause.message:'驗證未完成，請稍後重試。');}
    finally{setBusy(false);}
  }
  return <main className="email-confirm"><section className="card stack"><h1>驗證登入信箱</h1>{verified?<p role="status">登入信箱已完成驗證。</p>:<><p>確認後，此一次性連結將完成登入信箱驗證。連結有效時間為 30 分鐘。</p><div><button className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void confirm()}>{busy?'驗證中…':'確認驗證信箱'}</button></div></>}{error&&<p className="banner banner-error" role="alert">{error}</p>}<a className="btn btn-ghost btn-small" href="/#account">返回帳號頁</a></section></main>;
}
