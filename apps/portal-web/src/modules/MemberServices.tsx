import {useCallback, useEffect, useState, type FormEvent} from 'react'
import {accessAwareFetch} from '../access-fetch'
import {ApiError, type PortalClient} from '../api'
import {SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS, SERVICE_MODE_LABELS, SERVICE_MODES, validateMemberService, type ServiceCategory, type ServiceMode} from '../../../../packages/shared/member-service'
import {MemberAvatar} from './MemberAvatar'
import {PromotionShare} from './PromotionShare'
import './MemberServices.css'

type Contact = {label: string; url: string}
type Service = {
  service_id: string; title: string; category: ServiceCategory; category_label: string; summary: string
  description: string | null; price_text: string | null; area_text: string | null; service_mode: ServiceMode
  contacts: Contact[]; state: string; aggregate_version: number; cover_url: string | null
  owner: {user_id: string; display_name: string; avatar_url: string | null}
  public_path: string; total_points: number; mine: boolean; can_hide: boolean
}
type Page = {items: Service[]; next_cursor: string | null; can_hide: boolean}
type Mine = {items: Service[]; limit: number}
type Draft = {title: string; category: ServiceCategory | ''; summary: string; description: string; price_text: string; area_text: string; service_mode: ServiceMode; contacts: Contact[]}
type Issue = {field: string; message: string}

const BLANK: Draft = {title: '', category: '', summary: '', description: '', price_text: '', area_text: '', service_mode: 'online', contacts: [{label: '', url: ''}]}

function Cover({service}: {service: Service}) {
  const [broken, setBroken] = useState(false)
  if (!service.cover_url || broken) return <div className="service-placeholder" data-category={service.category}><span>{service.category_label}</span></div>
  return <img className="service-cover" src={service.cover_url} alt="" width={1200} height={675} onError={() => setBroken(true)}/>
}

