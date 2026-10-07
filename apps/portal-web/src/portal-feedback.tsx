import type React from 'react'
import type { ActionError } from './portal-session'

export function Section({ title, description, children, "data-guide-anchor": guideAnchor }: { title: string; description: string; children: React.ReactNode; "data-guide-anchor"?:string }) {
  return (
    <section className="section" data-guide-anchor={guideAnchor}>
      <header className="section-head">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  )
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

export function ErrorPanel({
  error,
  onReload,
  reloadLabel = '重新載入',
}: {
  error: ActionError
  onReload?: () => void
  reloadLabel?: string
}) {
  return (
    <div className="banner banner-error" role="alert">
      <p>{error.message}</p>
      {error.conflict && <p>資料可能已被其他人更新。請重新載入後再操作，不要重複送出同一筆動作。</p>}
      {error.network && <p>連線中斷時不會自動重送。若要重試同一筆動作，請使用「再試一次」。</p>}
      <div className="actions">
        {error.accessExpired && (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            重新載入頁面
          </button>
        )}
        {error.network && error.retry && (
          <button type="button" className="btn btn-primary" onClick={error.retry}>
            再試一次
          </button>
        )}
        {(error.conflict || onReload) && onReload && !error.accessExpired && (
          <button type="button" className="btn btn-ghost" onClick={onReload}>
            {reloadLabel}
          </button>
        )}
      </div>
    </div>
  )
}
