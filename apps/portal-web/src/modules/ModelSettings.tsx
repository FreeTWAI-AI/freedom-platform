import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type PortalClient } from '../api';
import { ModelConnectionMetadataSchema, type ModelConnectionMetadata, type ModelSelection } from '../../../../contracts/execution/v1/member-execution';
import { ModelCredentialMetadataSchema, type ModelCredentialMetadata } from '../../../../contracts/execution/v2/model-credential';
import { MemberModelSettingsOverviewSchema, type MemberModelSettingsOverview } from '../../../../contracts/execution/v2/member-model-settings';
import { CredentialIngestHandoffSchema, CredentialIngestOwnerOutcomeSchema } from '../../../../contracts/execution/v2/model-credential-ingest';
import './ModelSettings.css';

type Command = { kind: 'model' | 'revoke' | 'handoff'; label: string; path: string; body: unknown; version: string; key: string;
  setupOrigin?: string; operation?: 'create' | 'rotate' };
const modelLabel = (selection: ModelSelection) => `${selection.providerRef} / ${selection.modelRef}`;
const time = (value: string) => new Date(value).toLocaleString('zh-TW');
const sameSelection = (a: ModelSelection, b: ModelSelection) => JSON.stringify(a) === JSON.stringify(b);
const credentialState = (value: ModelCredentialMetadata, now: number) => value.state === 'rotated' ? '已輪替'
  : value.state === 'revoked' ? '已撤銷' : Date.parse(value.expiresAt) <= now ? '已到期' : '已保管 · 尚未驗證';
