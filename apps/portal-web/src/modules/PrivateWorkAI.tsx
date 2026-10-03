import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type PortalClient } from '../api';
import type { ModelSelection, ModelConnectionMetadata, ExecutionGrantMetadata } from '../../../../contracts/execution/v1/member-execution';
import type { MemberModelHttpOverview } from '../../../../contracts/execution/v2/member-model-http';
import type { ModelStepApprovalMetadata, ModelStepMetadata } from '../../../../contracts/execution/v2/model-step';
import './PrivateWorkAI.css';

type Work = { work_item_id: string; title: string; objective: string; state: string; aggregate_version: number | string };
type Run = { runId: string; workId: string; inputWorkVersion: string; aggregateVersion: string; state: string };
type Overview = MemberModelHttpOverview;
type Result = { resultId: string; revision: string; workVersion: string; createdAt: string; provenance: 'human' | 'model'; text?: string;
  model?: { selection: ModelSelection; evidenceOrigin: string; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; costStatus: 'unknown' } };
type Command = { label: string; path: string; body: unknown; version?: number | string; key: string; accepted?: (value: unknown) => void };
const label = (selection: ModelSelection) => `${selection.providerRef} / ${selection.modelRef}`;
const time = (value: string) => new Date(value).toLocaleString('zh-TW');
const stateLabels: Record<string, string> = { created: '已建立', paused: '已暫停', cancelled: '已停止', running: '執行中',
  reserved: '已啟用，尚未送出', dispatched: '已送出', awaiting_result: '等待成果', outcome_unknown: '結果未確認', succeeded: '已完成',
  active: '有效', revoked: '已撤銷', unverified: '尚未驗證', connected: '已配對', reconciling: '確認中', draft: '草稿' };
const status = (value: string) => stateLabels[value] ?? value;
const terminal = (step: ModelStepMetadata) => ['succeeded', 'cancelled', 'outcome_unknown'].includes(step.state);
const matching = (a: ModelSelection, b: ModelSelection) => JSON.stringify(a) === JSON.stringify(b);

/** Private content, CSRF and unresolved command keys stay in memory only. Every
 * replay is member-initiated and preserves the original body, key and CAS. */
