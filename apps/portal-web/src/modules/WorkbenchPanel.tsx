import React, { useCallback, useEffect, useState } from 'react'
import { requireDashboard, requireItems } from '../api'
import { client, usePortal, describeError, isOwnRef, type ActionError, type PortalContextValue } from '../portal-session'
import { Section, EmptyState, ErrorPanel } from '../portal-feedback'
import { ModuleBanner } from './ModuleBanner'
import { BenefitObservations } from './BenefitObservations'
import { claimStateLabel, formatIsoLocal, hoursFromNowLocalInput, isPastIso, localInputToIso, looksLikeUrl, participationModeLabel, workStateLabel } from '../format'
import type { Dashboard, ReviewQueueItem, WorkClaim, WorkItem } from '../types'

export function WorkbenchPanel() {
  const { session, pending, mutate } = usePortal()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ActionError | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [items, setItems] = useState<WorkItem[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [dashPayload, itemsPayload] = await Promise.all([
        client.get<unknown>('/dashboard'),
        client.get<unknown>('/work-items'),
      ])
      setDashboard(requireDashboard<Dashboard>(dashPayload))
      setItems(requireItems<WorkItem>(itemsPayload, '工作列表'))
    } catch (err) {
      setDashboard(null)
      setItems(null)
      setLoadError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.user_id])

  if (loading && !dashboard) {
    return <p className="muted" role="status">載入工作台…</p>
  }
  if (loadError || !dashboard || !items) {
    return <ErrorPanel error={loadError ?? { message: '無法顯示工作台', network: false, conflict: false }} onReload={() => void load()} />
  }

  const seen = new Set([...dashboard.now, ...dashboard.next].map((item) => item.work_item_id))
  const catalog = items.filter((item) => !item.my_claim && !seen.has(item.work_item_id))

  return (
    <div className="panels">
      <ModuleBanner eyebrow="YOUR QUESTS / 協作任務" title="認領與交付" description="" art="/art/rpg/cooperation-forge.webp"/>
      <section className="summary-strip" aria-label="成果摘要">
        <div>
          <span className="summary-label">已接受成果</span>
          <strong>{dashboard.summary.accepted_count}</strong>
        </div>
        <p>成果由合作當事人確認，不代表官方認證。</p>
      </section>

      <Section data-guide-anchor="workbench:current-work" title="現在進行" description="你正在處理的互助工作。">
        <WorkItemList
          items={dashboard.now}
          empty="目前沒有進行中的工作。可在「接下來」或「其他社群工作」認領，或在頁尾發布一張自願互助卡。"
          pending={pending}
          mutate={mutate}
          onChanged={load}
        />
      </Section>

      <Section title="接下來" description="即將或建議接著處理的項目。">
        <WorkItemList items={dashboard.next} empty="接下來沒有待辦。開放中的工作會顯示在認領列表。" pending={pending} mutate={mutate} onChanged={load} />
      </Section>

      <Section title="其他社群工作" description="未列在上方的社群工作；開放中的可直接認領。">
        <WorkItemList items={catalog} empty="目前沒有其他社群工作。你可以在頁尾發布一張，或稍後再來看。" pending={pending} mutate={mutate} onChanged={load} />
      </Section>

      <Section title="待你回饋" description="只列出目前指派給你的項目。實際貢獻者不能審自己的提交。">
        {dashboard.review_queue.length === 0 ? (
          <EmptyState title="沒有待回饋項目" body="有指派給你的提交時會出現在這裡。沒有指派就不顯示回饋操作。" />
        ) : (
          <div className="card-grid">
            {dashboard.review_queue.map((entry) => (
              <ReviewCard key={entry.claim.claim_id} entry={entry} pending={pending} mutate={mutate} onChanged={load} />
            ))}
          </div>
        )}
      </Section>

      <Section title="已獲得的成果" description="當事人已接受的提交紀錄，非正式官方標示。">
        {dashboard.gained.length === 0 ? (
          <EmptyState title="還沒有已接受的成果" body="完成認領、提交並經對方接受後，會顯示在這裡。" />
        ) : (
          <div className="card-grid">
            {dashboard.gained.map((gain) => (
              <article key={gain.contribution_id} className="card">
                <h3>{gain.title}</h3>
                <p className="multiline-text">{gain.summary}</p>
                <dl className="meta">
                  <div>
                    <dt>成果引用</dt>
                    <dd>
                      <code>{gain.artifact_ref}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>接受時間</dt>
                    <dd>{formatIsoLocal(gain.accepted_at)}</dd>
                  </div>
                </dl>
                <BenefitObservations client={client} workItemId={gain.work_item_id}/>
              </article>
            ))}
          </div>
        )}
      </Section>

      <CreateWorkForm pending={pending} mutate={mutate} onCreated={load} />
    </div>
  )
}