export function MemberServices({client}: {client: PortalClient}) {
  const [category, setCategory] = useState('')
  const [items, setItems] = useState<Service[]>([])
  const [mine, setMine] = useState<Service[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [canHide, setCanHide] = useState(false)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Service | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [file, setFile] = useState<File | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [confirming, setConfirming] = useState<string | null>(null)
  const issue = (field: string) => issues.find(item => item.field === field)?.message ?? ''
  const refreshMine = useCallback(async () => {
    const page = await client.get<Mine>('/member-services/mine')
    setMine(page.items)
  }, [client])
  const load = useCallback(async (nextCategory: string, nextCursor?: string) => {
    if (nextCursor) setMore(true)
    else setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams()
      if (nextCategory) query.set('category', nextCategory)
      if (nextCursor) query.set('cursor', nextCursor)
      const page = await client.get<Page>(`/member-services${query.size ? `?${query}` : ''}`)
      setItems(current => nextCursor ? [...current, ...page.items] : page.items)
      setCursor(page.next_cursor)
      setCanHide(page.can_hide)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '服務暫時無法載入。') }
    finally { setLoading(false); setMore(false) }
  }, [client])
  useEffect(() => { void load(category) }, [load, category])
  useEffect(() => { void refreshMine().catch(() => {}) }, [refreshMine])
  function openCreate() { setEditing(null); setDraft(BLANK); setFile(null); setIssues([]); setError(''); setFormOpen(true) }
  function openEdit(service: Service) {
    setEditing(service)
    setDraft({title: service.title, category: service.category, summary: service.summary, description: service.description ?? '', price_text: service.price_text ?? '', area_text: service.area_text ?? '', service_mode: service.service_mode, contacts: service.contacts.map(row => ({...row}))})
    setFile(null); setIssues([]); setError(''); setFormOpen(true)
  }
  function patch(partial: Partial<Draft>) { setDraft(current => ({...current, ...partial})) }
  async function send(method: 'PUT' | 'DELETE', path: string, body: unknown, version: number) {
    if (!client.csrfToken) throw new ApiError({message: '登入狀態已變更，請重新整理。', status: 400})
    const response = await accessAwareFetch(`/api/v1${path}`, {
      method, credentials: 'same-origin', body: JSON.stringify(body),
      headers: {'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': crypto.randomUUID(), 'If-Match': `"${version}"`},
    })
    const payload = await response.json().catch(() => ({})) as Service & {detail?: string; code?: string}
    if (!response.ok) throw new ApiError({message: payload.detail || '服務未能更新。', status: response.status, code: payload.code})
    return payload
  }
  async function uploadCover(service: Service, next: File) {
    if (!client.csrfToken) throw new ApiError({message: '登入狀態已變更，請重新整理。', status: 400})
    const response = await accessAwareFetch(`/api/v1/member-services/${service.service_id}/cover`, {
      method: 'PUT', credentials: 'same-origin', body: next,
      headers: {Accept: 'application/json', 'Content-Type': next.type, 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': crypto.randomUUID(), 'If-Match': `"${service.aggregate_version}"`},
    })
    const payload = await response.json().catch(() => ({})) as {detail?: string}
    if (!response.ok) throw new ApiError({message: payload.detail || '封面未能換上，服務已儲存。', status: response.status})
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const payload = {...draft, category: draft.category, contacts: draft.contacts.map(row => ({label: row.label, url: row.url}))}
    const parsed = validateMemberService(payload)
    if (!parsed.ok) { setIssues(parsed.issues); setError(parsed.issues[0]?.message || '請修正標示的欄位。'); return }
    setIssues([]); setSaving(true); setError(''); setNotice('')
    try {
      const saved = editing
        ? await send('PUT', `/member-services/${editing.service_id}`, parsed.value, editing.aggregate_version)
        : await client.post<Service>('/member-services', parsed.value)
      if (file) {
        try { await uploadCover(saved, file) }
        catch (cause) {
          setEditing(saved)
          setError(cause instanceof Error ? cause.message : '封面未能換上，服務已儲存。')
          await Promise.all([load(category), refreshMine()])
          return
        }
      }
      setFormOpen(false); setFile(null); setNotice(editing ? '已更新服務。' : '已新增服務。')
      await Promise.all([load(category), refreshMine()])
    } catch (cause) { setError(cause instanceof Error ? cause.message : '服務未能儲存。') }
    finally { setSaving(false) }
  }
  async function act(service: Service, action: 'pause' | 'resume' | 'hide' | 'delete' | 'remove-cover') {
    setSaving(true); setError('')
    try {
      if (action === 'delete') await send('DELETE', `/member-services/${service.service_id}`, {}, service.aggregate_version)
      else if (action === 'remove-cover') await client.post(`/member-services/${service.service_id}/cover/remove`, {}, {ifMatch: service.aggregate_version})
      else await client.post(`/member-services/${service.service_id}/${action}`, {}, {ifMatch: service.aggregate_version})
      setConfirming(null)
      setNotice(action === 'delete' ? '服務已刪除。' : action === 'hide' ? '服務已隱藏。' : action === 'pause' ? '服務已暫停。' : action === 'resume' ? '服務已恢復。' : '封面已移除。')
      if (action === 'remove-cover' && editing?.service_id === service.service_id) setEditing({...service, cover_url: null, aggregate_version: service.aggregate_version + 1})
      await Promise.all([load(category), refreshMine()])
    } catch (cause) { setError(cause instanceof Error ? cause.message : '服務未能更新。') }
    finally { setSaving(false) }
  }
  function actions(service: Service) {
    const paused = service.state === 'paused'
    return <div className="service-actions">
      {!paused && <a className="btn btn-ghost" href={service.public_path} target="_blank" rel="noopener noreferrer">服務頁 ↗</a>}
      {!paused && <PromotionShare client={client} kind="member_service" target={service.service_id} title={service.title} text={`${service.title}｜${service.owner.display_name}：${service.summary}`} label="分享"/>}
      {service.mine && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => openEdit(service)}>編輯</button>}
      {service.mine && !paused && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void act(service, 'pause')}>暫停</button>}
      {service.mine && paused && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void act(service, 'resume')}>恢復</button>}
      {service.mine && confirming !== service.service_id && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setConfirming(service.service_id)}>刪除</button>}
      {service.mine && confirming === service.service_id && <>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void act(service, 'delete')}>確定刪除</button>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>取消</button>
      </>}
      {canHide && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void act(service, 'hide')}>隱藏</button>}
    </div>
  }
  return <section className="service-zone stack" aria-label="社員服務分享區">
    <p className="service-intro">社員的本業服務都在這裡。看到適合朋友的服務，就用你的連結分享出去；每次點擊都算你的業務推廣分數。</p>
    <section className="card service-mine" aria-label="我的服務">
      <div className="service-mine-head">
        <h2>我的服務</h2>
        <button type="button" className={formOpen ? 'btn btn-ghost' : 'btn btn-primary'} onClick={() => { if (formOpen) { setFormOpen(false); setIssues([]); } else openCreate(); }}>{formOpen ? '關閉表單' : '新增服務'}</button>
      </div>
      {mine.length === 0 ? <p className="muted">你還沒有建立服務。</p> : <ul>
        {mine.map(service => <li className="service-mine-row" key={service.service_id}>
          <span className="service-mine-title">{service.title}</span>
          {service.state === 'paused' && <span className="service-state">暫停中</span>}
          {actions(service)}
        </li>)}
      </ul>}
    </section>
    {formOpen && <form className="card service-form" onSubmit={event => void submit(event)} aria-busy={saving}>
      <h2>{editing ? '編輯服務' : '新增服務'}</h2>
      <p className="service-public-note">服務頁會公開，任何拿到連結的人都看得到。</p>
      <label className="field">標題<input required maxLength={80} value={draft.title} aria-invalid={Boolean(issue('title'))} onChange={event => patch({title: event.target.value})}/>{issue('title') && <span className="field-error">{issue('title')}</span>}</label>
      <label className="field">分類<select required value={draft.category} aria-invalid={Boolean(issue('category'))} onChange={event => patch({category: event.target.value as ServiceCategory | ''})}>
        <option value="">請選擇</option>
        {SERVICE_CATEGORIES.map(id => <option key={id} value={id}>{SERVICE_CATEGORY_LABELS[id]}</option>)}
      </select>{issue('category') && <span className="field-error">{issue('category')}</span>}</label>
      <label className="field">簡介<textarea required maxLength={160} rows={2} value={draft.summary} aria-invalid={Boolean(issue('summary'))} onChange={event => patch({summary: event.target.value})}/>{issue('summary') && <span className="field-error">{issue('summary')}</span>}</label>
      <label className="field">說明<textarea maxLength={2000} rows={5} value={draft.description} aria-invalid={Boolean(issue('description'))} onChange={event => patch({description: event.target.value})}/>{issue('description') && <span className="field-error">{issue('description')}</span>}</label>
      <div className="service-form-split">
        <label className="field">價格<input maxLength={60} value={draft.price_text} aria-invalid={Boolean(issue('price_text'))} onChange={event => patch({price_text: event.target.value})} placeholder="每堂 NT$800 起"/>{issue('price_text') && <span className="field-error">{issue('price_text')}</span>}</label>
        <label className="field">地區<input maxLength={60} value={draft.area_text} aria-invalid={Boolean(issue('area_text'))} onChange={event => patch({area_text: event.target.value})} placeholder="台北・線上"/>{issue('area_text') && <span className="field-error">{issue('area_text')}</span>}</label>
      </div>
      <fieldset className="service-modes"><legend>服務方式</legend>
        {SERVICE_MODES.map(mode => <label key={mode}><input type="radio" name="service-mode" checked={draft.service_mode === mode} onChange={() => patch({service_mode: mode})}/>{SERVICE_MODE_LABELS[mode]}</label>)}
        {issue('service_mode') && <span className="field-error">{issue('service_mode')}</span>}
      </fieldset>
      <div className="service-contacts">
        {draft.contacts.map((row, index) => <div className="service-contact-row" key={index}>
          <label className="field">聯絡名稱<input maxLength={20} value={row.label} aria-invalid={Boolean(issue(`contacts.${index}.label`))} onChange={event => patch({contacts: draft.contacts.map((item, at) => at === index ? {...item, label: event.target.value} : item)})}/>{issue(`contacts.${index}.label`) && <span className="field-error">{issue(`contacts.${index}.label`)}</span>}</label>
          <label className="field">https 連結<input type="url" inputMode="url" maxLength={2048} value={row.url} aria-invalid={Boolean(issue(`contacts.${index}.url`))} onChange={event => patch({contacts: draft.contacts.map((item, at) => at === index ? {...item, url: event.target.value} : item)})} placeholder="https://"/>{issue(`contacts.${index}.url`) && <span className="field-error">{issue(`contacts.${index}.url`)}</span>}</label>
          <button type="button" className="btn btn-ghost" disabled={draft.contacts.length === 1} onClick={() => patch({contacts: draft.contacts.filter((_, at) => at !== index)})}>移除</button>
        </div>)}
        {issue('contacts') && <span className="field-error">{issue('contacts')}</span>}
        <button type="button" className="btn btn-ghost" disabled={draft.contacts.length >= 3} onClick={() => patch({contacts: [...draft.contacts, {label: '', url: ''}]})}>再加一個聯絡方式</button>
      </div>
      <label className="field">封面（選填）<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0] ?? null)}/></label>
      {editing?.cover_url && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void act(editing, 'remove-cover')}>移除封面</button>}
      {error && <div className="banner banner-error" role="alert"><p>{error}</p></div>}
      <div className="service-form-actions">
        <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? '正在儲存…' : editing ? '儲存變更' : '建立服務'}</button>
        <button className="btn btn-ghost" type="button" onClick={() => { setFormOpen(false); setIssues([]) }}>取消</button>
      </div>
    </form>}
    {notice && <p className="banner banner-info" role="status">{notice}</p>}
    {!formOpen && error && <div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={() => void load(category)}>重試</button></div>}
    <div className="service-filters" role="group" aria-label="分類">
      <button type="button" className="btn btn-ghost service-filter" aria-pressed={category === ''} onClick={() => setCategory('')}>全部</button>
      {SERVICE_CATEGORIES.map(id => <button key={id} type="button" className="btn btn-ghost service-filter" aria-pressed={category === id} onClick={() => setCategory(id)}>{SERVICE_CATEGORY_LABELS[id]}</button>)}
    </div>
    {loading && <p role="status">正在載入服務…</p>}
    {!loading && items.length === 0 && <p className="empty">{category ? '這個分類還沒有服務。' : '還沒有社員分享服務。你可以先新增自己的服務。'}</p>}
    <div className="service-grid">
      {items.map(service => <article className="card service-card" key={service.service_id}>
        <Cover service={service}/>
        <div className="service-card-body">
          <span className="service-badge" data-category={service.category}>{service.category_label}</span>
          <h3>{service.title}</h3>
          <p className="service-byline"><MemberAvatar nickname={service.owner.display_name} avatarUrl={service.owner.avatar_url} className="service-avatar"/><span>{service.owner.display_name}</span></p>
          <p className="service-summary">{service.summary}</p>
          {(service.price_text || service.area_text) && <p className="service-facts">{[service.price_text, service.area_text].filter(Boolean).join(' · ')}</p>}
          <p className="service-points">推廣點擊 {service.total_points}</p>
          {actions(service)}
        </div>
      </article>)}
    </div>
    {cursor && <button type="button" className="btn btn-ghost" disabled={more} onClick={() => void load(category, cursor)}>{more ? '正在載入…' : '載入更多'}</button>}
  </section>
}
