import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, type PortalClient } from '../api';
import { DeviceUserCodeSchema } from '../../../../contracts/execution/v1/device-pairing';
import { createMemberDeviceClient } from './member-device-client';
import './DeviceConnections.css';

type DeviceClient = ReturnType<typeof createMemberDeviceClient>;
type Review = Awaited<ReturnType<DeviceClient['inspect']>>;
type Connection = Awaited<ReturnType<DeviceClient['read']>>;
type DecisionBody = Parameters<DeviceClient['decide']>[0];
type Decision = DecisionBody['decision'];
type DecisionCommand = { readonly body: DecisionBody; readonly key: string };
type RevokeCommand = { readonly connectionId: string; readonly expectedVersion: string; readonly key: string };
type ListState = 'loading' | 'ready' | 'unavailable' | 'not_enabled' | 'denied' | 'expired';
type ReadState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'missing' | 'denied' | 'expired';

const REVIEW_LABELS: Record<Review['state'], string> = { pending: '待本人審核', approved: '已核准', denied: '已拒絕', consumed: '裝置已完成配對' };
const time = (value: string) => { const at = Date.parse(value); return Number.isFinite(at) ? new Date(at).toLocaleString('zh-TW') : '時間無法顯示'; };
const statusOf = (failure: unknown) => failure instanceof ApiError ? failure.status : 0;
const expiredAccess = (failure: unknown) => failure instanceof ApiError && (failure.accessExpired || failure.status === 401);
// Network loss, timeouts, 5xx and unparsable or mismatched output leave the server outcome unknown.
const uncertain = (failure: unknown) => !(failure instanceof ApiError) || failure.network || failure.timedOut || failure.status >= 500
  || (failure.status < 400 && !failure.accessExpired);
const rejected = (failure: unknown) => failure instanceof ApiError && (failure.conflict || failure.status === 403);

function normalizeCode(value: string): string {
  const compact = value.toUpperCase().replace(/[^0-9A-Z-]/g, '');
  return (/^[0-9A-Z]{10}$/.test(compact) ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact).slice(0, 11);
}
function connectionLabel(value: Connection, now: number): string {
  if (value.state === 'revoked') return '已撤銷';
  return Date.parse(value.expiresAt) <= now ? '已到期' : '有效';
}
function listFailure(failure: unknown): ListState {
  if (expiredAccess(failure)) return 'expired';
  if (uncertain(failure)) return 'unavailable';
  const status = statusOf(failure);
  return status === 403 ? 'denied' : status === 404 ? 'not_enabled' : 'unavailable';
}
function readFailure(failure: unknown): ReadState {
  if (expiredAccess(failure)) return 'expired';
  if (uncertain(failure)) return 'unavailable';
  const status = statusOf(failure);
  return status === 403 ? 'denied' : status === 404 ? 'missing' : 'unavailable';
}
function inspectMessage(failure: unknown): string {
  if (expiredAccess(failure)) return '登入已過期。請重新登入後再讀取配對請求。';
  if (uncertain(failure)) return '配對請求目前無法讀取。請稍後再按「讀取配對請求」；不會自動重試。';
  const status = statusOf(failure);
  if (status === 400 || status === 422) return '配對代碼格式不正確。請確認裝置上顯示的代碼。';
  if (status === 403) return '目前帳號無法審核裝置配對。請確認登入與加入狀態。';
  if (status === 404 || status === 410) return '找不到這組配對代碼、請求已失效，或此環境尚未提供裝置配對。請確認裝置上顯示的代碼。';
  if (status === 429) return '查詢次數過多。請稍後再讀取配對請求。';
  return '配對請求目前無法讀取。請確認代碼後再試。';
}

/** Member-owned device pairing review and bounded connection management.
 * Approval grants only bootstrap.status.read; it is never model execution authority or provider login.
 * Unresolved commands live only in component memory and are never replayed automatically. */
