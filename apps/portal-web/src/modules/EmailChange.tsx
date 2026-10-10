import { useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';

export function EmailChangePanel({client,email}:{client:PortalClient;email:string}){
  const [nextEmail,setNextEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  async function submit(event:FormEvent){
    event.preventDefault();setBusy(true);setNotice('');setError('');
    try{await client.post('/me/account/email-change/request',{email:nextEmail,password});setPassword('');setNotice('驗證信已寄到新 Email。請在 30 分鐘內點擊連結確認；確認前仍使用原 Email 登入。');}
    catch(e){setError(e instanceof Error?e.message:'無法申請變更，請稍後再試。');}
    finally{setBusy(false);}
  }
  return <form className="card stack account-settings" onSubmit={submit}><h3>變更登入 Email</h3><p>目前登入 Email：{email}</p><p className="field-hint">確認新信箱後才切換。舊信箱會收到通知，其他裝置的登入會撤銷；最新申請取代先前連結。</p><label className="field">新登入 Email<input type="email" autoComplete="email" required maxLength={200} value={nextEmail} onChange={e=>setNextEmail(e.target.value)}/></label><label className="field">目前密碼<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<button className="btn btn-secondary btn-small" disabled={busy}>{busy?'寄送中…':'寄送 Email 變更驗證信'}</button></form>;
}

export function EmailChangeConfirm({client,token}:{client:PortalClient;token:string}){
  const [busy,setBusy]=useState(false),[changed,setChanged]=useState(false),[error,setError]=useState('');
  async function confirm(){
    setBusy(true);setError('');
    try{await client.post('/auth/email-change/confirm',{token},{skipAuthHandler:true});setChanged(true);window.history.replaceState(null,'',window.location.pathname+window.location.search);}
    catch(e){setError(e instanceof Error?e.message:'無法確認變更，請稍後再試。');}
    finally{setBusy(false);}
  }
  return <div className="app-frame"><main className="main stack"><section className="card stack"><h1>確認變更登入 Email</h1>{changed?<p role="status">登入 Email 已變更，舊信箱已收到通知。其他裝置須以新 Email 重新登入。</p>:<><p>確認此連結代表您可以使用新信箱；確認後才會切換登入 Email。</p><button className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void confirm()}>{busy?'確認中…':'確認變更登入 Email'}</button></>}{error&&<p role="alert">{error}</p>}<a className="btn btn-secondary btn-small" href="/">返回工坊</a></section></main></div>;
}
