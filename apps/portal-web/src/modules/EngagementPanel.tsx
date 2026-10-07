import React, { useCallback, useEffect, useState } from 'react'
import { requireItems } from '../api'
import { client, usePortal, describeError, type ActionError, type PortalContextValue } from '../portal-session'
import { ErrorPanel } from '../portal-feedback'
import { ModuleBanner } from './ModuleBanner'
import { engagementStateLabel, formatIsoLocal, formatMinor, localInputToIso, looksLikeUrl, parseMajorToMinor } from '../format'
import type { Engagement } from '../types'

export function EngagementPanel() {
  const { session, pending, mutate } = usePortal()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ActionError | null>(null)
  const [engagements, setEngagements] = useState<Engagement[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const payload = await client.get<unknown>('/engagements')
      setEngagements(requireItems<Engagement>(payload, '合作紀錄'))
    } catch (err) {
      setEngagements(null)
      setLoadError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.user_id])

  if (loading && !engagements) return <p className="muted" role="status">載入合作紀錄…</p>
  if (loadError || !engagements) {
    return <ErrorPanel error={loadError ?? { message: '無法顯示合作紀錄', network: false, conflict: false }} onReload={() => void load()} />
  }

  return (
    <div className="panels">
      <ModuleBanner eyebrow="JOURNAL / 一起完成的旅程" title="約定、交付與確認" description=""/>
      <FlowLegend />
      <p className="lede">
        付款由雙方自行處理，平台只記錄約定與收款回報，不代收款，也不核實銀行入帳。
      </p>
      {engagements.length === 0 ? (
        <div className="empty">
          <strong>還沒有合作紀錄</strong>
          <p>先到<a href="#showcase">作品與需求</a>分享作品或提出需求；作者提出合作後，雙方都會在這裡看到紀錄。</p>
        </div>
      ) : (
        <div className="card-grid">
          {engagements.map((engagement) => (
            <EngagementCard
              key={engagement.engagement_id}
              engagement={engagement}
              pending={pending}
              mutate={mutate}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EngagementCard({
  engagement,
  pending,
  mutate,
  onChanged,
}: {
  engagement: Engagement
  pending: string | null
  mutate: PortalContextValue['mutate']
  onChanged: () => Promise<void>
}) {
  const { isMe } = usePortal()
  const [artifactRef, setArtifactRef] = useState('artifact:template-v1')
  const [amount, setAmount] = useState('')
  const [evidenceRef, setEvidenceRef] = useState('receipt:external-bank-001')
  const [receivedAt, setReceivedAt] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const busy = Boolean(pending)
  const clientSide = isMe(engagement.client_ref)
  const provider = isMe(engagement.provider_ref)

  async function run(actionId: string, path: string, body: unknown) {
    const ok = await mutate(actionId, async (key) => {
      await client.post(path, body, { idempotencyKey: key, ifMatch: engagement.aggregate_version })
    })
    if (ok) await onChanged()
  }

  async function deliver(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const artifact = artifactRef.trim()
      if (!artifact || looksLikeUrl(artifact)) throw new Error('成果引用須為不透明代號')
      await run(`deliver:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:deliver`, {
        artifact_ref: artifact,
      })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查交付內容')
    }
  }

  async function reportReceipt(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const amountMinor = parseMajorToMinor(amount)
      if (!evidenceRef.trim() || looksLikeUrl(evidenceRef)) throw new Error('請填寫不透明的回報引用')
      await run(`receipt:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}/receipts`, {
        amount_minor: amountMinor,
        currency: engagement.currency,
        evidence_ref: evidenceRef.trim(),
        received_at: receivedAt ? localInputToIso(receivedAt) : new Date().toISOString(),
      })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '請檢查收款回報')
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3 className="multiline-text">{engagement.scope}</h3>
        <span className="pill pill-green">{engagementStateLabel(engagement.state)}</span>
      </div>
      <p className="multiline-text">{engagement.acceptance_criteria}</p>
      <dl className="meta">
        <div>
          <dt>提供者</dt>
          <dd>{engagement.provider_name}</dd>
        </div>
        <div>
          <dt>委託人</dt>
          <dd>{engagement.client_name}</dd>
        </div>
        <div>
          <dt>約定價格</dt>
          <dd>{formatMinor(engagement.amount_minor, engagement.currency)}（非已收款）</dd>
        </div>
        {engagement.delivery_ref && (
          <div>
            <dt>交付引用</dt>
            <dd>
              <code>{engagement.delivery_ref}</code>
            </dd>
          </div>
        )}
      </dl>
      <ReceiptStatus receipt={engagement.receipt} />
      {waitingNote(engagement, clientSide, provider) && <p className="hint">{waitingNote(engagement, clientSide, provider)}</p>}
      {formError && (
        <p className="banner banner-error" role="alert">
          {formError}
        </p>
      )}
      {clientSide && engagement.state === 'proposed' && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !engagement.terms_sha256}
            onClick={() => void run(`agree:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:agree`, {
              terms_sha256: engagement.terms_sha256,
            })}
          >
            同意這份合作
          </button>
        </div>
      )}
      {provider && engagement.state === 'agreed' && (
        <form className="stack" onSubmit={(event) => void deliver(event)}>
          <label className="field">
            <span className="field-label">成果引用（例如 artifact:template-v1）</span>
            <input required value={artifactRef} onChange={(event) => setArtifactRef(event.target.value)} disabled={busy} />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            標記已交付
          </button>
        </form>
      )}
      {clientSide && engagement.state === 'delivered' && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !engagement.terms_sha256}
            onClick={() => void run(`accept:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:accept`, {
              terms_sha256: engagement.terms_sha256,
            })}
          >
            接受交付
          </button>
        </div>
      )}
      {provider && engagement.state === 'accepted' && !engagement.receipt && (
        <form className="stack" onSubmit={(event) => void reportReceipt(event)}>
          <p className="hint">這是自行回報收到款項，不是銀行核對或平台代收。</p>
          <label className="field">
            <span className="field-label">回報金額（新台幣，最多兩位小數）</span>
            <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">回報引用</span>
            <input required value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} disabled={busy} />
            <span className="field-hint">例如 receipt:external-bank-001，不要貼對帳單或簽章網址。</span>
          </label>
          <label className="field">
            <span className="field-label">回報時間</span>
            <input type="datetime-local" step="0.001" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} disabled={busy} />
            <span className="field-hint">留空採送出時刻；回報不代表銀行已核實。</span>
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            送出收款回報
          </button>
        </form>
      )}
      {clientSide && engagement.receipt?.verification_status === 'self_reported' && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void run(`confirm-receipt:${engagement.engagement_id}`, `/engagements/${engagement.engagement_id}:confirm-receipt`, {})}
          >
            確認對方的收款回報
          </button>
        </div>
      )}
    </article>
  )
}

