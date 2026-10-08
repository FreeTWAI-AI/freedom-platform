import { useEffect, useId, useState } from 'react';
import type { ResultView } from '../../../../contracts/guild-launchpad/v1/tenant-work';
import { ProductionReferenceSchema, type ProductionDossier } from '../../../../modules/guild-workspace/production-dossier';

type Props = {
  value: ProductionDossier;
  onChange: (value: ProductionDossier) => void;
  onSave: () => void;
  onDraftChange: (dirty: boolean) => void;
  results: ResultView[];
  disabled: boolean;
  readOnly: boolean;
  saved: boolean;
  error: string;
};

/** Structured editing only; identity, authority, upload and recovery stay with the existing Work panel. */
export function ProductionProject({ value, onChange, onSave, onDraftChange, results, disabled, readOnly, saved, error }: Props) {
  const prefix = useId();
  const [selectedResult, setSelectedResult] = useState('');
  const [deliveryMaterials, setDeliveryMaterials] = useState<string[]>([]);
  const [deliveryVersion, setDeliveryVersion] = useState('');
  const [feedbackDelivery, setFeedbackDelivery] = useState('');
  const [entryError, setEntryError] = useState('');
  useEffect(() => {
    onDraftChange(Boolean(selectedResult || deliveryMaterials.length || deliveryVersion || feedbackDelivery));
  }, [selectedResult, deliveryMaterials, deliveryVersion, feedbackDelivery, onDraftChange]);
  const locked = disabled || readOnly;
  function change(update: (draft: ProductionDossier) => void) {
    const next = structuredClone(value); update(next); onChange(next);
  }
  function field(label: string, content: string, update: (text: string) => void, multiline = false) {
    return <label className="field">{label}{multiline
      ? <textarea aria-label={label} value={content} disabled={locked} onChange={event => update(event.target.value)} />
      : <input aria-label={label} value={content} disabled={locked} onChange={event => update(event.target.value)} />}</label>;
  }
  function registerResult() {
    const result = results.find(row => row.result_id === selectedResult);
    if (!result) return;
    change(draft => draft.materials.push({ id: crypto.randomUUID(), label: result.display_name, rights_note: '', reference: { kind: 'same_work_text_result', result_id: result.result_id, revision: result.revision, sha256: result.sha256 } }));
    setSelectedResult('');
  }
  function addDelivery() {
    const targets = value.materials.filter(row => deliveryMaterials.includes(row.id));
    if (!deliveryVersion.trim() || !targets.length) { setEntryError('填寫交付版本名稱，並選擇至少一份素材。'); return; }
    if (targets.some(row => !row.label.trim() || !ProductionReferenceSchema.safeParse(row.reference).success)) {
      setEntryError('先完成所選素材的名稱、網址與版本，再固定交付清單。'); return;
    }
    change(draft => draft.deliveries.push({ id: crypto.randomUUID(), version_label: deliveryVersion, change_summary: '', status: 'prepared', method: '', recipient_label: '', targets: targets.map(row => ({ material_id: row.id, label: row.label, reference: structuredClone(row.reference) })) }));
    setDeliveryMaterials([]); setDeliveryVersion(''); setEntryError('');
  }
  function addFeedback() {
    const delivery = value.deliveries.find(row => row.id === feedbackDelivery);
    if (!delivery) { setEntryError('先選擇回饋對應的交付版本。'); return; }
    change(draft => draft.feedback.push({ id: crypto.randomUUID(), delivery_id: delivery.id, target_version: delivery.version_label, source: 'internal_note', text: '', follow_up: '', status: 'open' }));
    setFeedbackDelivery(''); setEntryError('');
  }
  return <section className="stack production-project" aria-labelledby={`${prefix}-heading`}>
    <h4 id={`${prefix}-heading`}>製作專案企劃與版本</h4>
    <p className="field-hint">{saved ? '修改後儲存為新版本；先前版本保留在成果紀錄。' : '專案已建立，製作資料待儲存。可以從這份專案繼續，不必重新建立。'}</p>
    <form className="stack" aria-label="製作專案企劃" onSubmit={event => {
      event.preventDefault();
      if (selectedResult || deliveryMaterials.length || deliveryVersion || feedbackDelivery) {
        setEntryError('先完成所選文字版本、交付清單或回饋的新增，或清空尚未新增的選擇，再儲存。'); return;
      }
      setEntryError(''); onSave();
    }}>
      <fieldset className="stack" disabled={locked}>
        <legend>製作 brief</legend>
        {field('目標受眾', value.brief.audience, text => change(draft => { draft.brief.audience = text; }))}
        {field('使用渠道／用途', value.brief.channel, text => change(draft => { draft.brief.channel = text; }))}
        {field('拍攝主體／產品事實', value.brief.subject, text => change(draft => { draft.brief.subject = text; }), true)}
        {field('核心訊息', value.brief.key_message, text => change(draft => { draft.brief.key_message = text; }), true)}
        {field('限制與注意事項', value.brief.constraints, text => change(draft => { draft.brief.constraints = text; }), true)}
        {field('預定日期／時程', value.brief.planned_date, text => change(draft => { draft.brief.planned_date = text; }))}
      </fieldset>
      <details open><summary>交付規格（{value.specifications.length}）</summary><div className="stack">
        {value.specifications.map((spec, index) => <fieldset className="stack" key={spec.id} disabled={locked}><legend>規格 {index + 1}</legend>
          <label className="field">類型<select aria-label="類型" value={spec.kind} onChange={event => change(draft => { draft.specifications[index].kind = event.target.value as typeof spec.kind; })}><option value="photo">照片</option><option value="video">影片</option><option value="text">文字</option></select></label>
          {field('尺寸／比例', spec.dimensions, text => change(draft => { draft.specifications[index].dimensions = text; }))}
          {field('片長', spec.duration, text => change(draft => { draft.specifications[index].duration = text; }))}
          <label className="field">數量<input type="number" min={1} max={10000} value={spec.quantity} onChange={event => change(draft => { draft.specifications[index].quantity = Number(event.target.value); })}/></label>
          {field('規格補充', spec.notes, text => change(draft => { draft.specifications[index].notes = text; }), true)}
          <button type="button" className="btn btn-ghost" onClick={() => change(draft => { draft.specifications.splice(index, 1); })}>移除規格 {index + 1}</button>
        </fieldset>)}
        {!readOnly && <button type="button" className="btn btn-ghost" disabled={locked || value.specifications.length >= 40} onClick={() => change(draft => draft.specifications.push({ id: crypto.randomUUID(), kind: 'photo', dimensions: '', duration: '', quantity: 1, notes: '' }))}>新增交付規格</button>}
      </div></details>
      <details open><summary>鏡位與拍攝安排（{value.shots.length}）</summary><div className="stack">
        {value.shots.map((shot, index) => <fieldset className="stack" key={shot.id} disabled={locked}><legend>鏡位 {index + 1}</legend>
          {field('鏡位內容', shot.description, text => change(draft => { draft.shots[index].description = text; }), true)}
          {field('景別／構圖', shot.framing, text => change(draft => { draft.shots[index].framing = text; }))}
          {field('光線／道具', shot.lighting_props, text => change(draft => { draft.shots[index].lighting_props = text; }), true)}
          {field('負責人標記', shot.owner_label, text => change(draft => { draft.shots[index].owner_label = text; }))}
          {value.materials.map(material => <label key={material.id}><input type="checkbox" checked={shot.material_ids.includes(material.id)} onChange={event => change(draft => { draft.shots[index].material_ids = event.target.checked ? [...shot.material_ids, material.id] : shot.material_ids.filter(id => id !== material.id); })}/> 素材：{material.label}</label>)}
          <button type="button" className="btn btn-ghost" onClick={() => change(draft => { draft.shots.splice(index, 1); })}>移除鏡位 {index + 1}</button>
        </fieldset>)}
        {!readOnly && <button type="button" className="btn btn-ghost" disabled={locked || value.shots.length >= 100} onClick={() => change(draft => draft.shots.push({ id: crypto.randomUUID(), description: '', framing: '', lighting_props: '', owner_label: '', material_ids: [] }))}>新增鏡位</button>}
      </div></details>
      <details open><summary>素材與版本引用（{value.materials.length}）</summary><div className="stack">
        <p className="field-hint">文字附件先在下方儲存，再登記確切版本。照片與影片只登記外部 HTTPS 位置及版本；原檔不會保存在這裡。</p>
        {value.materials.map((material, index) => <fieldset className="stack" key={material.id} disabled={locked}><legend>素材 {index + 1}</legend>
          {field('素材名稱', material.label, text => change(draft => { draft.materials[index].label = text; }))}
          {material.reference.kind === 'same_work_text_result' ? <p>文字成果第 {material.reference.revision} 版 · {material.reference.sha256.slice(0, 12)}</p> : <>
            {field('素材 HTTPS 網址', material.reference.url, text => change(draft => { const ref = draft.materials[index].reference; if (ref.kind === 'external_reference') ref.url = text; }))}
            {field('素材版本標記', material.reference.declared_version, text => change(draft => { const ref = draft.materials[index].reference; if (ref.kind === 'external_reference') ref.declared_version = text; }))}
          </>}
          {field('來源／使用權說明', material.rights_note, text => change(draft => { draft.materials[index].rights_note = text; }), true)}
          <button type="button" className="btn btn-ghost" onClick={() => change(draft => { draft.materials.splice(index, 1); draft.shots.forEach(shot => { shot.material_ids = shot.material_ids.filter(id => id !== material.id); }); })}>移除素材 {index + 1}</button>
        </fieldset>)}
        {!readOnly && <>
          <label className="field">已儲存文字成果<select aria-label="已儲存文字成果" disabled={locked} value={selectedResult} onChange={event => setSelectedResult(event.target.value)}><option value="">選擇確切版本</option>{results.map(result => <option key={result.result_id} value={result.result_id}>{result.display_name} · 第 {result.revision} 版 · {result.sha256.slice(0, 8)}</option>)}</select></label>
          <div className="my-work-actions"><button type="button" className="btn btn-ghost" disabled={locked || !selectedResult || value.materials.length >= 100} onClick={registerResult}>登記文字版本</button>
            <button type="button" className="btn btn-ghost" disabled={locked || value.materials.length >= 100} onClick={() => change(draft => draft.materials.push({ id: crypto.randomUUID(), label: '', rights_note: '', reference: { kind: 'external_reference', url: '', declared_version: '' } }))}>登記外部素材</button></div>
        </>}
      </div></details>
      <details open><summary>交付版本與回饋（{value.deliveries.length}／{value.feedback.length}）</summary><div className="stack">
        <p className="field-hint">交付清單固定所選素材版本。交接與外部回饋是你的私人紀錄；儲存不會外寄，也不代表客戶已核准。</p>
        {value.deliveries.map((delivery, index) => <fieldset className="stack" key={delivery.id} disabled={locked}><legend>交付：{delivery.version_label}</legend>
          <ul>{delivery.targets.map(target => <li key={target.material_id}>{target.label} · {target.reference.kind === 'same_work_text_result' ? `第 ${target.reference.revision} 版 · ${target.reference.sha256.slice(0, 12)}` : `${target.reference.declared_version} · ${target.reference.url}`}</li>)}</ul>
          {field('此版變更摘要', delivery.change_summary, text => change(draft => { draft.deliveries[index].change_summary = text; }), true)}
          <label className="field">紀錄狀態<select aria-label="紀錄狀態" value={delivery.status} onChange={event => change(draft => { draft.deliveries[index].status = event.target.value as typeof delivery.status; })}><option value="prepared">準備交付</option><option value="recorded_handoff">自行記錄交接</option></select></label>
          {field('交接方式／日期備註', delivery.method, text => change(draft => { draft.deliveries[index].method = text; }))}
          {field('收件對象標記', delivery.recipient_label, text => change(draft => { draft.deliveries[index].recipient_label = text; }))}
        </fieldset>)}
        {!readOnly && <fieldset className="stack" disabled={locked || value.deliveries.length >= 100}><legend>建立交付版本</legend>
          <label className="field">交付版本名稱<input value={deliveryVersion} maxLength={160} onChange={event => setDeliveryVersion(event.target.value)}/></label>
          {value.materials.map(material => <label key={material.id}><input type="checkbox" checked={deliveryMaterials.includes(material.id)} onChange={event => setDeliveryMaterials(event.target.checked ? [...deliveryMaterials, material.id] : deliveryMaterials.filter(id => id !== material.id))}/> 交付素材：{material.label}</label>)}
          <button type="button" className="btn btn-ghost" onClick={addDelivery}>固定此版交付清單</button>
        </fieldset>}
        {value.feedback.map((feedback, index) => <fieldset className="stack" key={feedback.id} disabled={locked}><legend>回饋：{feedback.target_version}</legend>
          <label className="field">回饋來源<select aria-label="回饋來源" value={feedback.source} onChange={event => change(draft => { draft.feedback[index].source = event.target.value as typeof feedback.source; })}><option value="internal_note">內部筆記</option><option value="externally_reported">自行記錄外部回饋</option></select></label>
          {field('回饋內容', feedback.text, text => change(draft => { draft.feedback[index].text = text; }), true)}
          {field('後續修改', feedback.follow_up, text => change(draft => { draft.feedback[index].follow_up = text; }), true)}
          <label className="field">處理狀態<select aria-label="處理狀態" value={feedback.status} onChange={event => change(draft => { draft.feedback[index].status = event.target.value as typeof feedback.status; })}><option value="open">待處理</option><option value="addressed">已記錄處理</option></select></label>
        </fieldset>)}
        {!readOnly && <><label className="field">回饋對應版本<select aria-label="回饋對應版本" disabled={locked} value={feedbackDelivery} onChange={event => setFeedbackDelivery(event.target.value)}><option value="">選擇交付版本</option>{value.deliveries.map(delivery => <option key={delivery.id} value={delivery.id}>{delivery.version_label} · {delivery.id.slice(0, 8)}</option>)}</select></label>
          <button type="button" className="btn btn-ghost" disabled={locked || value.feedback.length >= 200} onClick={addFeedback}>新增版本回饋</button></>}
      </div></details>
      {(error || entryError) && <p className="banner banner-error" role="alert">{error || entryError}</p>}
      {!readOnly && <button type="submit" className="btn btn-primary my-work-primary" disabled={locked}>儲存製作版本</button>}
    </form>
  </section>;
}
