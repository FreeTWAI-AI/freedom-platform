import {Component, Suspense, type ReactNode} from 'react';
import {useLanguage} from './language';

class PageErrorBoundary extends Component<{children: ReactNode; fallback: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback;
  }
}
export function PageLoadBoundary({children, label, resetKey}: {children: ReactNode; label: string; resetKey?: string}) {
  const {t} = useLanguage();
  return <PageErrorBoundary key={resetKey ?? label} fallback={<section className="card stack" role="alert">
    <strong>{t('page.unavailable',{label})}</strong>
    <p>{t('page.retryHint')}</p>
    <div className="messages-actions"><button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>{t('page.reload')}</button><a className="btn btn-ghost" href="/#home">{t('page.home')}</a></div>
  </section>}>
    <Suspense fallback={<div className="page-loading" role="status" aria-live="polite"><p><span className="request-feedback-progress" aria-hidden="true"/>{t('page.opening',{label})}</p><div className="page-loading-placeholder" aria-hidden="true"/><div className="page-loading-placeholder" aria-hidden="true"/></div>}>
      {children}
    </Suspense>
  </PageErrorBoundary>;
}
