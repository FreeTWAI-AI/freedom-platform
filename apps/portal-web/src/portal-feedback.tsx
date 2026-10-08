import type React from 'react'
import type { ActionError } from './portal-session'
import {useLanguage} from './language'

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
  const {t}=useLanguage()
  return (
    <div className="banner banner-error" role="alert">
      <p>{error.message}</p>
      {error.conflict && <p>{t('feedback.conflict')}</p>}
      {error.network && <p>{t('feedback.network')}</p>}
      <div className="actions">
        {error.accessExpired && (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t('feedback.reloadPage')}
          </button>
        )}
        {error.network && error.retry && (
          <button type="button" className="btn btn-primary" onClick={error.retry}>
            {t('feedback.retry')}
          </button>
        )}
        {(error.conflict || onReload) && onReload && !error.accessExpired && (
          <button type="button" className="btn btn-ghost" onClick={onReload}>
            {reloadLabel==='重新載入'?t('feedback.reload'):reloadLabel}
          </button>
        )}
      </div>
    </div>
  )
}
