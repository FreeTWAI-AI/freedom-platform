import {useCallback, useEffect, useRef, useState} from 'react';
import type {AdminClient} from './admin-client';
import './AdminCredentials.css';

type Level = 'ok' | 'warning' | 'danger' | 'expired' | 'unknown';
type RenewalState = 'pending' | 'processing' | 'done' | 'failed';
type Renewal = {
  request_id: string;
  state: RenewalState;
  requested_at: string;
  processed_at: string | null;
  result_expires_at: string | null;
  error_code: string | null;
};
type Credential = {
  credential_key: 'github_metrics_token' | 'cloudflare_deploy_token';
  label: string;
  status: string;
  expires_at: string | null;
  days_left: number | null;
  checked_at: string | null;
  level: Level;
  renewable: boolean;
  open_request: Renewal | null;
  last_request: Renewal | null;
  renew_hint: string;
};

const LEVELS = new Set<Level>(['ok', 'warning', 'danger', 'expired', 'unknown']);
const LEVEL_LABEL: Record<Level, string> = {ok: '正常', warning: '即將到期', danger: '急需處理', expired: '已過期', unknown: '尚未檢查'};
const PENDING = '已送出，等待維護者主機處理（通常 5 分鐘內）';

function taipei(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  const hour = part('hour') === '24' ? '00' : part('hour');
  return `${part('year')}-${part('month')}-${part('day')} ${hour}:${part('minute')}`;
}
function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object') return false;
  const row = value as Credential;
  return (row.credential_key === 'github_metrics_token' || row.credential_key === 'cloudflare_deploy_token') && typeof row.label === 'string' && LEVELS.has(row.level);
}
function readItems(value: {items?: unknown}): Credential[] {
  return Array.isArray(value?.items) ? value.items.filter(isCredential) : [];
}
function alarm(item: Credential): string | null {
  if (item.level !== 'warning' && item.level !== 'danger' && item.level !== 'expired') return null;
  if (item.level === 'expired' || (item.days_left != null && item.days_left < 0)) return `${item.label} 已過期`;
  if (item.days_left != null) return `${item.label} 將於 ${item.days_left} 天後到期`;
  if (item.status === 'rejected') return `${item.label} 已被拒絕`;
  return `${item.label} 需要處理`;
}
function expiryLine(item: Credential): string {
  const when = item.expires_at ? taipei(item.expires_at) : '沒有到期時間';
  if (item.level === 'expired' || (item.days_left != null && item.days_left < 0)) return `${when} · 已過期`;
  if (item.days_left != null) return `${when} · 剩 ${item.days_left} 天`;
  return when;
}

export function AdminCredentials({client}: {client: AdminClient}) {
  const [items, setItems] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const value = await client.request<{items?: unknown}>('/credentials');
      if (ticket !== sequence.current) return;
      setItems(readItems(value));
    } catch (cause) {
      if (ticket !== sequence.current) return;
      setItems([]);
      setError(cause instanceof Error ? cause.message : '無法讀取憑證狀態。');
    } finally {
      if (ticket === sequence.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  async function renew() {
    setBusy(true);
    setError('');
    try {
      await client.request('/credentials/cloudflare_deploy_token/renewals', {});
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法送出續期。');
    } finally {
      setBusy(false);
    }
  }
  const alarms = items.map(alarm).filter((text): text is string => Boolean(text));
  return <>
    {alarms.length > 0 && <a className="admin-credential-banner" href="#admin-credentials">{alarms.join('；')}</a>}
    <section className="card admin-credentials" id="admin-credentials">
      <div className="card-head">
        <h2>憑證到期</h2>
        <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading || busy}>重新整理</button>
      </div>
      {loading && <p role="status">正在讀取憑證狀態</p>}
      {error && <p className="field-hint">{error}</p>}
      {!loading && !error && !items.length && <p className="muted">目前沒有憑證狀態</p>}
      {items.map(item => <article className="admin-credential-row" key={item.credential_key}>
        <div className="admin-credential-main">
          <div className="admin-credential-title">
            <h3>{item.label}</h3>
            <span className={`badge admin-credential-level admin-credential-level-${item.level}`}>{LEVEL_LABEL[item.level]}</span>
          </div>
          <p>{expiryLine(item)}</p>
          <p className="muted">{item.checked_at ? `上次檢查 ${taipei(item.checked_at)}` : '上次檢查 —'}</p>
          {item.credential_key === 'github_metrics_token' && <p>{item.renew_hint} <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">在 GitHub 管理權杖</a></p>}
          {item.credential_key === 'cloudflare_deploy_token' && <>
            <p className="muted">{item.renew_hint}</p>
            {item.last_request?.state === 'done' && <p>{item.last_request.result_expires_at ? `已延長至 ${taipei(item.last_request.result_expires_at)}` : '已延長'}</p>}
            {item.last_request?.state === 'failed' && <p>續期失敗：{item.last_request.error_code ?? ''}</p>}
          </>}
        </div>
        {item.renewable && <div className="admin-credential-actions">
          <button type="button" className="btn btn-ghost" disabled={busy || Boolean(item.open_request)} onClick={() => void renew()}>{item.open_request ? PENDING : '續期'}</button>
        </div>}
      </article>)}
    </section>
  </>;
}