function WorkItemList({
  items,
  empty,
  pending,
  mutate,
  onChanged,
}: {
  items: WorkItem[]
  empty: string
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  if (items.length === 0) return <EmptyState title="目前沒有項目" body={empty} />
  return (
    <div className="card-grid">
      {items.map((item) => (
        <WorkItemCard key={item.work_item_id} item={item} pending={pending} mutate={mutate} onChanged={onChanged} />
      ))}
    </div>
  )
}

function WorkItemCard({
  item,
  pending,
  mutate,
  onChanged,
}: {
  item: WorkItem
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { session } = usePortal()
  const claim = item.my_claim
  const busy = Boolean(pending)
  const claimExpired = isPastIso(item.claim_window_expires_at)
  const [summary, setSummary] = useState('')
  const [artifactRef, setArtifactRef] = useState('artifact:template-v1')
  const [formError, setFormError] = useState<string | null>(null)

  async function claimItem() {
    if (!session.user.profession_membership_ref) return
    const ok = await mutate(`claim:${item.work_item_id}`, async (key) => {
      await client.post<WorkClaim>(
        `/work-items/${item.work_item_id}:claim`,
        {
          claimant_type: 'user',
          acting_profession_membership_ref: session.user.profession_membership_ref,
          expected_aggregate_version: item.aggregate_version,
          terms_status: 'declared',
          participation_terms_revision: item.participation_terms_revision,
          participation_terms_sha256: item.participation_terms_sha256,
        },
        { idempotencyKey: key, ifMatch: item.aggregate_version },
      )
    })
    if (ok) await onChanged()
  }

  async function startClaim() {
    if (!claim) return
    const ok = await mutate(`start:${claim.claim_id}`, async (key) => {
      await client.post(`/work-claims/${claim.claim_id}:start`, {}, { idempotencyKey: key, ifMatch: claim.aggregate_version })
    })
    if (ok) await onChanged()
  }

  async function submitClaim(event: React.FormEvent) {
    event.preventDefault()
    if (!claim) return
    setFormError(null)
    const artifact = artifactRef.trim()
    if (!artifact || looksLikeUrl(artifact)) {
      setFormError('成果引用須為不透明代號，例如 artifact:template-v1，不可填網址或私人資料')
      return
    }
    const ok = await mutate(`submit:${claim.claim_id}`, async (key) => {
      await client.post(
        `/work-claims/${claim.claim_id}:submit`,
        { summary: summary.trim(), artifact_ref: artifact },
        { idempotencyKey: key, ifMatch: claim.aggregate_version },
      )
    })
    if (ok) {
      setSummary('')
      await onChanged()
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3>{item.title}</h3>
        <div className="pill-row">
          <span className="pill">{workStateLabel(item.state)}</span>
          {claim && <span className="pill pill-green">{claimStateLabel(claim.state)}</span>}
          {item.review_capacity === 'waiting_reviewer_capacity' && <span className="pill">尚無回饋容量</span>}
        </div>
      </div>
      <p className="multiline-text">{item.objective}</p>
      <dl className="meta">
        <div>
          <dt>完成條件</dt>
          <dd className="multiline-text">{item.acceptance_criteria}</dd>
        </div>
        <div>
          <dt>幫助者當次收益</dt>
          <dd className="multiline-text">{item.gain}</dd>
        </div>
        <div>
          <dt>認領期限</dt>
          <dd>{formatIsoLocal(item.claim_window_expires_at)}</dd>
        </div>
        <div>
          <dt>完成期限</dt>
          <dd>{formatIsoLocal(item.due_at)}</dd>
        </div>
        {item.participation_terms?.participation_mode && (
          <div>
            <dt>參與方式</dt>
            <dd>{participationModeLabel(item.participation_terms.participation_mode)}</dd>
          </div>
        )}
      </dl>
      {item.participation_terms?.reuse?.consent_required && <p className="hint">{!item.participation_terms.reuse.artifact_license_ref||item.participation_terms.reuse.artifact_license_ref==='local-demo-author-consent'?'成果重用前仍需取得權利人同意；目前未記錄明確授權。':'成果重用前請確認記錄的授權與權利人同意。'}</p>}
      {item.review_capacity === 'waiting_reviewer_capacity' && (
        <p className="hint">目前沒有回饋容量，仍可認領與提交，但不保證有人回饋，也不表示官方品管。</p>
      )}
      {claim?.feedback && (
        <p className="feedback">
          <strong>回饋：</strong>
          <span className="multiline-text">{claim.feedback}</span>
        </p>
      )}
      {claim?.latest_submission && (
        <p className="hint">
          最近提交：<span className="multiline-text">{claim.latest_submission.summary}</span>（<code>{claim.latest_submission.artifact_ref}</code>）
        </p>
      )}
      {!claim && item.state === 'open' && item.owner_ref !== session.user.user_id && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || claimExpired || !session.user.profession_membership_ref}
            onClick={() => void claimItem()}
          >
            認領這張工作
          </button>
          {claimExpired && <p className="hint">認領期限已過。</p>}
          {!session.user.profession_membership_ref && <p className="hint">先到「職業公會」加入一個公會，才能以該職業身分認領。</p>}
        </div>
      )}
      {!claim && item.state === 'open' && isOwnRef(session.user, item.owner_ref) && <p className="hint">這是你發布的工作，等待夥伴自願認領。</p>}
      {claim?.state === 'claimed' && (
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void startClaim()}>
            開始進行
          </button>
        </div>
      )}
      {claim && (claim.state === 'in_progress' || claim.state === 'changes_requested') && (
        <form className="stack" onSubmit={(event) => void submitClaim(event)}>
          {formError && (
            <p className="banner banner-error" role="alert">
              {formError}
            </p>
          )}
          <label className="field">
            <span className="field-label">提交摘要</span>
            <textarea required rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">成果引用（例如 artifact:template-v1）</span>
            <input
              required
              value={artifactRef}
              onChange={(event) => setArtifactRef(event.target.value)}
              disabled={busy}
              placeholder="artifact:template-v1"
            />
            <span className="field-hint">填成果代號，例如 artifact:logo-v1。檔案另行分享，別貼含登入權限的連結或私人資料。</span>
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            提交成果
          </button>
        </form>
      )}
      {claim?.state === 'submitted' && <p className="hint">已提交，等待回饋。</p>}
      {claim?.state === 'in_review' && <p className="hint">回饋進行中。</p>}
      {claim?.state === 'accepted' && <p className="hint">這次提交已被接受，非正式官方品管。</p>}
      {(isOwnRef(session.user,item.owner_ref)||(claim&&claim.state!=='claimed'))&&<BenefitObservations client={client} workItemId={item.work_item_id}/>}
    </article>
  )
}