export function PrivateWorkAI({ client }: { client: PortalClient }) {
  const [works, setWorks] = useState<Work[] | null>(null), [workId, setWorkId] = useState('');
  const [work, setWork] = useState<Work | null>(null), [overview, setOverview] = useState<Overview | null>(null);
  const [title, setTitle] = useState(''), [objective, setObjective] = useState('');
  const [creating, setCreating] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [serviceError, setServiceError] = useState(''), [resultError, setResultError] = useState(''), [notice, setNotice] = useState('');
  const [history, setHistory] = useState<Result[]>([]), [result, setResult] = useState<Result | null>(null);
  const [runId, setRunId] = useState(''), [connectionId, setConnectionId] = useState(''), [modelId, setModelId] = useState(''), [selectionIndex, setSelectionIndex] = useState('');
  const [grantId, setGrantId] = useState(''), [approvalId, setApprovalId] = useState(''), [stepId, setStepId] = useState('');
  const [grantConsent, setGrantConsent] = useState(false), [exportConsent, setExportConsent] = useState(false), [tokens, setTokens] = useState('256');
  const [unresolved, setUnresolved] = useState<Command | null>(null);
  const lock = useRef(false), live = useRef(true), readSequence = useRef(0), workGeneration = useRef(0), resultSequence = useRef(0), selectedWork = useRef(workId);
  selectedWork.current = workId;
  const disabled = busy || loading || Boolean(unresolved);

  useEffect(() => { live.current = true; return () => { live.current = false; readSequence.current++; workGeneration.current++; }; }, []);
  const readWork = useCallback(async (id: string) => {
    const sequence = ++workGeneration.current; resultSequence.current++;
    setWork(null); setHistory([]); setResult(null); setResultError(''); setExportConsent(false);
    if (!id) return;
    const values = await Promise.allSettled([
      client.get<Work>(`/me/private-work/${id}`, { background: true }),
      client.get<{ items: Result[] }>(`/me/private-work/${id}/results`, { background: true }),
      client.get<Result | null>(`/me/private-work/${id}/results/current`, { background: true }),
    ]);
    if (!live.current || sequence !== workGeneration.current || selectedWork.current !== id) return;
    if (values[0].status === 'fulfilled') { setWork(values[0].value); setTitle(values[0].value.title); setObjective(values[0].value.objective); }
    else setError('私人工作暫時無法讀取，請重新整理。');
    if (values[1].status === 'fulfilled') setHistory(values[1].value.items);
    if (values[2].status === 'fulfilled') setResult(values[2].value);
    if (values[1].status === 'rejected' || values[2].status === 'rejected') setResultError('成果暫時無法讀取，請重新整理；不代表成果不存在。');
  }, [client]);
  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current; setLoading(true); setServiceError('');
    const values = await Promise.allSettled([
      client.get<{ items: Work[] }>('/me/private-work', { background: true }),
      client.get<Overview>('/me/model-step-overview', { background: true }),
    ]);
    if (!live.current || sequence !== readSequence.current) return;
    if (values[0].status === 'fulfilled') setWorks(values[0].value.items);
    else { setWorks(null); setError('私人工作服務目前無法使用，請稍後重新整理。'); }
    if (values[1].status === 'fulfilled') { setOverview(values[1].value); if (!values[1].value.persistenceAvailable) { workGeneration.current++; resultSequence.current++; setWork(null); setResult(null); setHistory([]); setTitle(''); setObjective(''); setCreating(false); setExportConsent(false); setGrantConsent(false); setWorks([]); } }
    else { setOverview(null); setServiceError('模型執行服務目前無法使用。尚未確認供應商登入、模型可用性或費用。'); }
    if (values[1].status !== 'fulfilled' || values[1].value.persistenceAvailable) await readWork(selectedWork.current);
    if (live.current && sequence === readSequence.current) setLoading(false);
  }, [client, readWork]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setRunId(''); setGrantId(''); setApprovalId(''); setStepId(''); setGrantConsent(false); setExportConsent(false);
    setWork(null); setHistory([]); setResult(null); setError(''); setNotice('');
    if (!workId) { setTitle(''); setObjective(''); return; }
    setCreating(false); void readWork(workId);
  }, [workId, readWork]);
  useEffect(() => { setGrantConsent(false); setExportConsent(false); }, [runId, modelId, connectionId, grantId, tokens, approvalId]);

  async function submit(command: Command) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    let succeeded = false;
    try {
      const value = await client.post(command.path, command.body, { idempotencyKey: command.key, ifMatch: command.version, suppressConsole: true });
      succeeded = true;
      if (!live.current) return;
      setUnresolved(null); command.accepted?.(value); setNotice(`${command.label}已保存。`);
      await refresh();
    } catch (cause) {
      if (!live.current) return;
      if (!succeeded && cause instanceof ApiError && (cause.network || cause.timedOut)) {
        setUnresolved(command); setError('尚未確認這次操作結果。先重新讀取狀態；需要補送時，使用下方「以原請求確認結果」。不會自動再次呼叫模型。');
      } else if (cause instanceof ApiError && cause.conflict) {
        setUnresolved(null); setExportConsent(false); setGrantConsent(false); setError('資料版本已更新，請重新讀取，再確認目前內容與模型。');
      } else { setUnresolved(null); setError(succeeded ? '操作已保存，但狀態暫時無法讀取。請重新整理。' : '操作未完成。請重新讀取狀態後確認權限、配對與目前政策。'); }
    } finally { lock.current = false; if (live.current) setBusy(false); }
  }
  function command(labelText: string, path: string, body: unknown, version?: number | string, accepted?: Command['accepted']) {
    if (disabled) return; void submit({ label: labelText, path, body, version, accepted, key: crypto.randomUUID() });
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (!title.trim() || !objective.trim()) return;
    const body = { title: title.trim(), objective: objective.trim() };
    if (creating) command('私人工作', '/me/private-work', body, undefined, value => {
      const saved = value as { workId: string }; selectedWork.current = saved.workId; setWorkId(saved.workId); setCreating(false);
    });
    else if (work) command('工作修改', `/me/private-work/${workId}/edit`, body, work.aggregate_version);
  }
  const runs = overview?.runs.filter(value => value.workId === workId) ?? [];
  const run = runs.find(value => value.runId === runId);
  const models = overview?.models.filter(value => value.state !== 'revoked') ?? [];
  const model = models.find(value => value.modelConnectionId === modelId);
  const connection = overview?.connections.find(value => value.connectionId === connectionId);
  const grants = overview?.grants.filter(value => value.workId === workId && value.runId === runId) ?? [];
  const grant = grants.find(value => value.grantId === grantId);
  const approvals = overview?.approvals.filter(value => value.workId === workId && value.runId === runId) ?? [];
  const approval = approvals.find(value => value.approvalId === approvalId);
  const steps = overview?.steps.filter(value => value.workId === workId && value.runId === runId) ?? [];
  const step = steps.find(value => value.stepId === stepId);
  const selections = overview?.allowedSelections ?? [];
  const allowed = grant ? selections.find(value => matching(value.selection, grant.selection)) : undefined;
  const maxTokens = allowed?.maxOutputTokens;
  const tokenValue = Number(tokens);
  const tokensValid = maxTokens !== undefined && Number.isInteger(tokenValue) && tokenValue >= 1 && tokenValue <= maxTokens;
  const workIsCurrent = work && run?.inputWorkVersion === String(work.aggregate_version);
  const dirty = work && (title !== work.title || objective !== work.objective);
  const selectable = overview?.configuration === 'configured';

  return <section className="module-panel stack private-ai-panel" aria-label="私人工作與模型推論">
    <div className="actions private-ai-toolbar"><p className="muted">私人工作與成果只有本人可讀；每次模型推論需確認送出的內容。</p>
      <button type="button" className="btn btn-ghost" disabled={busy || loading} onClick={() => void refresh()}>{loading ? '讀取中…' : '重新讀取狀態'}</button>
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {unresolved && <div className="banner banner-info"><p>{unresolved.label}的結果尚未確認；補送沿用同一請求與原版本。</p><div className="actions">
      <button type="button" className="btn btn-ghost" disabled={busy || loading} onClick={() => void submit(unresolved)}>以原請求確認結果</button>
    </div></div>}
    <div className="private-ai-grid">
      <section className="card stack"><h2>建立與編輯工作</h2>
        {works === null ? <p role="status">{loading ? '正在讀取私人工作…' : '私人工作服務尚未可用。'}</p> : <>
          <label>選擇私人工作<select value={workId} disabled={disabled} onChange={event => setWorkId(event.target.value)}><option value="">選擇一份工作</option>{works.map(value => <option key={value.work_item_id} value={value.work_item_id}>{value.title} · {status(value.state)}</option>)}</select></label>
          <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || overview?.persistenceAvailable === false} onClick={() => { setWorkId(''); setWork(null); setTitle(''); setObjective(''); setCreating(true); setNotice(''); }}>新增私人工作</button></div>
          {(creating || work) && <form className="stack" onSubmit={save}><label>工作標題<input value={title} maxLength={120} required disabled={disabled} onChange={event => setTitle(event.target.value)}/></label>
            <label>工作目標<textarea value={objective} maxLength={4000} rows={5} required disabled={disabled} onChange={event => setObjective(event.target.value)}/></label>
            {dirty && <p className="field-hint">修改尚未保存。模型確認使用伺服器上已保存的標題與目標。</p>}
            <div className="actions"><button type="submit" className="btn btn-primary" disabled={disabled || !title.trim() || !objective.trim() || (!creating && !dirty)}>{creating ? '建立私人工作' : '保存修改'}</button></div>
          </form>}
          {works.length === 0 && !creating && <p className="muted">尚未建立私人工作。</p>}
        </>}
      </section>
      <section className="card stack"><h2>目前成果與歷史</h2>
        {!workId ? <p className="muted">選擇工作後查看本人可讀的成果。</p> : <>
          {resultError && <p role="alert">{resultError}</p>}
          {!result && !resultError && <p className="muted">尚無目前成果。</p>}
          {result && <><ResultDetails result={result}/><pre className="private-ai-text">{result.text}</pre></>}
          {history.length > 0 && <label>成果版本<select disabled={busy || loading} value={result?.resultId ?? ''} onChange={event => {
            const id = event.target.value, generation = workGeneration.current, resultRequest = ++resultSequence.current, selectedId = workId; setResult(null); setResultError('');
            void client.get<Result>(`/me/private-work/${workId}/results/${id}`, { background: true }).then(value => {
              if (live.current && generation === workGeneration.current && resultRequest === resultSequence.current && selectedWork.current === selectedId) setResult(value);
            }).catch(() => { if (live.current && generation === workGeneration.current && resultRequest === resultSequence.current) setResultError('這個成果版本目前無法讀取。'); });
          }}><option value="" disabled>選擇成果版本</option>{history.map(value => <option key={value.resultId} value={value.resultId}>第 {value.revision} 版 · {value.provenance === 'human' ? '本人保存' : '模型產出'} · {time(value.createdAt)}</option>)}</select></label>}
        </>}
      </section>
    </div>
    <section className="card stack"><h2>模型執行與同意紀錄</h2>
      {serviceError && <p role="status">{serviceError}</p>}
      {overview && (!selectable || selections.length === 0) && <p className="banner banner-info">目前沒有可供確認的模型推論政策。設定紀錄不代表供應商已登入或模型可執行。</p>}
      {overview && work && overview.persistenceAvailable && <>
        <div className="private-ai-grid">
          <div className="stack"><label>執行紀錄<select disabled={disabled} value={runId} onChange={event => { setRunId(event.target.value); setGrantId(''); setApprovalId(''); setStepId(''); }}><option value="">選擇執行紀錄</option>{runs.map((value, index) => <option key={value.runId} value={value.runId}>執行 {index + 1} · {status(value.state)} · 工作版本 {value.inputWorkVersion}</option>)}</select></label>
            <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || work.state !== 'draft' || Boolean(dirty)} onClick={() => command('執行紀錄', '/me/execution-runs', { workId }, work.aggregate_version, value => setRunId((value as Run).runId))}>建立執行紀錄</button></div>
            {run && run.state !== 'succeeded' && !workIsCurrent && <p role="status">此執行綁定較早的工作版本，請為目前內容建立新的執行紀錄。</p>}
          </div>
          <div className="stack"><label>已配對的執行連線<select disabled={disabled} value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="">選擇本人連線</option>{overview.connections.filter(value => value.state === 'active').map((value, index) => <option key={value.connectionId} value={value.connectionId}>連線 {index + 1} · {status(value.state)} · 到期 {time(value.expiresAt)}</option>)}</select></label>
            {!overview.connections.some(value => value.state === 'active') && <p className="field-hint">尚無本人的配對連線，模型推論目前無法開始。</p>}
          </div>
        </div>
        <details><summary>新增模型選擇紀錄</summary><div className="stack"><p className="field-hint">此處保存模型選擇，不會替你登入供應商；可用性由伺服器在操作時重新檢查。</p>
          <label>供應商與模型<select disabled={disabled || !selectable} value={selectionIndex} onChange={event => setSelectionIndex(event.target.value)}><option value="">請明確選擇模型</option>{selections.map((value, index) => <option key={index} value={index}>{label(value.selection)} · {value.selection.processingLocation}</option>)}</select></label>
          <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || !connection || connection.state !== 'active' || selectionIndex === '' || !selections[Number(selectionIndex)]} onClick={() => command('模型選擇', '/me/model-connections', { connectionId, selection: selections[Number(selectionIndex)].selection }, connection!.aggregateVersion, value => setModelId((value as ModelConnectionMetadata).modelConnectionId))}>保存模型選擇</button></div>
        </div></details>
        <label>已保存的模型選擇<select disabled={disabled} value={modelId} onChange={event => setModelId(event.target.value)}><option value="">選擇模型紀錄</option>{models.map((value, index) => <option key={value.modelConnectionId} value={value.modelConnectionId}>{label(value.selection)} · {status(value.state)} · 紀錄 {index + 1}</option>)}</select></label>
        {model && <p className="field-hint">{label(model.selection)}；處理位置：{model.selection.processingLocation}；模型登入尚未由此紀錄驗證；費用未知。</p>}
        <label className="private-ai-consent"><input type="checkbox" checked={grantConsent} disabled={disabled || !run || !model || !connection || connection.state !== 'active' || model.connectionId !== connectionId || !workIsCurrent || Boolean(dirty)} onChange={event => setGrantConsent(event.target.checked)}/><span>我同意將此工作版本綁定至選定的執行連線與模型。</span></label>
        <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || !grantConsent || !run || !model || !connection || !workIsCurrent} onClick={() => command('模型同意紀錄', `/me/execution-runs/${runId}/grants`, { expectedWorkVersion: String(work.aggregate_version), connectionId, expectedConnectionVersion: connection!.aggregateVersion, modelConnectionId: modelId, expectedModelVersion: model!.aggregateVersion, consent: true }, run!.aggregateVersion, value => setGrantId((value as ExecutionGrantMetadata).grantId))}>保存模型同意</button></div>
        <label>模型同意紀錄<select disabled={disabled} value={grantId} onChange={event => { setGrantId(event.target.value); setApprovalId(''); setStepId(''); }}><option value="">選擇模型同意紀錄</option>{grants.map(value => <option key={value.grantId} value={value.grantId}>{label(value.selection)} · {status(value.state)} · {time(value.issuedAt)}</option>)}</select></label>
        {grant && <div className="private-ai-export stack"><h3>確認這一次推論送出的資料</h3><p>供應商／模型：<strong>{label(grant.selection)}</strong></p><p>處理位置：{grant.selection.processingLocation}；費用未知。最多一次推論，不會自動切換模型。</p>
          <dl className="private-ai-context"><dt>標題</dt><dd>{work.title}</dd><dt>目標</dt><dd className="multiline-text">{work.objective}</dd></dl>
          <p className="field-hint">送出的內容為 model-step.context/v1 格式的以上標題與目標；成果歷史不會加入這次內容。</p>
          <label>最多輸出 token<input type="number" min="1" max={maxTokens} step="1" value={tokens} disabled={disabled || !allowed} onChange={event => setTokens(event.target.value)}/></label><p className="field-hint">{maxTokens === undefined ? '目前沒有允許此模型推論的政策，無法建立新的單次同意。' : `目前政策上限 ${maxTokens} token；實際使用量需以成果紀錄確認。`}</p>
          <label className="private-ai-consent"><input type="checkbox" checked={exportConsent} disabled={disabled || grant.state !== 'active' || !tokensValid || !allowed || !workIsCurrent || Boolean(dirty) || grant.inputWorkVersion !== String(work.aggregate_version)} onChange={event => setExportConsent(event.target.checked)}/><span>我同意以上已保存的標題與目標，送至 {label(grant.selection)} 進行這一次推論，最多輸出 {tokens} token。</span></label>
          <div className="actions"><button type="button" className="btn btn-primary" disabled={disabled || !exportConsent || !tokensValid || !run || !allowed} onClick={() => command('單次推論同意', '/me/model-step-approvals', { runId, grantId, expectedGrantVersion: grant.aggregateVersion, expectedWorkVersion: String(work.aggregate_version), consent: true, maxOutputTokens: tokenValue }, run!.aggregateVersion, value => setApprovalId((value as ModelStepApprovalMetadata).approvalId))}>確認單次推論同意</button></div>
        </div>}
        <label>單次推論同意<select disabled={disabled} value={approvalId} onChange={event => { setApprovalId(event.target.value); setStepId(''); }}><option value="">選擇單次同意</option>{approvals.map(value => <option key={value.approvalId} value={value.approvalId}>{label(value.selection)} · {status(value.state)} · {value.maxOutputTokens} token · {time(value.issuedAt)}</option>)}</select></label>
        {approval && <><p className="field-hint">{label(approval.selection)}；同意工作版本 {approval.inputWorkVersion}，上限 {approval.maxOutputTokens} token，到期 {time(approval.expiresAt)}。</p><div className="actions">
          <button type="button" className="btn btn-ghost" disabled={disabled || !run || !workIsCurrent || approval.state !== 'active' || approval.inputWorkVersion !== String(work.aggregate_version) || Boolean(dirty)} onClick={() => command('推論啟用', '/me/model-steps', { approvalId, expectedRunVersion: run!.aggregateVersion }, approval.aggregateVersion, value => setStepId((value as ModelStepMetadata).stepId))}>啟用這次推論</button>
          <button type="button" className="btn btn-ghost" disabled={disabled || approval.state !== 'active'} onClick={() => command('推論同意撤銷', `/me/model-step-approvals/${approvalId}:revoke`, {}, approval.aggregateVersion)}>撤銷單次同意</button>
        </div></>}
        <label>推論狀態<select disabled={disabled} value={stepId} onChange={event => setStepId(event.target.value)}><option value="">選擇推論紀錄</option>{steps.map((value, index) => <option key={value.stepId} value={value.stepId}>推論 {index + 1} · {label(value.selection)} · {status(value.state)}</option>)}</select></label>
        {step && <div className="stack"><p role="status">{status(step.state)} · {label(step.selection)} · {step.evidenceOrigin === 'synthetic_local_fixture' ? '本機合成測試，未呼叫真實供應商' : '供應商 HTTPS'} · 費用未知</p>
          {step.state === 'outcome_unknown' && <p className="banner banner-info">推論結果尚未確認，不會再送出模型請求。請重新讀取狀態。</p>}
          <div className="actions"><button type="button" className="btn btn-primary" disabled={disabled || step.state !== 'reserved' || step.inputWorkVersion !== String(work.aggregate_version) || Boolean(dirty)} onClick={() => command('單次推論', `/me/model-steps/${stepId}:execute`, {}, step.aggregateVersion)}>執行一次推論</button>
            <button type="button" className="btn btn-ghost" disabled={disabled || terminal(step)} onClick={() => command('推論暫停', `/me/model-steps/${stepId}:pause`, {}, step.aggregateVersion)}>暫停推論</button>
            <button type="button" className="btn btn-ghost" disabled={disabled || terminal(step)} onClick={() => command('推論停止', `/me/model-steps/${stepId}:stop`, {}, step.aggregateVersion)}>停止推論</button>
          </div><p className="field-hint">暫停、停止與撤銷會阻止後續平台操作；已送往供應商的請求可能仍在處理。</p>
        </div>}
        {grant && <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || grant.state !== 'active'} onClick={() => command('模型同意撤銷', `/me/execution-grants/${grantId}:revoke`, {}, grant.aggregateVersion)}>撤銷模型同意</button></div>}
      </>}
    </section>
    {overview && (!work || !overview.persistenceAvailable) && (!overview.persistenceAvailable || overview.steps.length > 0 || overview.approvals.length > 0 || overview.grants.length > 0) && <section className="card stack"><h2>既有推論與撤銷操作</h2>
      {!overview.persistenceAvailable && <p className="banner banner-info" role="status">私人內容儲存政策目前未開放。工作內容與成果暫不顯示；仍可讀取推論狀態、停止或撤銷同意。</p>}
      <label>既有推論<select value={stepId} disabled={disabled} onChange={event => setStepId(event.target.value)}><option value="">選擇要控制的推論</option>{overview.steps.map((value, index) => <option key={value.stepId} value={value.stepId}>推論 {index + 1} · {label(value.selection)} · {status(value.state)}</option>)}</select></label>
      {(() => { const current = overview.steps.find(value => value.stepId === stepId); return current && <><p role="status">{label(current.selection)} · {status(current.state)} · {current.evidenceOrigin === 'synthetic_local_fixture' ? '本機合成測試' : '供應商 HTTPS'} · 費用未知</p><div className="actions">
        <button type="button" className="btn btn-ghost" disabled={disabled || terminal(current)} onClick={() => command('推論暫停', `/me/model-steps/${current.stepId}:pause`, {}, current.aggregateVersion)}>暫停推論</button>
        <button type="button" className="btn btn-ghost" disabled={disabled || terminal(current)} onClick={() => command('推論停止', `/me/model-steps/${current.stepId}:stop`, {}, current.aggregateVersion)}>停止推論</button>
      </div></>; })()}
      <label>既有單次同意<select value={approvalId} disabled={disabled} onChange={event => setApprovalId(event.target.value)}><option value="">選擇要撤銷的單次同意</option>{overview.approvals.map((value, index) => <option key={value.approvalId} value={value.approvalId}>同意 {index + 1} · {label(value.selection)} · {status(value.state)}</option>)}</select></label>
      {(() => { const current = overview.approvals.find(value => value.approvalId === approvalId); return current && <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || current.state !== 'active'} onClick={() => command('推論同意撤銷', `/me/model-step-approvals/${current.approvalId}:revoke`, {}, current.aggregateVersion)}>撤銷單次同意</button></div>; })()}
      <label>既有模型同意<select value={grantId} disabled={disabled} onChange={event => setGrantId(event.target.value)}><option value="">選擇要撤銷的模型同意</option>{overview.grants.map((value, index) => <option key={value.grantId} value={value.grantId}>模型同意 {index + 1} · {label(value.selection)} · {status(value.state)}</option>)}</select></label>
      {(() => { const current = overview.grants.find(value => value.grantId === grantId); return current && <div className="actions"><button type="button" className="btn btn-ghost" disabled={disabled || current.state !== 'active'} onClick={() => command('模型同意撤銷', `/me/execution-grants/${current.grantId}:revoke`, {}, current.aggregateVersion)}>撤銷模型同意</button></div>; })()}
      {!overview.steps.length && <p className="muted">尚無推論紀錄。</p>}
    </section>}
  </section>;
}
function ResultDetails({ result }: { result: Result }) {
  return <div className="stack"><h3>第 {result.revision} 版 · {result.provenance === 'human' ? '本人保存' : '模型產出'}</h3><p className="field-hint">工作版本 {result.workVersion} · {time(result.createdAt)}</p>
    {result.model && <p className="field-hint">{label(result.model.selection)} · {result.model.evidenceOrigin === 'synthetic_local_fixture' ? '本機合成測試' : '供應商 HTTPS'} · 輸入 {result.model.usage.inputTokens ?? '未知'}／輸出 {result.model.usage.outputTokens ?? '未知'} token · 費用未知</p>}
  </div>;
}