function setupOrigin(value: string): string {
  if (/[?#%\\\x00-\x20\x7f-\uffff]/.test(value)) throw new Error('invalid_setup');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password
    || url.hostname === window.location.hostname || window.location.protocol !== 'https:') throw new Error('invalid_setup');
  return url.origin;
}
const uncertain = (error: unknown) => !(error instanceof ApiError) || error.network || error.timedOut || error.status >= 500;

/** Owner metadata and unresolved command identities remain in this component.
 * A broker assertion is used once for navigation, never rendered or persisted. */
export function ModelSettings({ client }: { client: PortalClient }) {
  const [overview, setOverview] = useState<MemberModelSettingsOverview | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Command | null>(null);
  const [connectionId, setConnectionId] = useState(''), [selectionIndex, setSelectionIndex] = useState('');
  const [modelId, setModelId] = useState(''), [credentialId, setCredentialId] = useState(''), [replacementId, setReplacementId] = useState('');
  const [modelConsent, setModelConsent] = useState(false), [captureConsent, setCaptureConsent] = useState(false);
  const [rotateConsent, setRotateConsent] = useState(false), [revokeConsent, setRevokeConsent] = useState(false);
  const [credentialLoading, setCredentialLoading] = useState(false), [confirmedCredential, setConfirmedCredential] = useState('');
  const [now, setNow] = useState(Date.now);
  const live = useRef(false), lifetime = useRef(0), reading = useRef(0), lock = useRef(false);
  const current = useRef(overview); current.current = overview;
  const ownerRef = useRef<string | null>(null), handed = useRef(new Set<string>());
  const credentialReading = useRef(0);
  const resetConsent = () => { setModelConsent(false); setCaptureConsent(false); setRotateConsent(false); setRevokeConsent(false); };

  const refresh = useCallback(async () => {
    const generation = lifetime.current, sequence = ++reading.current, ref = ownerRef.current;
    credentialReading.current++; setCredentialLoading(false); setConfirmedCredential(''); setCredentialId(''); setReplacementId(''); setRotateConsent(false);
    setLoading(true); setError('');
    const results = await Promise.allSettled([
      client.get<unknown>('/me/model-settings', { background: true }),
      ref ? client.get<unknown>(`/me/credential-ingests/${ref}`, { background: true }) : Promise.resolve(null),
    ]);
    if (!live.current || generation !== lifetime.current || sequence !== reading.current) return;
    try {
      if (results[0].status !== 'fulfilled') throw new Error('unavailable');
      const dto = MemberModelSettingsOverviewSchema.parse(results[0].value);
      // Installation metadata is not capture readiness or model authentication.
      if (dto.setup.state === 'installed') setupOrigin(dto.setup.setupOrigin);
      setOverview(dto); setNow(Date.now());
      if (ref) {
        if (results[1].status !== 'fulfilled') setNotice('保管結果尚未確認。請稍後由本人重新讀取設定。');
        else {
          const outcome = CredentialIngestOwnerOutcomeSchema.parse(results[1].value);
          if (outcome.authorizationRef !== ref) throw new Error('invalid_outcome');
          setNotice(outcome.state === 'committed' ? '已讀取本人的保管紀錄；供應商登入與模型可用性仍未驗證。'
            : '尚未讀到已完成的保管紀錄。這次設定不會自動重送。');
        }
      }
    } catch { setOverview(null); setError('模型與憑證設定目前無法讀取。請由本人重新讀取；不會自動開始設定。'); }
    setLoading(false);
  }, [client]);
  useEffect(() => {
    // A different client starts a new memory context. Old requests still retain
    // their lifetime fence and cannot update or navigate the replacement view.
    live.current = true; lock.current = false; current.current = null;
    setBusy(false); setPending(null); setOverview(null); setError(''); setNotice('');
    setConnectionId(''); setSelectionIndex(''); setModelId(''); setCredentialId(''); setReplacementId('');
    setConfirmedCredential(''); setCredentialLoading(false);
    setModelConsent(false); setCaptureConsent(false); setRotateConsent(false); setRevokeConsent(false);
    void refresh();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { live.current = false; lifetime.current++; reading.current++; ownerRef.current = null; handed.current.clear(); window.clearInterval(timer); };
  }, [refresh]);

  async function submit(command: Command, confirming = false) {
    if (lock.current || !live.current) return;
    lock.current = true; const generation = lifetime.current;
    const active = () => live.current && lifetime.current === generation;
    setBusy(true); setError(''); setNotice(''); resetConsent();
    try {
      const raw = await client.post<unknown>(command.path, command.body, { idempotencyKey: command.key, ifMatch: command.version, suppressConsole: true });
      if (!active()) return;
      if (command.kind === 'handoff') {
        const dto = CredentialIngestHandoffSchema.parse(raw), setup = current.current?.setup;
        const pinned = command.setupOrigin && setupOrigin(command.setupOrigin), expiry = Date.parse(dto.expiresAt), clock = Date.now();
        if (!pinned || dto.setupOrigin !== pinned) throw new Error('invalid_handoff');
        ownerRef.current = dto.authorizationRef;
        // Confirmation after an uncertain response reads the original command;
        // it never re-submits a previously used setup or starts navigation.
        if (confirming) {
          setPending(null); setNotice('已確認原設定請求。請重新讀取本人保管結果；這次設定不會再次送往保管頁。');
          await refresh(); return;
        }
        if (setup?.state !== 'installed' || setupOrigin(setup.setupOrigin) !== pinned || expiry <= clock || expiry > clock + 60_000
          || handed.current.has(dto.authorizationRef) || handed.current.size >= 128) throw new Error('invalid_handoff');
        handed.current.add(dto.authorizationRef); setPending(null);
        setNotice('即將前往金鑰保管頁。返回後請重新讀取本人設定；保管不代表模型已驗證。');
        const form = document.createElement('form'), field = document.createElement('input');
        form.method = 'POST'; form.action = pinned + '/credential-setup'; form.target = '_self';
        form.enctype = 'application/x-www-form-urlencoded'; form.hidden = true;
        field.type = 'hidden'; field.name = 'assertion'; field.value = dto.assertion; form.append(field);
        document.body.append(form);
        try { HTMLFormElement.prototype.submit.call(form); }
        finally { field.value = ''; form.remove(); }
      } else {
        const model = ModelConnectionMetadataSchema.parse(raw);
        if (command.kind === 'model') {
          const requested = command.body as {connectionId:string;selection:ModelSelection};
          if (model.connectionId !== requested.connectionId || !sameSelection(model.selection, requested.selection) || model.state !== 'unverified') throw new Error('invalid_model');
        }
        if (command.kind === 'revoke' && (model.modelConnectionId !== command.path.split('/').at(-1)?.split(':')[0] || model.state !== 'revoked')) throw new Error('invalid_model');
        setPending(null); setModelId(model.modelConnectionId);
        setNotice(command.kind === 'revoke' ? '模型設定已撤銷。金鑰仍由保管服務保存；這個操作不刪除金鑰。' : '模型設定已建立，尚未驗證。請選取設定，再明確同意前往金鑰保管頁。');
        await refresh();
      }
    } catch (failure) {
      if (!active()) return;
      if (uncertain(failure)) { setPending(command); setError(`${command.label}的結果尚未確認。已保留原請求與版本；請先重新讀取，或由本人確認原請求。`); }
      else { setPending(null); setError(failure instanceof ApiError && failure.conflict ? '設定版本已變更。請重新讀取並再次確認選擇。' : '這次設定未完成。請重新讀取並確認本人連線、同意與設定狀態。'); }
    } finally {
      if (active()) { lock.current = false; setBusy(false); }
    }
  }
  const models = overview?.models ?? [], credentials = overview?.credentials ?? [], options = overview?.selectionOptions ?? [];
  const connection = overview?.connections.find(value => value.connectionId === connectionId);
  const selection = selectionIndex === '' ? undefined : options[Number(selectionIndex)];
  const model = models.find(value => value.modelConnectionId === modelId), credential = credentials.find(value => value.credentialId === credentialId);
  const modelCredentials = model ? credentials.filter(value => value.modelConnectionId === model.modelConnectionId) : [];
  const replacement = models.find(value => value.modelConnectionId === replacementId);
  const installed = overview?.setup.state === 'installed';
  const disabled = busy || loading || credentialLoading || Boolean(pending), activeConnection = connection?.state === 'active' && Date.parse(connection.expiresAt) > now;
  const available = (value: ModelConnectionMetadata) => value.state === 'unverified' && options.some(option => sameSelection(option, value.selection));
  const candidates = models.filter(value => available(value) && !credentials.some(item => item.modelConnectionId === value.modelConnectionId)
    && value.modelConnectionId !== credential?.modelConnectionId);
  const canCapture = installed && model && available(model) && modelCredentials.length === 0;
  const canRotate = installed && confirmedCredential === credentialId && credential?.state === 'active' && Date.parse(credential.expiresAt) > now
    && models.some(value => value.modelConnectionId === credential.modelConnectionId && value.state === 'unverified')
    && replacement && candidates.some(value => value.modelConnectionId === replacement.modelConnectionId);
  const issue = (operation: 'create' | 'rotate') => {
    const setup = overview?.setup;
    if (setup?.state !== 'installed' || (operation === 'create' ? !canCapture || !captureConsent : !canRotate || !rotateConsent)) return;
    const body = operation === 'create' ? { operation, modelConnectionId: model!.modelConnectionId, consent: true }
      : { operation, credentialId: credential!.credentialId, replacementModelConnectionId: replacement!.modelConnectionId,
        expectedReplacementModelVersion: replacement!.aggregateVersion, consent: true };
    void submit({ kind: 'handoff', operation, label: operation === 'create' ? '金鑰保管設定' : '金鑰輪替設定', path: '/me/credential-ingests', body,
      version: operation === 'create' ? model!.aggregateVersion : credential!.aggregateVersion, key: crypto.randomUUID(), setupOrigin: setup.setupOrigin });
  };
  async function readCredential(id: string) {
    const generation = lifetime.current, sequence = ++credentialReading.current, expected = id;
    setCredentialId(id); setRotateConsent(false); setReplacementId(''); setConfirmedCredential(''); setCredentialLoading(Boolean(id));
    if (!id) return;
    try {
      const dto = ModelCredentialMetadataSchema.parse(await client.get<unknown>(`/me/model-credentials/${id}`, { background: true }));
      if (!live.current || generation !== lifetime.current || sequence !== credentialReading.current) return;
      if (dto.credentialId !== expected) throw new Error('invalid_credential');
      setOverview(previous => previous && { ...previous, credentials: previous.credentials.map(value => value.credentialId === id ? dto : value) });
      setConfirmedCredential(id);
    } catch { if (live.current && generation === lifetime.current && sequence === credentialReading.current) setError('這筆本人憑證紀錄目前無法讀取。請重新讀取設定。'); }
    finally { if (live.current && generation === lifetime.current && sequence === credentialReading.current) setCredentialLoading(false); }
  }

  return <section className="card stack model-settings" aria-label="模型與憑證設定" aria-busy={loading || busy}>
    <div className="model-settings-head"><div><h2>模型與憑證設定</h2><p className="field-hint">金鑰只在獨立保管頁輸入。已保管不代表供應商登入或模型可用；費用仍未知。</p></div>
      <button type="button" className="btn btn-ghost" disabled={busy || loading} onClick={() => void refresh()}>{loading ? '讀取設定中…' : '重新讀取模型設定'}</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {pending && <div className="banner banner-info"><p>原請求的結果未知。重新讀取不會重送；確認原請求會沿用同一請求與版本，不再導向已使用的保管頁。</p>
      <div className="actions"><button type="button" className="btn btn-ghost" disabled={busy || loading} onClick={() => void submit(pending, true)}>確認原設定請求</button></div></div>}
    {!overview ? <p className="muted">{loading ? '正在讀取本人模型與憑證紀錄…' : '設定服務尚未可用。金鑰保管與模型執行不會自動啟用。'}</p> : <>
      {!installed && <p className="banner banner-info">金鑰保管入口尚未安裝。仍可讀取既有紀錄或撤銷模型設定。</p>}
      {options.length === 0 && <p className="field-hint">目前沒有安裝可選的供應商與模型目錄，無法新增保管設定。</p>}
      <details className="model-settings-create"><summary>新增模型設定</summary><div className="stack">
        <div className="model-settings-fields"><label>設定的執行連線<select value={connectionId} disabled={disabled || !installed || !options.length} onChange={event => { setConnectionId(event.target.value); resetConsent(); }}><option value="">請選擇本人的有效連線</option>
          {overview.connections.filter(value => value.state === 'active' && Date.parse(value.expiresAt) > now).map((value, index) => <option key={value.connectionId} value={value.connectionId}>連線 {index + 1} · 到期 {time(value.expiresAt)}</option>)}</select></label>
          <label>設定的供應商與模型<select value={selectionIndex} disabled={disabled || !installed || !options.length} onChange={event => { setSelectionIndex(event.target.value); resetConsent(); }}><option value="">請明確選擇模型</option>{options.map((value, index) => <option key={index} value={index}>{modelLabel(value)}</option>)}</select></label></div>
        {selection && <SelectionDetails selection={selection}/>}
        <label className="model-settings-consent"><input type="checkbox" checked={modelConsent} disabled={disabled || !activeConnection || !selection || !installed} onChange={event => setModelConsent(event.target.checked)}/><span>我確認保存以上連線與模型選擇；這不代表模型已登入或可執行。</span></label>
        <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || !modelConsent || !activeConnection || !selection || !installed} onClick={() => void submit({kind:'model',label:'模型設定建立',path:'/me/model-connections',body:{connectionId,selection},version:connection!.aggregateVersion,key:crypto.randomUUID()})}>建立模型設定</button></div>
        {!overview.connections.some(value => value.state === 'active' && Date.parse(value.expiresAt) > now) && <p className="field-hint">目前沒有有效的本人配對連線。需先完成連線設定，不能以模型紀錄代替。</p>}
      </div></details>
      <div className="model-settings-columns">
        <div className="stack"><h3>模型選擇與保管</h3><label>管理的模型設定<select value={modelId} disabled={disabled} onChange={event => { setModelId(event.target.value); resetConsent(); }}><option value="">選擇一筆模型設定</option>{models.map((value, index) => <option key={value.modelConnectionId} value={value.modelConnectionId}>{modelLabel(value.selection)} · {value.state === 'revoked' ? '已撤銷' : '尚未驗證'} · 紀錄 {index + 1}</option>)}</select></label>
          {model ? <><SelectionDetails selection={model.selection}/><p className="field-hint">{model.state === 'revoked' ? '模型設定已撤銷' : '模型尚未驗證'} · 建立於 {time(model.createdAt)}</p>
            {modelCredentials.length > 0 ? <ul className="model-settings-history">{modelCredentials.map(value => <li key={value.credentialId}><strong>{credentialState(value, now)}</strong><span>第 {value.generation} 代 · 到期 {time(value.expiresAt)}</span></li>)}</ul> : <p className="muted">目前列表尚無此模型的憑證紀錄。</p>}
            {model.state === 'revoked' && modelCredentials.some(value => value.state === 'active') && <p className="field-hint">模型已撤銷，金鑰仍保管。撤銷模型不會刪除金鑰。</p>}
            {canCapture && <><label className="model-settings-consent"><input type="checkbox" checked={captureConsent} disabled={disabled} onChange={event => setCaptureConsent(event.target.checked)}/><span>我同意為 {modelLabel(model.selection)} 前往獨立保管頁，另行輸入金鑰並確認加密保管。</span></label>
              <div className="actions"><button type="button" className="btn btn-primary" disabled={disabled || !captureConsent} onClick={() => issue('create')}>前往金鑰保管頁</button></div></>}
            {model.state === 'unverified' && <details className="model-settings-revoke"><summary>撤銷這個模型設定</summary><div className="stack"><p className="field-hint">會阻止此模型後續的平台操作與同意使用；已送出的供應商請求可能仍在處理。金鑰仍保管，不會被刪除。</p>
              <label className="model-settings-consent"><input type="checkbox" checked={revokeConsent} disabled={disabled} onChange={event => setRevokeConsent(event.target.checked)}/><span>我確認撤銷目前選取的模型設定。</span></label>
              <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || !revokeConsent} onClick={() => void submit({kind:'revoke',label:'模型設定撤銷',path:`/me/model-connections/${model.modelConnectionId}:revoke`,body:{},version:model.aggregateVersion,key:crypto.randomUUID()})}>撤銷模型設定</button></div></div></details>}
          </> : <p className="muted">選擇模型設定後查看保管紀錄；推論仍需另外確認單次同意。</p>}
        </div>
        <div className="stack"><h3>憑證歷史與輪替</h3><label>原憑證紀錄<select value={credentialId} disabled={disabled} onChange={event => void readCredential(event.target.value)}><option value="">選擇本人憑證紀錄</option>{credentials.map((value, index) => <option key={value.credentialId} value={value.credentialId}>{modelLabel(value.selection)} · {credentialState(value, now)} · 紀錄 {index + 1}</option>)}</select></label>
          {credential ? <><p role="status">{credentialState(credential, now)} · 第 {credential.generation} 代</p><p className="field-hint">{modelLabel(credential.selection)} · 保管於 {time(credential.issuedAt)} · 到期 {time(credential.expiresAt)}</p>
            {credential.terminalAt && <p className="field-hint">終止於 {time(credential.terminalAt)}</p>}
            {credential.state === 'active' && Date.parse(credential.expiresAt) > now && <>
              <label>輪替後的模型設定<select value={replacementId} disabled={disabled || !installed} onChange={event => { setReplacementId(event.target.value); setRotateConsent(false); }}><option value="">請選擇新的模型設定</option>{candidates.map((value, index) => <option key={value.modelConnectionId} value={value.modelConnectionId}>{modelLabel(value.selection)} · 新設定 {index + 1}</option>)}</select></label>
              {!candidates.length && <p className="field-hint">請先在「新增模型設定」建立新的替換設定。原模型選擇不會被改寫。</p>}
              {replacement && <SelectionDetails selection={replacement.selection}/>}
              <p className="field-hint">保管完成後，原憑證與原模型會終止；舊的模型同意與推論不能改用新憑證。</p>
              <label className="model-settings-consent"><input type="checkbox" checked={rotateConsent} disabled={disabled || !canRotate} onChange={event => setRotateConsent(event.target.checked)}/><span>我確認以選取的新模型設定輪替原憑證，並前往獨立保管頁另行確認。</span></label>
              <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || !canRotate || !rotateConsent} onClick={() => issue('rotate')}>前往金鑰輪替頁</button></div>
            </>}
          </> : <p className="muted">憑證歷史可獨立讀取，不需選擇工作或開放私人內容儲存。</p>}
        </div>
      </div>
      <p className="field-hint">各類紀錄最多顯示 {overview.limit} 筆。從保管頁返回後，請按「重新讀取模型設定」確認本人紀錄；不會自動重送設定或推論。</p>
    </>}
  </section>;
}
function SelectionDetails({ selection }: { selection: ModelSelection }) {
  const custody = selection.credentialCustody === 'platform_vault' ? '平台加密保管 · 本人金鑰／本人付費'
    : selection.credentialCustody === 'official_cli' ? '官方 CLI 保管 · 本人訂閱' : '本機鑰匙圈 · 本人金鑰／本人付費';
  const processing = selection.processingLocation === 'provider_remote' ? '供應商端（遠端）'
    : selection.processingLocation === 'runtime_local' ? '執行裝置' : selection.processingLocation;
  return <dl className="model-settings-details"><dt>供應商／模型</dt><dd>{modelLabel(selection)}</dd><dt>處理位置</dt><dd>{processing}</dd>
    <dt>金鑰與費用</dt><dd>{custody}</dd></dl>;
}
