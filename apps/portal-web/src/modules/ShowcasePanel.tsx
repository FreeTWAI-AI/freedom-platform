import React, { useCallback, useEffect, useRef, useState } from 'react'
import { requireItems } from '../api'
import { client, usePortal, describeError, type ActionError, type PortalContextValue } from '../portal-session'
import { Section, EmptyState, ErrorPanel } from '../portal-feedback'
import { WorkSharingEntry } from './WorkSharingEntry'
import { looksLikeUrl, opportunityStateLabel, parseMajorToMinor } from '../format'
import type { Opportunity, Showcase } from '../types'
import { authoringDraftState, useAuthoringDraft } from './authoring-drafts'
import { useModuleMutation } from './shared'
import { useShowcaseEditor, showcaseBody, showcaseInput, performShowcaseRequest, reconcilePublishedShowcase, type PersonalShowcase, type ShowcaseInput, type ShowcaseRequest } from './showcase-drafts'
export type { PersonalShowcase } from './showcase-drafts'

const SHOWCASE_PAGE = 20
function nextOffsetOf(payload: unknown): number | null {
  const value = payload && typeof payload === 'object' && 'next_offset' in payload ? payload.next_offset : null
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function ShowcasePanel() {
  const { session, pending, mutate, isMe } = usePortal()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ActionError | null>(null)
  const [showcases, setShowcases] = useState<Showcase[] | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [moreLoading, setMoreLoading] = useState(false)
  const [moreError, setMoreError] = useState<ActionError | null>(null)
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null)
  const [published, , current] = useAuthoringDraft<Showcase | null>(session.user.user_id, 'showcase:published', null)
  const [latestOpportunity] = useAuthoringDraft<Opportunity | null>(session.user.user_id, 'opportunity:latest', null)
  const loadSequence = useRef(0)
  useEffect(() => {
    if (published) setShowcases(items => !items || items.some(item => item.showcase_id === published.showcase_id) ? items : [published, ...items])
  }, [published, showcases])
  useEffect(() => {
    if (!latestOpportunity || !opportunities?.some(item => item.opportunity_id === latestOpportunity.opportunity_id)) return
    const card = document.getElementById(`opportunity-${latestOpportunity.opportunity_id}`)
    card?.scrollIntoView({ block: 'center', behavior: 'instant' }); card?.focus()
  }, [latestOpportunity, opportunities])

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    const observed = authoringDraftState<Showcase | null>(session.user.user_id, 'showcase:published', null).read()
    setLoading(true)
    setLoadError(null)
    try {
      const [showcasePayload, opportunityPayload] = await Promise.all([
        client.get<unknown>(`/showcases?limit=${SHOWCASE_PAGE}&offset=0`),
        client.get<unknown>('/opportunities'),
      ])
      if (!current() || sequence !== loadSequence.current) return
      const items = requireItems<Showcase>(showcasePayload, '作品')
      reconcilePublishedShowcase(session.user.user_id, items, observed)
      setShowcases(items)
      setNextOffset(nextOffsetOf(showcasePayload))
      setMoreError(null)
      setOpportunities(requireItems<Opportunity>(opportunityPayload, '商機'))
    } catch (err) {
      if (!current() || sequence !== loadSequence.current) return
      setShowcases(null)
      setOpportunities(null)
      setLoadError(describeError(err))
    } finally {
      if (current() && sequence === loadSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { loadSequence.current++ }
  }, [load, session.user.user_id, latestOpportunity?.opportunity_id])
  const loadMore = useCallback(async () => {
    if (nextOffset === null || moreLoading) return
    const sequence = loadSequence.current
    setMoreLoading(true); setMoreError(null)
    try {
      const payload = await client.get<unknown>(`/showcases?limit=${SHOWCASE_PAGE}&offset=${nextOffset}`)
      if (!current() || sequence !== loadSequence.current) return
      const items = requireItems<Showcase>(payload, '作品')
      setShowcases(existing => [...(existing ?? []), ...items.filter(item => !existing?.some(known => known.showcase_id === item.showcase_id))])
      setNextOffset(nextOffsetOf(payload))
    } catch (err) {
      if (current() && sequence === loadSequence.current) setMoreError(describeError(err))
    } finally {
      if (current() && sequence === loadSequence.current) setMoreLoading(false)
    }
  }, [nextOffset, moreLoading])
  useEffect(() => {
    const reveal = () => {
      const id = window.location.hash.slice('#showcase/'.length);
      if (!window.location.hash.startsWith('#showcase/') || !showcases) return;
      // A deep link may point past the first page: keep paging until it appears or the list ends.
      if (!showcases.some(item => item.showcase_id === id)) { if (nextOffset !== null && !moreError) void loadMore(); return; }
      const card = document.getElementById(`showcase-${id}`);
      card?.scrollIntoView({ block: 'center', behavior: 'instant' });
      card?.focus();
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [showcases, nextOffset, moreError, loadMore]);

  if (loading && !showcases) return <p className="muted" role="status">載入作品與商機…</p>
  if (loadError || !showcases || !opportunities) {
    return <ErrorPanel error={loadError ?? { message: '無法顯示作品與商機', network: false, conflict: false }} onReload={() => void load()} />
  }

  return (
    <div className="panels">
      <WorkSharingEntry current="showcase" />
      <CreateShowcaseForm pending={pending} onCreated={created => setShowcases(items => [created, ...(items ?? []).filter(item => item.showcase_id !== created.showcase_id)])} />
      <Section title="社群作品" description="看看夥伴的作品，找到適合一起合作的人。">
        <div data-share-entry="collaboration" tabIndex={-1}>
        {showcases.length === 0 ? (
          <EmptyState title="把第一件作品放上來" body="設計、影片、文章、工具都可以。分享後，社群成員可以向你提出合作需求。" />
        ) : (
          <div className="card-grid">
            {showcases.map((showcase) => (
              <ShowcaseCard
                key={showcase.showcase_id}
                showcase={showcase}
                mine={isMe(showcase.owner_ref)}
                pending={pending}
              />
            ))}
          </div>
        )}
        {moreError && <p className="banner banner-error" role="alert">較多作品暫時無法載入：{moreError.message}</p>}
        {nextOffset !== null && <div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? '正在載入…' : moreError ? '重試載入更多作品' : '載入更多作品'}</button></div>}
        </div>
      </Section>
      <Section data-guide-anchor="showcase:opportunities" title="與你相關的商機" description="只顯示你是提出者或作品作者的商機。">
        {opportunities.length === 0 ? (
          <EmptyState title="還沒有商機" body="從其他人的作品提出需求後，雙方才會在這裡看到。" />
        ) : (
          <div className="card-grid">
            {opportunities.map((opportunity) => (
              <OpportunityCard
                key={opportunity.opportunity_id}
                opportunity={opportunity}
                pending={pending}
                mutate={mutate}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function CreateShowcaseForm({
  pending,
  onCreated,
}: {
  pending: string | null
  onCreated: (created: Showcase) => void
}) {
  const { session } = usePortal()
  const userId = session.user.user_id
  const [title, setTitle, current] = useAuthoringDraft(userId, 'showcase:title', '')
  const [description, setDescription] = useAuthoringDraft(userId, 'showcase:description', '')
  const [artifactRef, setArtifactRef] = useAuthoringDraft(userId, 'showcase:artifact', '')
  const [publicUrl, setPublicUrl] = useAuthoringDraft(userId, 'showcase:url', '')
  const [published, setPublished] = useAuthoringDraft<Showcase | null>(userId, 'showcase:published', null)
  const success = useRef<HTMLElement>(null)
  useEffect(() => { if (published) success.current?.focus() }, [published])
  const [consent, setConsent] = useAuthoringDraft(userId, 'showcase:consent', false)
  const [formError, setFormError] = useState<string | null>(null)
  const authoring = useModuleMutation(client, { userId, type: 'showcase' })
  const busy = Boolean(pending) || authoring.busy

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !current()) return
    setFormError(null)
    try {
      const artifact = artifactRef.trim()
      if (!consent) throw new Error('分享前須由本人勾選同意')
      if (artifact && looksLikeUrl(artifact)) throw new Error('成果引用須為不透明代號')
      const created = await authoring.mutate<Showcase>(
          '/showcases',
          {
            title: title.trim(),
            description: description.trim(),
            ...(artifact ? { artifact_ref: artifact } : {}),
            public_url: publicUrl.trim() || null,
            consent_to_share: true,
          },
        )
      if (created && current()) {
        onCreated(created)
        setPublished(created)
        setTitle('')
        setDescription('')
        setPublicUrl('')
        setArtifactRef('')
        setConsent(false)
      }
    } catch (err) {
      if (current()) setFormError(err instanceof Error ? err.message : '請檢查表單')
    }
  }

  return (
    <section className="card stack work-sharing-form">
      <h2>分享作品</h2>
      <p className="lede">寫名稱、說用途，就能讓社群看到你的作品。</p>
      {published && <section ref={success} tabIndex={-1} className="work-sharing-success stack" aria-label="作品發布成功">
        <h3>「{published.title}」已分享！</h3><p>社群成員可以看見這件作品，並向你提出合作需求。</p>
        <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => { const card = document.getElementById(`showcase-${published.showcase_id}`); card?.scrollIntoView({ block: 'center', behavior: 'instant' }); card?.focus(); }}>查看剛分享的作品</button><a className="btn btn-ghost" href="#members">找合作夥伴</a></div>
      </section>}
      {(formError || authoring.error) && (
        <p className="banner banner-error" role="alert">
          {formError || authoring.error}
        </p>
      )}
      <form className="stack" aria-busy={busy} onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          <span className="field-label">作品標題</span>
          <input required maxLength={120} data-guide-anchor="showcase:title" placeholder="例如：我的品牌識別設計" value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">一句話介紹</span>
          <textarea required maxLength={2000} placeholder="你做了什麼？可以幫誰解決什麼問題？" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">作品連結（選填）</span>
          <input aria-label="作品連結（選填）" type="url" maxLength={2000} placeholder="https://…" value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} disabled={busy} />
          <span className="field-hint">可貼作品網站、影片或公開文章；請先確認連結不含私人資料或登入憑證。</span>
        </label>
        <details><summary>連接既有成果紀錄（進階選填）</summary><label className="field"><span className="field-label">成果引用（例如 artifact:template-v1）</span><input maxLength={231} placeholder="留空由系統處理" value={artifactRef} onChange={event => setArtifactRef(event.target.value)} disabled={busy}/><span className="field-hint">已經有成果代號才需要填寫。</span></label></details>
        <label className="choice">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} />
          我同意以社群可見方式分享這件作品
        </label>
        <div className="actions"><button className="btn btn-primary" type="submit" disabled={busy || !consent}>
          {busy ? '正在發布…' : '發布作品'}
        </button></div>
      </form>
    </section>
  )
}

function ShowcaseCard({
  showcase,
  mine,
  pending,
}: {
  showcase: Showcase
  mine: boolean
  pending: string | null
}) {
  const { session } = usePortal()
  const [need, setNeed, current] = useAuthoringDraft(session.user.user_id, `opportunity:${showcase.showcase_id}:need`, '')
  const [open, setOpen] = useAuthoringDraft(session.user.user_id, `opportunity:${showcase.showcase_id}:open`, false)
  const [submitted, setSubmitted] = useAuthoringDraft<Opportunity | null>(session.user.user_id, `opportunity:${showcase.showcase_id}:submitted`, null)
  const [, setLatestOpportunity] = useAuthoringDraft<Opportunity | null>(session.user.user_id, 'opportunity:latest', null)
  const authoring = useModuleMutation(client, { userId: session.user.user_id, type: `opportunity:${showcase.showcase_id}` })
  const busy = Boolean(pending) || authoring.busy

  async function propose(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !current()) return
    const created = await authoring.mutate<Opportunity>('/opportunities', { showcase_id: showcase.showcase_id, need: need.trim() })
    if (created && current()) {
      setNeed('')
      setOpen(false)
      setSubmitted(created)
      setLatestOpportunity(created)
      requestAnimationFrame(() => {
        if (!current()) return
        const card = document.getElementById(`opportunity-${created!.opportunity_id}`)
        card?.scrollIntoView({ block: 'center', behavior: 'instant' })
        card?.focus()
      })
    }
  }

  return (
    <article className="card" id={`showcase-${showcase.showcase_id}`} tabIndex={-1}>
      <div className="card-head">
        <h3>{showcase.title}</h3>
        <span className="pill">社群可見</span>
      </div>
      <p className="multiline-text">{showcase.description}</p>
      <dl className="meta">
        <div>
          <dt>作者</dt>
          <dd>{showcase.owner_name}</dd>
        </div>
      </dl>
      {showcase.public_url && <div className="actions"><a className="btn btn-ghost" href={showcase.public_url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看作品 ↗</a></div>}
      <details><summary>成果紀錄</summary><code>{showcase.artifact_ref}</code></details>
      {authoring.error && <p className="banner banner-error" role="alert">{authoring.error}</p>}
      {submitted && <section className="stack" role="status" aria-label="合作需求已送出"><p>已送出合作需求。這是你與作品作者的合作需求，不是公開貼文。</p><div className="actions"><button type="button" className="btn btn-secondary btn-small" onClick={() => { const card = document.getElementById(`opportunity-${submitted.opportunity_id}`); card?.scrollIntoView({ block: 'center', behavior: 'instant' }); card?.focus(); }}>查看這份合作需求</button></div></section>}
      {mine ? (
        <p className="hint">有人想合作時，需求會出現在下方「與你相關的商機」。</p>
      ) : (
        <div className="actions">
          {!open ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setOpen(true)}>
              我想找你合作
            </button>
          ) : (
            <form className="stack" onSubmit={(event) => void propose(event)}>
              <label className="field">
                <span className="field-label">你的需求</span>
                <textarea required rows={3} value={need} onChange={(event) => setNeed(event.target.value)} disabled={busy} />
              </label>
              <div className="actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  送出合作需求
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
                  取消
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  )
}

function OpportunityCard({
  opportunity,
  pending,
  mutate,
  onChanged,
}: {
  opportunity: Opportunity
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { isMe } = usePortal()
  const [scope, setScope] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [amount, setAmount] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const busy = Boolean(pending)
  const provider = isMe(opportunity.provider_ref)

  async function proposeEngagement(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const amountMinor = parseMajorToMinor(amount)
      const ok = await mutate(`engagement:${opportunity.opportunity_id}`, async (key) => {
        await client.post(
          `/opportunities/${opportunity.opportunity_id}/engagements`,
          {
            scope: scope.trim(),
            acceptance_criteria: acceptance.trim(),
            amount_minor: amountMinor,
            currency: 'TWD',
          },
          { idempotencyKey: key, ifMatch: opportunity.aggregate_version },
        )
      })
      if (ok) {
        setOpen(false)
        await onChanged()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查金額與內容')
    }
  }

  return (
    <article className="card" id={`opportunity-${opportunity.opportunity_id}`} tabIndex={-1}>
      <div className="card-head">
        <h3>{opportunity.showcase_title}</h3>
        <span className="pill">{opportunityStateLabel(opportunity.state)}</span>
      </div>
      <p className="multiline-text">{opportunity.need}</p>
      <dl className="meta">
        <div>
          <dt>提出者</dt>
          <dd>{opportunity.client_name}</dd>
        </div>
        <div>
          <dt>作品作者</dt>
          <dd>{opportunity.provider_name}</dd>
        </div>
      </dl>
      {provider && opportunity.state === 'proposed' && (
        <p className="hint">已提出合作，請到<a href="#engagement">合作紀錄</a>繼續同意、交付與收款回報。</p>
      )}
      {!provider && opportunity.state === 'open' && <p className="hint">已送出需求，等待作品作者提出合作範圍與價格。</p>}
      {!provider && opportunity.state === 'proposed' && <p className="hint">作者已提出合作，請到<a href="#engagement">合作紀錄</a>確認內容後再同意。</p>}
      {provider && opportunity.state === 'open' && (
        <div className="actions">
          {!open ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setOpen(true)}>
              提出合作
            </button>
          ) : (
            <form className="stack" onSubmit={(event) => void proposeEngagement(event)}>
              {formError && (
                <p className="banner banner-error" role="alert">
                  {formError}
                </p>
              )}
              <label className="field">
                <span className="field-label">合作範圍</span>
                <textarea required rows={3} value={scope} onChange={(event) => setScope(event.target.value)} disabled={busy} />
              </label>
              <label className="field">
                <span className="field-label">完成條件</span>
                <textarea required rows={3} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} disabled={busy} />
              </label>
              <label className="field">
                <span className="field-label">約定價格（新台幣，最多兩位小數）</span>
                <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} />
                <span className="field-hint">這是雙方約定價格，不是已收款。超過兩位小數會被拒絕，不會四捨五入。</span>
              </label>
              <div className="actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  送出合作提案
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
                  取消
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  )
}

export function ShowcaseDraftEditor({ id, onChanged, onClose }: { id: string | null; onChanged: () => void; onClose: () => void }) {
  const { session } = usePortal()
  const userId = session.user.user_id
  const [{ row, input, busy, error, notice, conflict, confirm, consent, retry }, state] = useShowcaseEditor(userId, id)
  const [loading, setLoading] = useState(Boolean(id && !row))
  const generation = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const setInput = (input: ShowcaseInput) => state.patch({ input })
  const setError = (error: string) => state.patch({ error })
  const setConfirm = (confirm: boolean) => state.patch({ confirm })
  const setConsent = (consent: boolean) => state.patch({ consent })
  useEffect(() => {
    heading.current?.focus()
    const current = ++generation.current
    const sessionGeneration = client.sessionGeneration
    const live = () => state.live() && generation.current === current && sessionGeneration === client.sessionGeneration
    // Retained edits and unknown outcomes must not be overwritten by a remount GET.
    const saved = state.read()
    const edited = saved.row && JSON.stringify(showcaseBody(saved.input)) !== JSON.stringify(showcaseBody(showcaseInput(saved.row)))
    if (id && !edited && !saved.busy && !saved.retry) {
      setLoading(true)
      void client.get<PersonalShowcase>(`/me/showcases/${encodeURIComponent(id)}`).then(result => {
        if (live() && state.read() === saved) state.patch({ row: result, input: showcaseInput(result) })
      }).catch(cause => { if (live()) setError(describeError(cause).message) })
        .finally(() => { if (live()) setLoading(false) })
    } else setLoading(false)
    return () => { generation.current++ }
  }, [id, userId, client.sessionGeneration])
  const dirty = !row || JSON.stringify(showcaseBody(input)) !== JSON.stringify(showcaseBody(showcaseInput(row)))
  async function reload(preserve: boolean) {
    if ((!row && !id) || state.read().busy || state.read().retry) return
    const current = generation.current, sessionGeneration = client.sessionGeneration
    const live = () => state.live() && current === generation.current && sessionGeneration === client.sessionGeneration
    setLoading(true)
    try {
      const result = await client.get<PersonalShowcase>(`/me/showcases/${encodeURIComponent(row?.showcase_id ?? id!)}`)
      if (!live()) return
      state.patch({ row: result, ...(!preserve ? { input: showcaseInput(result) } : {}), conflict: false, error: '', retry: null, confirm: false, consent: false,
        notice: preserve ? '已載入最新版本；你的輸入保留，請核對後再儲存。' : '已載入伺服器保存的內容。' })
    } catch (cause) { if (live()) setError(describeError(cause).message) }
    finally { if (live()) setLoading(false) }
  }
  async function execute(request: ShowcaseRequest) {
    const current = generation.current
    const result = await performShowcaseRequest(client, userId, state, request)
    if (result && state.live() && current === generation.current) onChanged()
  }
  function save(event: React.FormEvent) {
    event.preventDefault()
    if (loading || busy || retry || conflict || row?.status === 'published') return
    if (input.artifact_ref.trim() && looksLikeUrl(input.artifact_ref.trim())) { setError('成果引用須為不透明代號'); return }
    void execute({ method: row ? 'PATCH' : 'POST', path: row ? `/me/showcases/${encodeURIComponent(row.showcase_id)}` : '/me/showcases', body: showcaseBody(input), version: row?.aggregate_version, key: crypto.randomUUID() })
  }
  function command(kind: 'publish' | 'withdraw') {
    if (loading || busy || !row || retry || conflict || (kind === 'publish' && (!consent || dirty))) return
    void execute({ method: 'POST', path: `/me/showcases/${encodeURIComponent(row.showcase_id)}/${kind}`, body: kind === 'publish' ? { consent_to_share: true } : {}, version: row.aggregate_version, key: crypto.randomUUID() })
  }
  function close() { state.close(); onClose() }
  const disabled = loading || busy || Boolean(retry)
  return <section className="card stack work-sharing-form personal-content" aria-label="私人作品編輯">
    <div className="section-head"><h2 ref={heading} tabIndex={-1}>{row?.status === 'published' ? '已發布作品' : '私人作品草稿'}</h2><button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={close}>回到內容清單</button></div>
    {loading && <p role="status">載入作品…</p>}
    {error && <p role="alert" className="banner banner-error">{error}（你的輸入已保留）</p>}
    {notice && <p role="status">{notice}</p>}
    {retry && <div className="stack"><p>結果尚未確認。重試會使用同一份內容、版本與請求代號，不會另建草稿。</p><div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void execute(retry)}>重試原請求</button></div></div>}
    {conflict && <div className="stack"><p>版本已改變。先載入最新版本，再核對你的輸入。</p><div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={disabled} onClick={() => void reload(true)}>載入版本並保留輸入</button><button type="button" className="btn btn-secondary btn-small" disabled={disabled} onClick={() => void reload(false)}>改用伺服器內容</button></div></div>}
    {!loading && (row || !id) && <form className="stack" onSubmit={save} aria-busy={busy}>
      <p className="hint">{row?.status === 'published' ? '本社群會員可見；須先撤下才能修改。' : '僅本人可見。儲存不會發布；撤下的作品修改後會回到草稿。'}{row && ` 版本 ${row.aggregate_version}`}</p>
      <label className="field">作品標題<input required maxLength={120} value={input.title} disabled={disabled || row?.status === 'published'} onChange={event => { setInput({ ...input, title: event.target.value }); setConfirm(false); setConsent(false) }}/></label>
      <label className="field">一句話介紹<textarea required maxLength={2000} rows={3} value={input.description} disabled={disabled || row?.status === 'published'} onChange={event => { setInput({ ...input, description: event.target.value }); setConfirm(false); setConsent(false) }}/></label>
      <label className="field">作品外部連結（選填）<input type="url" maxLength={2000} value={input.public_url} disabled={disabled || row?.status === 'published'} onChange={event => { setInput({ ...input, public_url: event.target.value }); setConfirm(false); setConsent(false) }}/><span className="field-hint">外部網站的公開範圍由該網站決定；填入連結不代表本平台作品公開可索引。</span></label>
      <details><summary>成果引用（進階選填）</summary><label className="field">成果代號<input maxLength={231} value={input.artifact_ref} disabled={disabled || row?.status === 'published'} onChange={event => { setInput({ ...input, artifact_ref: event.target.value }); setConfirm(false); setConsent(false) }}/></label></details>
      <div className="actions">{row?.status !== 'published' && <button className="btn btn-secondary btn-small" disabled={disabled || conflict}>儲存私人草稿</button>}{row && row.status !== 'published' && <button type="button" className="btn btn-secondary btn-small" disabled={disabled || conflict || dirty} onClick={() => { setConfirm(true); setConsent(false) }}>確認發布範圍</button>}{row && row.status !== 'withdrawn' && <button type="button" className="btn btn-secondary btn-small" disabled={disabled || conflict} onClick={() => command('withdraw')}>撤下作品</button>}</div>
      {row?.status !== 'published' && dirty && <p className="hint">先儲存目前輸入，才可確認發布。</p>}
      {confirm && <section className="stack" aria-label="確認作品發布"><h3>發布為會員可見</h3><p>只有本社群會員可見，不提供「僅分享連結」或「公開可索引」發布範圍。</p><label className="choice"><input type="checkbox" checked={consent} disabled={disabled} onChange={event => setConsent(event.target.checked)}/>我同意將已儲存版本分享給本社群會員</label><div className="actions"><button type="button" className="btn btn-primary btn-small" disabled={disabled || !consent || dirty || conflict} onClick={() => command('publish')}>確認發布</button><button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => { setConfirm(false); setConsent(false) }}>取消發布</button></div></section>}
    </form>}
    {!loading && id && !row && <div className="actions"><button type="button" className="btn btn-secondary btn-small" onClick={() => void reload(false)}>重新載入作品</button></div>}
  </section>
}