export function DeviceConnections({ client, onChanged }: { client: PortalClient; onChanged?: () => void }) {
  const device = useMemo(() => createMemberDeviceClient(client), [client]);
  const hintId = useId();
  const [code, setCode] = useState('');
  const [review, setReview] = useState<{ code: string; data: Review } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [consent, setConsent] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<DecisionCommand | null>(null);
  const [pairError, setPairError] = useState(''), [pairNotice, setPairNotice] = useState('');
  const [connections, setConnections] = useState<readonly Connection[] | null>(null);
  const [listState, setListState] = useState<ListState>('loading');
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<Connection | null>(null);
  const [readState, setReadState] = useState<ReadState>('idle');
  const [revokeConsent, setRevokeConsent] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<RevokeCommand | null>(null);
  const [connError, setConnError] = useState(''), [connNotice, setConnNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const live = useRef(false), lifetime = useRef(0), lock = useRef(false);
  const inspectSeq = useRef(0), listSeq = useRef(0), readSeq = useRef(0);
  const changed = useRef(onChanged); changed.current = onChanged;

  const loadList = useCallback(async () => {
    const generation = lifetime.current, sequence = ++listSeq.current;
    const fresh = () => live.current && generation === lifetime.current && sequence === listSeq.current;
    setListState('loading');
    try {
      const dto = await device.list();
      if (!fresh()) return;
      if (!dto || !Array.isArray(dto.items)) throw new Error('invalid_list');
      setConnections(dto.items); setListState('ready'); setNow(Date.now());
    } catch (failure) {
      if (!fresh()) return;
      setConnections(null); setListState(listFailure(failure));
    }
  }, [device]);

  useEffect(() => {
    // A replacement client starts a new memory context: unresolved commands, reviews
    // and locks from the previous client are dropped and its late responses are fenced.
    live.current = true; lock.current = false;
    inspectSeq.current++; readSeq.current++;
    setBusy(false); setCode(''); setReview(null); setInspecting(false); setConsent(false); setPendingDecision(null);
    setPairError(''); setPairNotice(''); setConnections(null); setSelectedId(''); setSelected(null); setReadState('idle');
    setRevokeConsent(false); setPendingRevoke(null); setConnError(''); setConnNotice('');
    void loadList();
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => { live.current = false; lifetime.current++; inspectSeq.current++; listSeq.current++; readSeq.current++; window.clearInterval(timer); };
  }, [loadList]);

  async function inspect(target: string) {
    if (!live.current) return;
    const generation = lifetime.current, sequence = ++inspectSeq.current;
    const fresh = () => live.current && generation === lifetime.current && sequence === inspectSeq.current;
    setConsent(false); setPairError(''); setPairNotice('');
    if (!DeviceUserCodeSchema.safeParse(target).success) {
      setReview(null); setInspecting(false);
      setPairError('請輸入裝置上顯示的配對代碼，格式為 5 碼、連字號、5 碼。');
      return;
    }
    setInspecting(true);
    try {
      const data = await device.inspect(target);
      if (!fresh()) return;
      setReview({ code: target, data }); setNow(Date.now());
    } catch (failure) {
      if (!fresh()) return;
      setReview(null); setPairError(inspectMessage(failure));
    } finally {
      if (fresh()) setInspecting(false);
    }
  }

  function startDecision(decision: Decision) {
    if (lock.current || !live.current || pendingDecision || !review || inspecting || busy) return;
    const data = review.data;
    if (review.code !== code || data.state !== 'pending' || Date.parse(data.expiresAt) <= Date.now()) {
      setConsent(false); setPairError('配對請求已變更或到期。請重新讀取配對請求。');
      return;
    }
    if (decision === 'approve' && !consent) return;
    const body: DecisionBody = Object.freeze({ userCode: review.code, authorizationId: data.authorizationId, requestDigest: data.requestDigest, decision });
    void runDecision(Object.freeze({ body, key: crypto.randomUUID() }), false);
  }

  async function runDecision(command: DecisionCommand, confirming: boolean) {
    if (lock.current || !live.current) return;
    lock.current = true;
    const generation = lifetime.current;
    const active = () => live.current && generation === lifetime.current;
    const approve = command.body.decision === 'approve';
    let reread = false;
    inspectSeq.current++;
    setInspecting(false); setBusy(true); setConsent(false); setPairError(''); setPairNotice('');
    try {
      const result = await device.decide(command.body, command.key);
      if (!active()) return;
      if (result.authorizationId !== command.body.authorizationId || result.requestDigest !== command.body.requestDigest
        || result.state !== (approve ? 'approved' : 'denied')) throw new Error('invalid_decision');
      setPendingDecision(null);
      setReview(previous => previous && previous.data.authorizationId === result.authorizationId
        ? { code: previous.code, data: { ...previous.data, state: result.state } } : previous);
      const prefix = confirming ? '已確認原裝置操作。' : '';
      setPairNotice(approve
        ? `${prefix}已核准此裝置讀取 bootstrap 狀態。裝置完成配對後，連線會出現在下方列表；這不代表模型執行授權或供應商登入。`
        : `${prefix}已拒絕這次配對請求，裝置不會取得 bootstrap 狀態讀取權。`);
      changed.current?.();
      void loadList();
    } catch (failure) {
      if (!active()) return;
      if (uncertain(failure)) {
        setPendingDecision(command);
        setPairError(`「${approve ? '核准裝置' : '拒絕配對'}」的結果尚未確認。已保留原請求；請先重新讀取配對請求，或由本人確認原裝置操作。`);
      } else {
        setPendingDecision(null);
        if (expiredAccess(failure)) setPairError('登入已過期，這次操作未完成。請重新登入後再讀取配對請求。');
        else if (rejected(failure)) {
          reread = true;
          setPairError('這次操作未被接受：配對請求可能已被處理、已變更，或目前無法由本帳號審核。已重新讀取，請再次確認；不會自動核准。');
        } else if (statusOf(failure) === 429) setPairError('操作過於頻繁，這次未完成。請稍後再讀取配對請求。');
        else { setReview(null); setPairError('這次配對操作未完成。請重新讀取配對請求並再次確認。'); }
      }
    } finally {
      if (active()) { lock.current = false; setBusy(false); }
    }
    if (reread && active()) void inspect(command.body.userCode);
  }

  async function readSelected(id: string) {
    if (!live.current) return;
    const generation = lifetime.current, sequence = ++readSeq.current;
    const fresh = () => live.current && generation === lifetime.current && sequence === readSeq.current;
    setSelectedId(id); setSelected(null); setRevokeConsent(false); setReadState(id ? 'loading' : 'idle');
    if (!id) return;
    try {
      const dto = await device.read(id);
      if (!fresh()) return;
      if (dto.connectionId !== id) throw new Error('invalid_connection');
      setSelected(dto); setReadState('ready'); setNow(Date.now());
      setConnections(previous => previous && previous.map(item => item.connectionId === id ? dto : item));
    } catch (failure) {
      if (!fresh()) return;
      setReadState(readFailure(failure));
    }
  }

  function startRevoke() {
    if (lock.current || !live.current || busy || pendingRevoke || !selected || !revokeConsent || readState !== 'ready') return;
    if (selected.connectionId !== selectedId || selected.state !== 'active') return;
    void runRevoke(Object.freeze({ connectionId: selected.connectionId, expectedVersion: selected.aggregateVersion, key: crypto.randomUUID() }), false);
  }

  async function runRevoke(command: RevokeCommand, confirming: boolean) {
    if (lock.current || !live.current) return;
    lock.current = true;
    const generation = lifetime.current;
    const active = () => live.current && generation === lifetime.current;
    let reread = false;
    setBusy(true); setRevokeConsent(false); setConnError(''); setConnNotice('');
    try {
      const result = await device.revoke(command.connectionId, command.expectedVersion, command.key);
      if (!active()) return;
      if (result.connectionId !== command.connectionId || result.state !== 'revoked') throw new Error('invalid_revoke');
      readSeq.current++;
      setPendingRevoke(null); setSelectedId(result.connectionId); setSelected(result); setReadState('ready');
      setConnections(previous => previous && previous.map(item => item.connectionId === result.connectionId ? result : item));
      setConnNotice(`${confirming ? '已確認原撤銷操作。' : ''}已撤銷這個裝置連線。此連線的 bootstrap 狀態讀取與刷新已失效；已送出的供應商請求不會撤回，裝置上的金鑰也不會被刪除。`);
      changed.current?.();
      void loadList();
    } catch (failure) {
      if (!active()) return;
      if (uncertain(failure)) {
        setPendingRevoke(command);
        setConnError('撤銷結果尚未確認。已保留原請求與版本；請先重新讀取，或由本人確認原撤銷操作。');
      } else {
        setPendingRevoke(null);
        if (expiredAccess(failure)) setConnError('登入已過期，這次撤銷未完成。請重新登入後再讀取裝置連線。');
        else if (rejected(failure)) { reread = true; setConnError('連線版本已變更或目前無法撤銷，這次撤銷未完成。已重新讀取，請再次確認。'); }
        else if (statusOf(failure) === 404) { reread = true; setConnError('找不到這個裝置連線，這次撤銷未完成。已重新讀取列表。'); }
        else if (statusOf(failure) === 429) setConnError('操作過於頻繁，這次撤銷未完成。請稍後再試。');
        else setConnError('這次撤銷未完成。請重新讀取並確認選取的連線。');
      }
    } finally {
      if (active()) { lock.current = false; setBusy(false); }
    }
    if (reread && active()) { void loadList(); void readSelected(command.connectionId); }
  }

  function refreshAll() {
    // Reads only. Unresolved commands stay pending and are never re-submitted here.
    if (!live.current || busy) return;
    setConnError(''); setConnNotice('');
    void loadList();
    if (selectedId) void readSelected(selectedId);
    const target = pendingDecision ? pendingDecision.body.userCode : review?.code;
    if (target && target === code) void inspect(target);
  }

  const reviewed = review && review.code === code ? review.data : null;
  const reviewExpired = reviewed ? Date.parse(reviewed.expiresAt) <= now : false;
  const decisionOpen = Boolean(reviewed && reviewed.state === 'pending' && !reviewExpired && !pendingDecision && !busy && !inspecting);
  const codeValid = DeviceUserCodeSchema.safeParse(code).success;
  const codeLocked = busy || pendingDecision !== null;
  const writable = !busy && pendingRevoke === null;
  const canRevoke = writable && revokeConsent && selected !== null && readState === 'ready'
    && selected.connectionId === selectedId && selected.state === 'active';
  const selectionMissing = Boolean(selectedId && connections && !connections.some(item => item.connectionId === selectedId));
  const closedReview = !reviewed ? ''
    : reviewed.state === 'approved' ? '此配對請求已核准。裝置完成配對後，連線會出現在下方列表。'
    : reviewed.state === 'denied' ? '此配對請求已拒絕。'
    : reviewed.state === 'consumed' ? '此配對請求已由裝置完成，無需再次核准。'
    : reviewExpired ? '這次配對請求已到期。請在裝置上重新開始配對。' : '';
  const listMessage = listState === 'denied' ? '目前帳號無法讀取裝置連線。請確認登入與加入狀態。'
    : listState === 'expired' ? '登入已過期。請重新登入後再讀取裝置連線。'
    : listState === 'not_enabled' ? '此環境尚未提供裝置連線服務。配對審核與模型設定不會因此自動啟用。'
    : listState === 'unavailable' ? '裝置連線目前無法讀取。請稍後按「重新讀取裝置與連線」；不會自動重試。'
    : listState === 'loading' && !connections ? '正在讀取本人的裝置連線…' : '';
  const readMessage = readState === 'loading' ? '正在讀取選取的裝置連線…'
    : readState === 'missing' ? '找不到這個裝置連線，可能已不屬於本人或已移除。請重新讀取。'
    : readState === 'denied' ? '目前帳號無法讀取這個裝置連線。'
    : readState === 'expired' ? '登入已過期。請重新登入後再讀取裝置連線。'
    : readState === 'unavailable' ? '選取的裝置連線目前無法讀取。撤銷前必須先讀到目前版本；請重新讀取。' : '';

  return <section className='card stack device-connections' aria-label='裝置與連線' aria-busy={busy || inspecting || listState === 'loading' || readState === 'loading'}>
    <div className='device-connections-head'>
      <div><h2>裝置與連線</h2><p className='field-hint'>核准配對只允許裝置讀取 bootstrap 狀態；不代表模型執行授權、供應商登入或私人內容存取。</p></div>
      <button type='button' className='btn btn-ghost' disabled={busy} onClick={refreshAll}>重新讀取裝置與連線</button>
    </div>

    <div className='stack device-connections-pairing'>
      <h3>審核裝置配對</h3>
      {pairError && <p role='alert'>{pairError}</p>}
      {pairNotice && <p role='status'>{pairNotice}</p>}
      {pendingDecision && <div className='banner banner-info'>
        <p>原{pendingDecision.body.decision === 'approve' ? '核准' : '拒絕'}請求的結果未知。配對代碼已鎖定；重新讀取不會重送。確認原裝置操作會沿用同一請求內容與冪等鍵，不會自動重試。</p>
        <div className='actions'><button type='button' className='btn btn-ghost' disabled={busy} onClick={() => void runDecision(pendingDecision, true)}>確認原裝置操作</button></div>
      </div>}
      <div className='device-connections-code'>
        <label>裝置配對代碼<input type='text' value={code} maxLength={11} autoComplete='off' autoCapitalize='characters' spellCheck={false}
          placeholder='XXXXX-XXXXX' aria-describedby={hintId} disabled={codeLocked}
          onChange={event => {
            const next = normalizeCode(event.target.value);
            inspectSeq.current++;
            setInspecting(false); setCode(next); setReview(null); setConsent(false); setPairError(''); setPairNotice('');
          }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!busy && !inspecting && codeValid) void inspect(code); } }}/></label>
        <button type='button' className='btn btn-ghost' disabled={busy || inspecting || !codeValid} onClick={() => void inspect(code)}>讀取配對請求</button>
      </div>
      <p id={hintId} className='field-hint'>輸入裝置畫面上的代碼。讀取只顯示請求內容，不會核准或拒絕；修改代碼會清除先前的審核內容與同意。</p>
      {inspecting && <p className='muted'>正在讀取配對請求…</p>}
      {reviewed && <div className='stack device-connections-review'>
        <dl className='device-connections-details'>
          <dt>裝置名稱</dt><dd>{reviewed.clientDisplayName}</dd>
          <dt>用戶端</dt><dd className='device-connections-id'>{reviewed.clientId}</dd>
          <dt>執行類型</dt><dd>{reviewed.runtimeKind}</dd>
          <dt>環境</dt><dd>{reviewed.environment}</dd>
          <dt>金鑰指紋</dt><dd className='device-connections-id'>{reviewed.keyThumbprint}</dd>
          <dt>請求權限</dt><dd>只讀取 bootstrap 狀態（{reviewed.scope}）</dd>
          <dt>到期</dt><dd>{time(reviewed.expiresAt)}{reviewExpired ? ' · 已到期' : ''}</dd>
          <dt>狀態</dt><dd>{REVIEW_LABELS[reviewed.state]}</dd>
        </dl>
        <p className='field-hint'>請比對裝置畫面上的名稱與金鑰指紋。核准只允許讀取 bootstrap 狀態，不包含模型執行、供應商登入或私人內容存取。</p>
        {closedReview ? <p className='muted'>{closedReview}</p> : <>
          <label className='device-connections-consent'><input type='checkbox' checked={consent} disabled={!decisionOpen} onChange={event => setConsent(event.target.checked)}/><span>我確認這是我正在配對的裝置，並核准讀取 bootstrap 狀態。</span></label>
          <div className='actions'>
            <button type='button' className='btn btn-primary' disabled={!decisionOpen || !consent} onClick={() => startDecision('approve')}>核准裝置</button>
            <button type='button' className='btn btn-ghost' disabled={!decisionOpen} onClick={() => startDecision('deny')}>拒絕配對</button>
          </div>
        </>}
      </div>}
    </div>

    <div className='stack device-connections-section'>
      <h3>本人的裝置連線</h3>
      {connError && <p role='alert'>{connError}</p>}
      {connNotice && <p role='status'>{connNotice}</p>}
      {pendingRevoke && <div className='banner banner-info'>
        <p>原撤銷請求的結果未知。重新讀取不會重送；確認原撤銷操作會沿用同一連線、版本與冪等鍵，不會自動重試。</p>
        <div className='actions'><button type='button' className='btn btn-ghost' disabled={busy} onClick={() => void runRevoke(pendingRevoke, true)}>確認原撤銷操作</button></div>
      </div>}
      {listMessage && <p className={listState === 'loading' ? 'muted' : 'banner banner-info'}>{listMessage}</p>}
      {connections && connections.length === 0 && listState === 'ready' && <p className='muted'>目前沒有本人的裝置連線。核准配對且裝置完成連線後，會顯示在這裡。</p>}
      {connections && connections.length > 0 && <>
        <p className='field-hint'>共 {connections.length} 筆{listState === 'loading' ? ' · 更新中…' : ''}。「已到期」依本機時間推算，僅供參考；實際效力以伺服器紀錄為準。</p>
        <ul className='device-connections-list'>
          {connections.map((item, index) => <li key={item.connectionId}>
            <strong>{connectionLabel(item, now)}</strong>
            <span className='device-connections-id'>{`連線 ${index + 1} · ${item.clientId} · ${item.environment}`}</span>
            <span className='field-hint'>{`建立 ${time(item.issuedAt)} · 到期 ${time(item.expiresAt)}`}</span>
          </li>)}
        </ul>
        <label>管理的裝置連線<select value={selectedId} disabled={busy || pendingRevoke !== null} onChange={event => void readSelected(event.target.value)}>
          <option value=''>選擇一筆裝置連線</option>
          {selectionMissing && <option value={selectedId}>目前選取的連線（不在最新列表）</option>}
          {connections.map((item, index) => <option key={item.connectionId} value={item.connectionId}>{`連線 ${index + 1} · ${connectionLabel(item, now)} · 到期 ${time(item.expiresAt)}`}</option>)}
        </select></label>
        {readMessage && <p className={readState === 'loading' ? 'muted' : 'field-hint'}>{readMessage}</p>}
        {selected && readState === 'ready' && <>
          <dl className='device-connections-details'>
            <dt>狀態</dt><dd>{connectionLabel(selected, now)}</dd>
            <dt>連線識別</dt><dd className='device-connections-id'>{selected.connectionId}</dd>
            <dt>裝置識別</dt><dd className='device-connections-id'>{selected.runtimeDeviceId}</dd>
            <dt>用戶端</dt><dd className='device-connections-id'>{selected.clientId}</dd>
            <dt>環境</dt><dd>{selected.environment}</dd>
            <dt>建立</dt><dd>{time(selected.issuedAt)}</dd>
            <dt>到期</dt><dd>{time(selected.expiresAt)}</dd>
          </dl>
          {selected.state === 'active' ? <div className='stack device-connections-revoke'>
            <p className='field-hint'>撤銷後，此連線的 bootstrap 狀態讀取與刷新會失效；已送出的供應商請求不會因此撤回。這個操作不會刪除裝置上的金鑰。</p>
            <label className='device-connections-consent'><input type='checkbox' checked={revokeConsent} disabled={!writable} onChange={event => setRevokeConsent(event.target.checked)}/><span>我確認撤銷目前選取的裝置連線。</span></label>
            <div className='actions'><button type='button' className='btn btn-ghost' disabled={!canRevoke} onClick={startRevoke}>撤銷裝置連線</button></div>
          </div> : <p className='field-hint'>此連線已撤銷，不能再讀取或刷新 bootstrap 狀態。撤銷不會刪除裝置上的金鑰。</p>}
        </>}
      </>}
    </div>

    <p className='field-hint'>裝置連線紀錄不代表機器已通過驗證，也不授權模型執行或供應商登入。模型服務無法使用時，仍可在這裡審核配對與撤銷連線。</p>
  </section>;
}
