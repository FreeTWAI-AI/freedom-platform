import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import { Status } from './Membership';

type MemberSession = { current: boolean; created_at: string | null; last_seen_at: string | null; expires_at: string };
type SessionList = { items: MemberSession[]; total: number };

function when(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '不詳';
  return new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

export function AccountSecurity({ client, onAccountChanged }: { client: PortalClient; onAccountChanged: () => Promise<void> }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false), [passwordError, setPasswordError] = useState(''), [passwordNotice, setPasswordNotice] = useState('');
  const [sessions, setSessions] = useState<SessionList | null>(null), [sessionError, setSessionError] = useState(''), [sessionNotice, setSessionNotice] = useState(''), [sessionBusy, setSessionBusy] = useState(false);
  const loadSequence=useRef(0),lifecycle=useRef(0),mounted=useRef(false);
  const generation=client.sessionGeneration;
  const loadSessions = useCallback(async () => {
    const sequence=++loadSequence.current,auth=client.sessionGeneration;
    const isCurrent=()=>mounted.current&&sequence===loadSequence.current&&auth===client.sessionGeneration;
    setSessionError('');
    try { const result=await client.get<SessionList>('/me/sessions');if(isCurrent())setSessions(result); }
    catch (cause) { if(isCurrent()){setSessions(null);setSessionError(cause instanceof Error ? cause.message : '目前無法讀取登入裝置。');} }
  }, [client]);
  useEffect(() => {
    mounted.current=true;
    setSessions(null);setSessionError('');setSessionNotice('');setSessionBusy(false);
    setCurrent('');setNext('');setConfirm('');setPasswordError('');setPasswordNotice('');setPasswordBusy(false);
    void loadSessions();
    return()=>{mounted.current=false;loadSequence.current++;lifecycle.current++;};
  }, [loadSessions,generation]);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setPasswordError(''); setPasswordNotice('');
    if (next !== confirm) { setPasswordError('兩次輸入的新密碼不一致。'); return; }
    if (next === current) { setPasswordError('新密碼不能與目前密碼相同。'); return; }
    const auth=client.sessionGeneration,epoch=lifecycle.current;const isCurrent=()=>mounted.current&&epoch===lifecycle.current&&auth===client.sessionGeneration;
    loadSequence.current++;setPasswordBusy(true);
    try {
      const result = await client.post<{ changed: true; revoked_sessions: number }>('/me/password', { current_password: current, new_password: next });
      if(!isCurrent())return;loadSequence.current++;setSessions(null);
      setCurrent(''); setNext(''); setConfirm('');
      setPasswordNotice(result.revoked_sessions > 0 ? `密碼已更新，其他 ${result.revoked_sessions} 個裝置已登出。` : '密碼已更新。');
      await onAccountChanged();
      if(isCurrent())await loadSessions();
    } catch (cause) { if(isCurrent())setPasswordError(cause instanceof Error ? cause.message : '密碼未更新，請稍後再試。'); }
    finally { if(isCurrent())setPasswordBusy(false); }
  }

  async function revokeOthers() {
    const auth=client.sessionGeneration,epoch=lifecycle.current;const isCurrent=()=>mounted.current&&epoch===lifecycle.current&&auth===client.sessionGeneration;
    loadSequence.current++;setSessionError(''); setSessionNotice(''); setSessionBusy(true);
    try {
      const result = await client.post<{ revoked_sessions: number }>('/me/sessions/revoke-others', {}, { idempotencyKey: crypto.randomUUID() });
      if(!isCurrent())return;loadSequence.current++;setSessions(null);
      setSessionNotice(result.revoked_sessions > 0 ? `已登出其他 ${result.revoked_sessions} 個裝置。` : '沒有其他裝置在登入中。');
      await onAccountChanged();
      if(isCurrent())await loadSessions();
    } catch (cause) { if(isCurrent())setSessionError(cause instanceof Error ? cause.message : '目前無法登出其他裝置。'); }
    finally { if(isCurrent())setSessionBusy(false); }
  }

  const others = sessions ? sessions.items.filter(item => !item.current).length : 0;
  return <section className="card stack account-security" aria-labelledby="account-security-heading">
    <h3 id="account-security-heading">登入與安全</h3>
    <form className="stack" onSubmit={changePassword} aria-label="修改密碼">
      <h4>修改密碼</h4>
      <Status error={passwordError} notice={passwordNotice}/>
      <label className="field">目前密碼<input type="password" autoComplete="current-password" required maxLength={200} value={current} onChange={event => setCurrent(event.target.value)} disabled={passwordBusy}/></label>
      <label className="field">新密碼<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} aria-describedby="new-password-hint" value={next} onChange={event => setNext(event.target.value)} disabled={passwordBusy}/></label>
      <p id="new-password-hint" className="field-hint">12 到 128 個字元；更新後其他裝置會被登出，這個裝置維持登入。</p>
      <label className="field">再次輸入新密碼<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirm} onChange={event => setConfirm(event.target.value)} disabled={passwordBusy}/></label>
      <div className="actions"><button className="btn btn-primary" disabled={passwordBusy} aria-busy={passwordBusy}>{passwordBusy ? '更新中…' : '更新密碼'}</button></div>
    </form>
    <div className="stack" aria-labelledby="sessions-heading">
      <h4 id="sessions-heading">登入中的裝置</h4>
      <Status error={sessionError} notice={sessionNotice}/>
      {!sessions && !sessionError && <p role="status">讀取登入裝置…</p>}
      {sessions && <ul className="session-list">{sessions.items.map((item, index) => <li key={`${item.expires_at}-${index}`} className="session-row">
        <strong>{item.current ? '這個裝置' : '其他裝置'}</strong>
        <span>登入：{when(item.created_at)}</span>
        <span>最近使用：{when(item.last_seen_at)}</span>
      </li>)}</ul>}
      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={() => void loadSessions()} disabled={sessionBusy}>重新讀取</button>
        <button type="button" className="btn btn-ghost" onClick={() => void revokeOthers()} disabled={sessionBusy || others === 0} aria-busy={sessionBusy}>登出其他裝置</button>
      </div>
    </div>
  </section>;
}