function ReviewCard({
  entry,
  pending,
  mutate,
  onChanged,
}: {
  entry: ReviewQueueItem
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { isMe } = usePortal()
  const [decision, setDecision] = useState<'accept' | 'changes_requested'>('accept')
  const [feedback, setFeedback] = useState('')
  const busy = Boolean(pending)
  const self = isMe(entry.claim.claimant_ref)

  if (self) {
    return (
      <article className="card">
        <h3>{entry.work_item.title}</h3>
        <p className="hint">實際貢獻者不能回饋自己的提交。</p>
      </article>
    )
  }

  async function beginReview() {
    const ok = await mutate(`begin-review:${entry.claim.claim_id}`, async (key) => {
      await client.post(`/work-claims/${entry.claim.claim_id}:begin-review`, {}, {
        idempotencyKey: key,
        ifMatch: entry.claim.aggregate_version,
      })
    })
    if (ok) await onChanged()
  }

  async function decide(event: React.FormEvent) {
    event.preventDefault()
    const sha = entry.claim.latest_submission?.sha256
    if (!sha) return
    if (decision === 'changes_requested' && !feedback.trim()) return
    const ok = await mutate(`decide:${entry.claim.claim_id}`, async (key) => {
      await client.post(
        `/work-claims/${entry.claim.claim_id}:decide`,
        {
          decision,
          feedback: feedback.trim(),
          submission_sha256: sha,
        },
        { idempotencyKey: key, ifMatch: entry.claim.aggregate_version },
      )
    })
    if (ok) await onChanged()
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3>{entry.work_item.title}</h3>
        <span className="pill pill-green">{claimStateLabel(entry.claim.state)}</span>
      </div>
      <p>提交者：{entry.claimant_name}</p>
      {entry.claim.latest_submission ? (
        <p>
          提交摘要：<span className="multiline-text">{entry.claim.latest_submission.summary}</span>（<code>{entry.claim.latest_submission.artifact_ref}</code>）
        </p>
      ) : (
        <p className="hint">尚無提交成果，無法作成決定。</p>
      )}
      {entry.claim.state === 'submitted' && (
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void beginReview()}>
            開始回饋
          </button>
        </div>
      )}
      {entry.claim.state === 'in_review' && entry.claim.latest_submission && (
        <form className="stack" onSubmit={(event) => void decide(event)}>
          <fieldset className="fieldset">
            <legend>決定</legend>
            <label className="choice">
              <input
                type="radio"
                name={`decision-${entry.claim.claim_id}`}
                checked={decision === 'accept'}
                onChange={() => setDecision('accept')}
                disabled={busy}
              />
              接受這次提交
            </label>
            <label className="choice">
              <input
                type="radio"
                name={`decision-${entry.claim.claim_id}`}
                checked={decision === 'changes_requested'}
                onChange={() => setDecision('changes_requested')}
                disabled={busy}
              />
              請對方調整
            </label>
          </fieldset>
          <label className="field">
            <span className="field-label">回饋說明</span>
            <textarea
              rows={3}
              required
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            送出決定
          </button>
        </form>
      )}
    </article>
  )
}

