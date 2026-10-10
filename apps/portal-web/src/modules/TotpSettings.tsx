import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {ApiError,type PortalClient} from '../api';
import {generateTotpSecret,totpProvisioningUri} from './totp-setup';

type TotpStatus={enabled:boolean;backup_codes_remaining:number};
type EnableResult={enabled:true;backup_codes:string[]};

export function TotpSettings({client,email}:{client:PortalClient;email:string}){
  const id=useId();
  const [status,setStatus]=useState<TotpStatus|null>(null),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [secret,setSecret]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState('');
  const [backupCodes,setBackupCodes]=useState<string[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  // Unknown transport outcomes reuse the existing receipt only for an identical explicit submission.
  const pending=useRef<{body:string;key:string}|null>(null);
  const live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;pending.current=null}},[]);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    void client.get<TotpStatus>('/me/totp',{suppressConsole:true}).then(value=>{if(active)setStatus(value)}).catch(()=>{if(active)setError('無法讀取雙因素驗證設定，請重試。')}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[client,revision]);
  function start(){
    setError('');setNotice('');setPassword('');setCode('');pending.current=null;
    try{setSecret(generateTotpSecret())}catch{setError('瀏覽器無法安全產生驗證器金鑰，請使用支援安全連線的瀏覽器。')}
  }
  function cancel(){setSecret('');setPassword('');setCode('');setError('');pending.current=null}
  async function submit(event:FormEvent){
    event.preventDefault();if(busy||!status)return;
    const enabling=!status.enabled;
    if(enabling&&!secret)return;
    const body=enabling?{password,secret,code:code.trim()}:{password,code:code.trim()};
    const serialized=JSON.stringify(body);
    const key=pending.current?.body===serialized?pending.current.key:crypto.randomUUID();
    pending.current={body:serialized,key};setBusy(true);setError('');setNotice('');
    try{
      const result=await client.post<EnableResult|{enabled:false}>(`/me/totp/${enabling?'enable':'disable'}`,body,{idempotencyKey:key,skipAuthHandler:true,suppressConsole:true});
      if(!live.current)return;
      pending.current=null;setSecret('');setPassword('');setCode('');
      if(result.enabled){setBackupCodes(result.backup_codes);setStatus({enabled:true,backup_codes_remaining:result.backup_codes.length});setNotice('雙因素驗證已啟用。請立即保存備用碼。')}
      else{setBackupCodes(null);setStatus({enabled:false,backup_codes_remaining:0});setNotice('雙因素驗證已停用，原驗證器金鑰與備用碼已失效。')}
    }catch(cause){
      if(!live.current)return;
      if(cause instanceof ApiError&&['totp_backup_codes_already_delivered','totp_already_enabled'].includes(cause.code??'')){
        pending.current=null;setSecret('');setPassword('');setCode('');setBackupCodes(null);
        setStatus(null);setRevision(value=>value+1);
        setNotice('雙因素驗證已啟用，但本次未取得備用碼。請使用已設定的驗證器；若需要新的備用碼，可用驗證器代碼停用後重新設定。');
        return;
      }
      if(!(cause instanceof ApiError)||!cause.network)pending.current=null;
      setError(cause instanceof ApiError&&cause.network?'尚未確認操作結果。請保留目前欄位再按一次提交；若離開此頁，備用碼不會再次顯示。':cause instanceof ApiError&&cause.status===429?'驗證嘗試過多，請稍後再試。':cause instanceof ApiError&&cause.status===401?'密碼或驗證碼不正確，或登入已過期。請確認後再試。':'設定未完成，請確認密碼與驗證碼後重試。');
    }finally{if(live.current)setBusy(false)}
  }
  async function copy(){
    if(!backupCodes)return;
    try{await navigator.clipboard.writeText(backupCodes.join('\n'));if(live.current)setNotice('備用碼已複製。請保存至安全位置，並清除剪貼簿；每組只能使用一次。')}
    catch{if(live.current)setError('無法複製，請從下方欄位手動選取並保存備用碼。')}
  }
  const uri=secret?totpProvisioningUri(secret,email):'';
  return <section className="card stack account-settings totp-settings" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>帳號安全 · 雙因素驗證</h3>
    <p className="muted">登入時使用密碼與驗證器的六位數代碼；無法使用驗證器時可用一次性備用碼。</p>
    {loading&&<p role="status">載入雙因素驗證設定…</p>}
    {error&&<p className="banner banner-error" role="alert">{error}</p>}
    {notice&&<p className="banner banner-info" role="status">{notice}</p>}
    {!loading&&!status&&<button type="button" className="btn btn-secondary btn-small" onClick={()=>setRevision(value=>value+1)}>重試讀取設定</button>}
    {status&&!loading&&<>
      <p>{status.enabled?`已啟用 · 剩餘 ${status.backup_codes_remaining} 組備用碼`:'尚未啟用'}</p>
      {backupCodes&&<div className="help-box stack">
        <h4>立即保存備用碼</h4>
        <p>備用碼只在這次啟用後顯示，離開或重新整理後無法再查看。請複製或手動保存至安全位置，不要分享給他人。每組只能使用一次。</p>
        <label className="field">備用碼<textarea readOnly rows={backupCodes.length} value={backupCodes.join('\n')} autoComplete="off" spellCheck={false}/></label>
        <div className="actions"><button type="button" className="btn btn-secondary btn-small" onClick={()=>void copy()}>複製備用碼</button><button type="button" className="btn btn-ghost btn-small" onClick={()=>{setBackupCodes(null);setNotice('備用碼已從此頁清除。')}}>已保存，隱藏備用碼</button></div>
      </div>}
      {!status.enabled&&!secret&&<button type="button" className="btn btn-secondary btn-small" onClick={start}>設定驗證器</button>}
      {(status.enabled||secret)&&<form className="stack" onSubmit={event=>void submit(event)}>
        {secret&&<div className="help-box stack">
          <h4>手動匯入驗證器</h4><p>在驗證器新增時間型（TOTP）帳號：SHA-1、六位數、每 30 秒更新。金鑰只保留在此頁，取消或離開後會清除；請勿分享。</p>
          <label className="field">驗證器金鑰<input readOnly value={secret} autoComplete="off" spellCheck={false}/></label>
          <label className="field">本機匯入 URI<textarea readOnly rows={3} value={uri} autoComplete="off" spellCheck={false}/></label>
          <a className="btn btn-secondary btn-small" href={uri} referrerPolicy="no-referrer">以驗證器開啟</a>
        </div>}
        <label className="field">目前密碼<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={event=>setPassword(event.target.value)} disabled={busy}/></label>
        <label className="field">{status.enabled?'驗證器代碼或備用碼':'驗證器目前的六位數代碼'}<input type="text" autoComplete="one-time-code" inputMode={status.enabled?'text':'numeric'} pattern={status.enabled?undefined:'[0-9]{6}'} maxLength={status.enabled?64:6} autoCapitalize="none" spellCheck={false} required value={code} onChange={event=>setCode(event.target.value)} disabled={busy}/></label>
        {status.enabled&&<p className="field-hint">停用後，登入將只需要密碼，原備用碼與驗證器金鑰會失效。</p>}
        <div className="actions"><button className="btn btn-secondary btn-small" disabled={busy} aria-busy={busy}>{busy?'處理中…':status.enabled?'停用雙因素驗證':'確認啟用'}</button>{secret&&<button type="button" className="btn btn-ghost btn-small" onClick={cancel} disabled={busy}>取消設定</button>}</div>
      </form>}
    </>}
  </section>;
}
