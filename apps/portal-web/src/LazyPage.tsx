import {Component, Suspense, type ReactNode} from 'react';

class PageErrorBoundary extends Component<{children: ReactNode; label: string}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="card stack" role="alert">
      <strong>{this.props.label}暫時無法開啟。</strong>
      <p>請確認網路後重新載入頁面。</p>
      <div className="messages-actions"><button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>重新載入頁面</button><a className="btn btn-ghost" href="/#home">返回首頁</a></div>
    </section>;
  }
}
export function PageLoadBoundary({children, label, resetKey}: {children: ReactNode; label: string; resetKey?: string}) {
  return <PageErrorBoundary key={resetKey ?? label} label={label}>
    <Suspense fallback={<div className="page-loading" role="status" aria-live="polite"><p><span className="request-feedback-progress" aria-hidden="true"/>正在開啟{label}…</p><div className="page-loading-placeholder" aria-hidden="true"/><div className="page-loading-placeholder" aria-hidden="true"/></div>}>
      {children}
    </Suspense>
  </PageErrorBoundary>;
}