function CreateWorkForm({
  pending,
  mutate,
  onCreated,
}: {
  pending: string | null
  mutate: PortalContextValue['mutate']
  onCreated: () => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [gain, setGain] = useState('')
  const [estimated, setEstimated] = useState('60')
  const [maximum, setMaximum] = useState('90')
  const [claimBy, setClaimBy] = useState(() => hoursFromNowLocalInput(24 * 7))
  const [finishBy, setFinishBy] = useState(() => hoursFromNowLocalInput(24 * 14))
  const [willReview, setWillReview] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const busy = Boolean(pending)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      if (!/^\d+$/.test(estimated.trim()) || !/^\d+$/.test(maximum.trim())) {
        throw new Error('分鐘須為正整數，不會四捨五入')
      }
      const estimatedMinutes = Number(estimated)
      const maximumMinutes = Number(maximum)
      if (!Number.isInteger(estimatedMinutes) || estimatedMinutes <= 0) throw new Error('預估分鐘須為正整數')
      if (!Number.isInteger(maximumMinutes) || maximumMinutes < estimatedMinutes) {
        throw new Error('上限分鐘須為整數，且不可小於預估分鐘')
      }
      const ok = await mutate('create-work-item', async (key) => {
        await client.post(
          '/work-items',
          {
            title: title.trim(),
            objective: objective.trim(),
            acceptance_criteria: acceptance.trim(),
            gain: gain.trim(),
            estimated_minutes: estimatedMinutes,
            maximum_minutes: maximumMinutes,
            claim_by: localInputToIso(claimBy),
            finish_by: localInputToIso(finishBy),
            will_review: willReview,
          },
          { idempotencyKey: key },
        )
      })
      if (ok) {
        setTitle('')
        setObjective('')
        setAcceptance('')
        setGain('')
        setWillReview(false)
        await onCreated()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查表單')
    }
  }

  return (
    <section className="card">
      <h2>發布自願互助工作</h2>
      <p className="lede">說清楚需要什麼幫忙、花多少時間，以及怎樣算完成。由夥伴自願認領，平台不會自動派人。</p>
      {formError && (
        <p className="banner banner-error" role="alert">
          {formError}
        </p>
      )}
      <form className="stack" onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          <span className="field-label">標題</span>
          <input required value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">要解決的問題</span>
          <textarea required maxLength={1000} rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">完成條件</span>
          <textarea required rows={3} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">幫助者當次可得到什麼</span>
          <textarea required rows={2} value={gain} onChange={(event) => setGain(event.target.value)} disabled={busy} />
        </label>
        <div className="two-col">
          <label className="field">
            <span className="field-label">預估分鐘</span>
            <input required inputMode="numeric" value={estimated} onChange={(event) => setEstimated(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">上限分鐘</span>
            <input required inputMode="numeric" value={maximum} onChange={(event) => setMaximum(event.target.value)} disabled={busy} />
          </label>
        </div>
        <div className="two-col">
          <label className="field">
            <span className="field-label">認領期限</span>
            <input required type="datetime-local" value={claimBy} onChange={(event) => setClaimBy(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">完成期限</span>
            <input required type="datetime-local" value={finishBy} onChange={(event) => setFinishBy(event.target.value)} disabled={busy} />
          </label>
        </div>
        <label className="choice">
          <input type="checkbox" checked={willReview} onChange={(event) => setWillReview(event.target.checked)} disabled={busy} />
          我願意驗收這件工作的提交（不承諾即時回饋，也不是官方品管）
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          發布工作卡
        </button>
      </form>
    </section>
  )
}

