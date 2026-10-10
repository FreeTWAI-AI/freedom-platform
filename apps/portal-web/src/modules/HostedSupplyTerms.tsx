import {useEffect, useRef, useState, type FormEvent} from 'react';
import {SupplyTermsInputSchema, SupplyTermsSchema, type SupplyTerms, type SupplyTermsInput} from '../../../../contracts/guild-launchpad/v1/hosted-supply-terms';
import {ApiError, type PortalClient} from '../api';
import {formatMinor, parseMajorToMinor} from '../format';

export function HostedSupplyTerms({client, path, title, busy, onDirty, onCancel, onSave}: {
  client: PortalClient; path: string; title: string; busy: boolean;
  onDirty: (dirty: boolean) => void; onCancel: () => void;
  onSave: (body: SupplyTermsInput, version: string, success: () => void) => Promise<void>;
}) {
  const [view, setView] = useState<SupplyTerms | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void client.get(path, {signal: controller.signal}).then(raw => {
      if (!controller.signal.aborted) setView(SupplyTermsSchema.parse(raw));
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof ApiError && !cause.network ? cause.detail ?? '目前無法讀取供貨條件。' : '暫時無法讀取供貨條件，請重試。');
    });
    return () => controller.abort();
  }, [client, path, reload]);
  if (!view) return <div className="stack">
    <p role={error ? 'alert' : 'status'}>{error || '正在讀取供貨條件…'}</p>
    <div className="actions">{error && <button type="button" className="btn btn-ghost" onClick={() => setReload(n => n + 1)}>重試讀取供貨條件</button>}
      <button type="button" className="btn btn-ghost" onClick={onCancel}>返回商品</button></div>
  </div>;
  return <SupplyForm view={view} title={title} busy={busy} onDirty={onDirty} onCancel={onCancel} onSave={onSave}/>;
}

function SupplyForm({view, title, busy, onDirty, onCancel, onSave}: {
  view: SupplyTerms; title: string; busy: boolean; onDirty: (dirty: boolean) => void; onCancel: () => void;
  onSave: (body: SupplyTermsInput, version: string, success: () => void) => Promise<void>;
}) {
  const initial = {cost: (view.cost_minor / 100).toFixed(2), shipping: (view.shipping_minor / 100).toFixed(2), shippingTerms: view.shipping_terms, returnTerms: view.return_terms};
  const [fields, setFields] = useState(initial);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  const onDirtyRef = useRef(onDirty); onDirtyRef.current = onDirty;
  useEffect(() => {onDirtyRef.current(dirty);}, [dirty]);
  useEffect(() => () => {onDirtyRef.current(false);}, []);
  const change = (key: keyof typeof fields, value: string) => setFields(old => ({...old, [key]: value}));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const shipping = /^0+(?:\.0{1,2})?$/.test(fields.shipping.trim()) ? 0 : parseMajorToMinor(fields.shipping);
      const parsed = SupplyTermsInputSchema.safeParse({cost_minor: parseMajorToMinor(fields.cost), shipping_minor: shipping, shipping_terms: fields.shippingTerms, return_terms: fields.returnTerms});
      if (!parsed.success) {setError('請填寫有效的金額、出貨與退貨條件。'); return;}
      await onSave(parsed.data, view.version, () => onDirtyRef.current(false));
    } catch (cause) {setError(cause instanceof Error ? cause.message : '請檢查供貨條件。');}
  }
  return <form className="hosted-store-form stack" aria-label={`${title}供貨條件`} onSubmit={event => void submit(event)}>
    <h4>{title}・供貨條件</h4>
    <p className="field-hint">先儲存供貨草稿。其他店主尚不能選用這些商品，儲存不會建立供貨合作。</p>
    <p>庫存 {view.stock}・已預留 {view.reserved}・可供 {view.available}</p>
    <fieldset className="hosted-store-fields stack" disabled={busy}>
      <legend className="sr-only">供貨條件</legend>
      <label className="field">供貨單價（{view.currency}）<input required inputMode="decimal" value={fields.cost} onChange={e => change('cost', e.target.value)}/></label>
      <p className="field-hint">每件商品的供貨價；店內零售價另行編輯。</p>
      <label className="field">每件運費（{view.currency}）<input required inputMode="decimal" value={fields.shipping} onChange={e => change('shipping', e.target.value)}/></label>
      <p className="field-hint">金額上限 {formatMinor(100000000, view.currency)}；免運請填 0。</p>
      <label className="field">出貨條件<textarea required maxLength={2000} value={fields.shippingTerms} onChange={e => change('shippingTerms', e.target.value)}/></label>
      <label className="field">退貨條件<textarea required maxLength={2000} value={fields.returnTerms} onChange={e => change('returnTerms', e.target.value)}/></label>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <div className="actions"><button className="btn btn-ghost" disabled={busy}>儲存供貨條件</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>返回商品</button></div>
    </fieldset>
  </form>;
}
