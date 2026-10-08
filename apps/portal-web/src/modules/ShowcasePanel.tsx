import React, { useCallback, useEffect, useRef, useState } from 'react'
import { requireItems } from '../api'
import { client, usePortal, describeError, type ActionError, type PortalContextValue } from '../portal-session'
import { Section, EmptyState, ErrorPanel } from '../portal-feedback'
import { WorkSharingEntry } from './WorkSharingEntry'
import { looksLikeUrl, opportunityStateLabel, parseMajorToMinor } from '../format'
import type { Opportunity, Showcase } from '../types'

export function ShowcasePanel() {
  const { session, pending, mutate, isMe } = usePortal()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ActionError | null>(null)
  const [showcases, setShowcases] = useState<Showcase[] | null>(null)
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [showcasePayload, opportunityPayload] = await Promise.all([
        client.get<unknown>('/showcases'),
        client.get<unknown>('/opportunities'),
      ])
      setShowcases(requireItems<Showcase>(showcasePayload, '作品'))
      setOpportunities(requireItems<Opportunity>(opportunityPayload, '商機'))
    } catch (err) {
      setShowcases(null)
      setOpportunities(null)
      setLoadError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.user_id])
  useEffect(() => {
    const reveal = () => {
      const id = window.location.hash.slice('#showcase/'.length);
      if (!window.location.hash.startsWith('#showcase/') || !showcases?.some(item => item.showcase_id === id)) return;
      const card = document.getElementById(`showcase-${id}`);
      card?.scrollIntoView({ block: 'center', behavior: 'instant' });
      card?.focus();
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [showcases]);

  if (loading && !showcases) return <p className="muted" role="status">載入作品與商機…</p>
  if (loadError || !showcases || !opportunities) {
    return <ErrorPanel error={loadError ?? { message: '無法顯示作品與商機', network: false, conflict: false }} onReload={() => void load()} />
  }

  return (
    <div className="panels">
      <WorkSharingEntry current="showcase" />
      <CreateShowcaseForm pending={pending} mutate={mutate} onCreated={created => setShowcases(items => [created, ...(items ?? []).filter(item => item.showcase_id !== created.showcase_id)])} />
      <Section title="社群作品" description="看看夥伴的作品，找到適合一起合作的人。">
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
                mutate={mutate}
                onChanged={load}
              />
            ))}
          </div>
        )}
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
  mutate,
  onCreated,
}: {
  pending: string | null
  mutate: PortalContextValue['mutate']
  onCreated: (created: Showcase) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [artifactRef, setArtifactRef] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [published, setPublished] = useState<Showcase | null>(null)
  const success = useRef<HTMLElement>(null)
  useEffect(() => { if (published) success.current?.focus() }, [published])
  const [consent, setConsent] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const busy = Boolean(pending)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const artifact = artifactRef.trim()
      if (!consent) throw new Error('分享前須由本人勾選同意')
      if (artifact && looksLikeUrl(artifact)) throw new Error('成果引用須為不透明代號')
      let created: Showcase | null = null
      const ok = await mutate('create-showcase', async (key) => {
        created = await client.post<Showcase>(
          '/showcases',
          {
            title: title.trim(),
            description: description.trim(),
            ...(artifact ? { artifact_ref: artifact } : {}),
            public_url: publicUrl.trim() || null,
            consent_to_share: true,
          },
          { idempotencyKey: key },
        )
      })
      if (ok && created) {
        onCreated(created)
        setPublished(created)
        setTitle('')
        setDescription('')
        setPublicUrl('')
        setArtifactRef('')
        setConsent(false)
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查表單')
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
      {formError && (
        <p className="banner banner-error" role="alert">
          {formError}
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
  mutate,
  onChanged,
}: {
  showcase: Showcase
  mine: boolean
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const [need, setNeed] = useState('')
  const [open, setOpen] = useState(false)
  const busy = Boolean(pending)

  async function propose(event: React.FormEvent) {
    event.preventDefault()
    const ok = await mutate(`opportunity:${showcase.showcase_id}`, async (key) => {
      await client.post('/opportunities', { showcase_id: showcase.showcase_id, need: need.trim() }, { idempotencyKey: key })
    })
    if (ok) {
      setNeed('')
      setOpen(false)
      await onChanged()
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
    <article className="card">
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

