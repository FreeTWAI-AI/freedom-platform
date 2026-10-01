import {createContext,useContext,useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {PortalClient} from '../api';
import {useGitHubSocialStore} from './GitHubSocial';
import './AuthorClaim.css';

export type PublicVerifiedPerson = {role: string; role_label: string; github_login: string; display_name: string};
export type PublicAuthorClaim = {
  book_id: string;
  status: 'unclaimed' | 'pending' | 'verified_original_author' | 'verified_maintainer' | 'disputed';
  label: string;
  verified: PublicVerifiedPerson[];
  attributed_author: string | null;
};
type Catalog = {items: PublicAuthorClaim[]};
type MemberClaim = {
  claim_id: string; role: string; role_label: string; state: string; state_label: string;
  evidence_url: string | null; statement: string; appeal_text: string | null; reason: string | null;
  version: number; can_withdraw: boolean; can_appeal: boolean; github_login: string;
};
type MemberView = {book_id: string; github_connected: boolean; github_login: string | null; public: PublicAuthorClaim; claims: MemberClaim[]};
type Snapshot = {data: Catalog | null; error: boolean};

const statuses = new Set(['unclaimed', 'pending', 'verified_original_author', 'verified_maintainer', 'disputed']);
const AuthorClaimContext = createContext<PortalClient | null>(null);
let snapshot: Snapshot = {data: null, error: false}, pending: Promise<void> | null = null, checkedAt = 0;
const listeners = new Set<() => void>();
function publish(next: Snapshot) { snapshot = next; for (const listener of listeners) listener(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function parseCatalog(value: unknown): Catalog {
  const data = value as Catalog;
  if (!data || !Array.isArray(data.items)) throw new Error('invalid_author_claims');
  return {items: data.items.map(item => {
    if (!item || typeof item.book_id !== 'string' || !statuses.has(item.status) || typeof item.label !== 'string' || !Array.isArray(item.verified)) throw new Error('invalid_author_claims');
    return {
      book_id: item.book_id, status: item.status, label: item.label,
      attributed_author: typeof item.attributed_author === 'string' ? item.attributed_author : null,
      verified: item.verified.map(person => {
        if (!person || typeof person.github_login !== 'string' || typeof person.display_name !== 'string' || typeof person.role_label !== 'string' || typeof person.role !== 'string') throw new Error('invalid_author_claims');
        return {role: person.role, role_label: person.role_label, github_login: person.github_login, display_name: person.display_name};
      }),
    };
  })};
}
export function refreshAuthorClaims(force = false) {
  if (pending) return pending;
  if (!force && snapshot.data && Date.now() - checkedAt < 60_000) return Promise.resolve();
  pending = (async () => {
    try {
      const response = await fetch('/api/v1/skills/author-claims', {credentials: 'omit', headers: {Accept: 'application/json'}});
      if (!response.ok) throw new Error('unavailable');
      publish({data: parseCatalog(await response.json()), error: false});
    } catch { publish({data: snapshot.data, error: true}); }
    finally { checkedAt = Date.now(); pending = null; }
  })();
  return pending;
}
export function useAuthorClaims() {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => { void refreshAuthorClaims(); }, []);
  return state;
}
export function AuthorClaimProvider({client, children}: {client: PortalClient; children: ReactNode}) {
  return <AuthorClaimContext.Provider value={client}>{children}</AuthorClaimContext.Provider>;
}
export function useAuthorClaimClient() { return useContext(AuthorClaimContext); }

function badgeClass(status: PublicAuthorClaim['status']) {
  if (status === 'verified_original_author' || status === 'verified_maintainer') return 'skill-badge skill-badge-official';
  if (status === 'pending') return 'skill-badge skill-badge-new';
  if (status === 'disputed') return 'skill-badge author-claim-disputed';
  return 'skill-badge';
}
export function AuthorClaimBadge({bookId}: {bookId?: string}) {
  const {data, error} = useAuthorClaims();
  const item = data?.items.find(entry => entry.book_id === bookId);
  if (!bookId || error || !item) return null;
  return <span className={badgeClass(item.status)} data-author-claim-status={item.status}>{item.label}</span>;
}

const roles = [['original_author', '原創作者'], ['co_original_author', '共同原創作者'], ['maintainer', '維護者']] as const;
export function AuthorClaimPanel({bookId}: {bookId: string}) {
  const client = useAuthorClaimClient();
  const social = useGitHubSocialStore();
  const [view, setView] = useState<MemberView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<(typeof roles)[number][0]>('original_author');
  const [evidence, setEvidence] = useState('');
  const [statement, setStatement] = useState('');
  const [declared, setDeclared] = useState(false);
  const [appeal, setAppeal] = useState('');
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    setError('');
    void client.get<MemberView>(`/me/skill-books/${encodeURIComponent(bookId)}/author-claim`).then(value => { if (!controller.signal.aborted) setView(value); }).catch(() => { if (!controller.signal.aborted) setError('認領狀態暫時無法載入'); });
    return () => controller.abort();
  }, [client, bookId]);
  if (!client) return null;
  async function reload() {
    if (!client) return;
    setView(await client.get<MemberView>(`/me/skill-books/${encodeURIComponent(bookId)}/author-claim`));
    await refreshAuthorClaims(true);
  }
  async function submit() {
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await client.post(`/me/skill-books/${encodeURIComponent(bookId)}/author-claims`, {role, statement, declared: true, ...(evidence.trim() ? {evidence_url: evidence.trim()} : {})});
      setStatement(''); setEvidence(''); setDeclared(false); setNotice('已送出認領，等待審核。審核完成前不會顯示為已核實。');
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '認領沒有送出，請稍後再試。'); }
    finally { setBusy(false); }
  }
  async function withdraw(claim: MemberClaim) {
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try { await client.post(`/me/author-claims/${claim.claim_id}/withdraw`, {}, {ifMatch: claim.version}); setNotice('已撤回這筆認領。'); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '撤回沒有完成，請重新整理。'); }
    finally { setBusy(false); }
  }
  async function sendAppeal(claim: MemberClaim) {
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try { await client.post(`/me/author-claims/${claim.claim_id}/appeal`, {appeal}, {ifMatch: claim.version}); setAppeal(''); setNotice('已送出申訴，重新進入審核。'); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '申訴沒有送出，請稍後再試。'); }
    finally { setBusy(false); }
  }
  const status = view?.public;
  return <section className="author-claim skill-intro-collaboration" aria-labelledby={`${bookId}-claim-title`}>
    <h3 id={`${bookId}-claim-title`}>認領這件原作</h3>
    {status ? <p data-author-claim-status={status.status}>{status.label}{status.verified.length > 0 && <>：{status.verified.map(person => `${person.role_label} @${person.github_login}（${person.display_name}）`).join('、')}</>}</p> : <p role="status">正在讀取認領狀態…</p>}
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {view && !view.github_connected && <div className="stack">
      <p>認領原作需要先連結 GitHub。工坊用連結得到的 GitHub 帳號編號對應申請人，不會把尚未審核的申請顯示成已核實。</p>
      {social.account.value?.configured ? <button type="button" className="btn btn-primary author-claim-submit" disabled={busy} onClick={() => { setBusy(true); void social.connect('#skills').then(url => { window.location.assign(url); }).catch(cause => { setError(cause instanceof Error ? cause.message : '無法連結 GitHub，請重試。'); setBusy(false); }); }}>連結 GitHub</button> : <p className="field-hint">請到個人設定的 GitHub 連結完成連接。</p>}
    </div>}
    {view?.github_connected && <form className="stack" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="field-hint">已連結 @{view.github_login}。送出後進入人工審核，不會因為 Repo 權限、GitHub App、平台投稿或公會職務而自動核實。</p>
      <label className="field">認領角色<select value={role} onChange={event => setRole(event.target.value as typeof role)}>{roles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field">證據網址（建議提供）<input value={evidence} onChange={event => setEvidence(event.target.value)} inputMode="url" autoComplete="off" maxLength={2000} placeholder="https://"/></label>
      <label className="field">聲明<textarea value={statement} onChange={event => setStatement(event.target.value)} required minLength={10} maxLength={1000} /></label>
      <label className="author-claim-declare"><input type="checkbox" checked={declared} onChange={event => setDeclared(event.target.checked)} /><span>我聲明這是本人提出的角色與說明，並了解審核完成前不會顯示為已核實。</span></label>
      <button className="btn btn-primary author-claim-submit" type="submit" disabled={busy || !declared || statement.trim().length < 10}>送出認領</button>
    </form>}
    {!!view?.claims.length && <ul className="author-claim-list">{view.claims.map(claim => <li key={claim.claim_id} className="stack">
      <p><span className={badgeClass(claim.state === 'disputed' ? 'disputed' : claim.state === 'pending' ? 'pending' : claim.state === 'verified' ? 'verified_original_author' : 'unclaimed')}>{claim.state_label}</span> {claim.role_label} · @{claim.github_login}</p>
      <p className="multiline-text">{claim.statement}</p>
      {claim.reason && <p className="field-hint">審核說明：{claim.reason}</p>}
      {claim.can_withdraw && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void withdraw(claim)}>撤回</button>}
      {claim.can_appeal && <form className="stack" onSubmit={event => { event.preventDefault(); void sendAppeal(claim); }}>
        <label className="field">申訴說明<textarea value={appeal} onChange={event => setAppeal(event.target.value)} minLength={10} maxLength={1000} required /></label>
        <button className="btn btn-ghost" type="submit" disabled={busy || appeal.trim().length < 10}>送出申訴</button>
      </form>}
    </li>)}</ul>}
  </section>;
}