/** Tells each side what the other party still needs to do, so a card never looks stuck. */
function waitingNote(engagement: Engagement, clientSide: boolean, provider: boolean): string | null {
  if (provider && engagement.state === 'proposed') return '等待委託人同意這份合作；對方同意前不需要開始交付。'
  if (clientSide && engagement.state === 'agreed') return '等待提供者交付成果。'
  if (provider && engagement.state === 'delivered') return '已交付，等待委託人接受。'
  if (clientSide && engagement.state === 'accepted' && !engagement.receipt) return '等待提供者回報收款；付款由雙方自行處理，平台不代收。'
  if (provider && engagement.receipt?.verification_status === 'self_reported') return '等待委託人確認你的收款回報。'
  return null
}

function ReceiptStatus({ receipt }: { receipt: Engagement['receipt'] }) {
  if (!receipt) return <p className="hint">尚未有收款回報。</p>
  const amount = formatMinor(receipt.amount_minor, receipt.currency)
  if (receipt.verification_status === 'counterparty_confirmed') {
    return (
      <p className="status-note">
        雙方確認（未核對銀行）· {amount} · {formatIsoLocal(receipt.received_at)} · <code>{receipt.evidence_ref}</code>
      </p>
    )
  }
  return (
    <p className="status-note">
      收款回報／待對方確認 · {amount} · {formatIsoLocal(receipt.received_at)} · <code>{receipt.evidence_ref}</code>
    </p>
  )
}

function FlowLegend() {
  return (
    <ol className="flow" data-guide-anchor="engagement:workflow" aria-label="合作流程">
      <li>作品曝光</li>
      <li>商機</li>
      <li>合作</li>
      <li>交付</li>
      <li>實收回報</li>
    </ol>
  )
}

