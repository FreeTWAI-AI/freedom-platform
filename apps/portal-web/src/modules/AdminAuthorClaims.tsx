import {useCallback, useEffect, useState} from 'react';
import {AdminClient} from './admin-client';

type Related = {claim_id: string; display_name: string; github_login: string; role_label: string; state_label: string; statement: string; evidence_url: string | null};
type Claim = {
  claim_id: string; display_name: string; github_login: string; github_user_id: string; role_label: string; state: string; state_label: string;
  evidence_url: string | null; statement: string; appeal_text: string | null; appeal_count: number; reason: string | null; version: number;
  submitted_at: string | null; source_snapshot: {book_id?: string; full_name?: string; url?: string; provider_repo_id?: string};
  repo: {full_name: string; current_url: string; provider_repo_id: string}; related_claims: Related[];
};
type Change = {book_id: string; book_title: string; provider_repo_id: string; previous_provider_repo_id: string | null; full_name: string; requested_full_name: string};
type Queue = {queue: 'review' | 'verified'; items: Claim[]; identity_changes: Change[]};

export function AdminAuthorClaims({client, busy, onMutate}: {client: AdminClient; busy: boolean; onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>}) {
  const [queue, setQueue] = useState<'review' | 'verified'>('review');
  const [data, setData] = useState<Queue | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [ack, setAck] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await client.request<Queue>(`/author-claims?queue=${queue}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '無法載入認領審核。'); }
    finally { setLoading(false); }
  }, [client, queue]);
  useEffect(() => { void load(); }, [load]);
  async function review(claim: Claim, decision: 'verify' | 'reject' | 'dispute' | 'revoke') {
    const reason = (reasons[claim.claim_id] ?? '').trim();
    if (reason.length < 3) { setError('請填寫至少 3 個字的理由。'); return; }
    if (await onMutate(`/author-claims/${claim.claim_id}/review`, {decision, reason}, claim.version)) await load();
  }
  async function acknowledge(change: Change) {
    const reason = (ack[change.book_id] ?? '').trim();
    if (reason.length < 3) { setError('請填寫至少 3 個字的複核說明。'); return; }
    if (await onMutate(`/skill-books/${change.book_id}/author-claim-observation/acknowledge`, {reason})) await load();
  }
  return <section className="stack">
    <div className="card-head"><h2>作者認領審核</h2><button className="btn btn-ghost" type="button" disabled={busy || loading} onClick={() => void load()}>更新</button></div>
    <p className="muted">平台管理員審核原作者、共同原創作者與維護者認領。Repo 寫入權、GitHub App、平台投稿、公會職務與目錄署名都不會自動核實。不能審核自己提交、或連結到自己 GitHub 帳號的申請。</p>
    <div className="actions" role="tablist" aria-label="認領佇列">
      <button type="button" className={queue === 'review' ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => setQueue('review')}>待審核</button>
      <button type="button" className={queue === 'verified' ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => setQueue('verified')}>已核實</button>
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {loading && <p role="status">正在載入認領…</p>}
    {!!data?.identity_changes.length && <div className="stack">{data.identity_changes.map(change => <article key={change.book_id} className="card stack">
      <h3>原作 Repo 身分已變更</h3>
      <p>{change.book_title}：{change.requested_full_name} 現在是 {change.full_name}（{change.provider_repo_id}）。先前的認領留在 {change.previous_provider_repo_id}，沒有自動轉移。</p>
      <label className="field">複核說明<input value={ack[change.book_id] ?? ''} onChange={event => setAck(current => ({...current, [change.book_id]: event.target.value}))} maxLength={1000}/></label>
      <div className="actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onMutate(`/skill-books/${change.book_id}/author-claim-observation`, {}).then(ok => { if (ok) void load(); })}>重新讀取 GitHub</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void acknowledge(change)}>確認已複核</button>
      </div>
    </article>)}</div>}
    <div className="card-grid">{data?.items.map(claim => <article key={claim.claim_id} className="card stack">
      <div className="card-head"><h3>{claim.repo.full_name}</h3><span className="badge">{claim.state_label}</span></div>
      <p>{claim.role_label} · {claim.display_name} · @{claim.github_login}（{claim.github_user_id}）</p>
      <p className="field-hint">技能書 {claim.source_snapshot.book_id} · Repo {claim.repo.provider_repo_id}{claim.appeal_count > 0 ? ' · 申訴後重送' : ''}</p>
      <p>{claim.statement}</p>
      {claim.evidence_url && <p><a href={claim.evidence_url} target="_blank" rel="noopener noreferrer">查看證據 ↗</a></p>}
      {claim.appeal_text && <p>申訴：{claim.appeal_text}</p>}
      {claim.reason && <p className="field-hint">先前理由：{claim.reason}</p>}
      {!!claim.related_claims.length && <ul>{claim.related_claims.map(item => <li key={item.claim_id}>{item.display_name} @{item.github_login} · {item.role_label} · {item.state_label}</li>)}</ul>}
      <label className="field">審核理由<input value={reasons[claim.claim_id] ?? ''} onChange={event => setReasons(current => ({...current, [claim.claim_id]: event.target.value}))} maxLength={1000}/></label>
      <div className="actions">
        {(claim.state === 'pending' || claim.state === 'disputed') && <>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void review(claim, 'verify')}>核實</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void review(claim, 'reject')}>駁回</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void review(claim, 'dispute')}>標示爭議</button>
        </>}
        {claim.state === 'verified' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void review(claim, 'revoke')}>撤銷</button>}
      </div>
    </article>)}</div>
    {!loading && data && !data.items.length && !error && <p className="muted">{queue === 'verified' ? '目前沒有已核實的認領。' : '目前沒有待審核的認領。'}</p>}
  </section>;
}
