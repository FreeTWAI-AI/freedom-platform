import { useCallback, useEffect, useRef, useState } from 'react';
import { requireItems } from '../api';
import { accessAwareFetch } from '../access-fetch';
import { client, describeError, usePortal } from '../portal-session';
import { ShowcaseDraftEditor } from './ShowcasePanel';
import './WorkSharing.css';

export type PersonalContentItem = { kind: 'showcase' | 'skill_submission' | 'event' | 'social_post'; id: string; title: string; status: string; version: string | number | null; path: string; visibility: string; actions: string[] };
const kinds: Record<PersonalContentItem['kind'], string> = { showcase: '作品', skill_submission: '技能投稿', event: '活動', social_post: '動態' };
const statuses: Record<string, string> = { draft: '私人草稿', withdrawn: '已撤下', awaiting_upload: '等待上傳', ready_for_review: '準備發布', revoked: '已撤銷', pending: '待審核', rejected: '需補充／已退回', cancelled: '已取消', published: '已發布', active: '已發布', hidden: '已隱藏', deleted: '已刪除' };
const visibility: Record<string, string> = { private: '僅本人可見', community: '本社群會員可見', public: '公開可索引', workshop: '工坊會員可見', guild: '指定公會可見', referral: '活動頁公開；報名需推薦連結', open: '公開活動頁' };
const actionLabels: Record<string, string> = { continue: '繼續', edit: '編輯', view: '查看', withdraw: '撤下', cancel: '取消活動', cancel_review: '取消審核', publish: '檢查並發布' };
const selectedShowcase = () => /^#my-content\/showcases\/([^/?]+)$/.exec(window.location.hash)?.[1] ?? null;
function actionPath(item: PersonalContentItem, action: string): string | null {
  const id = encodeURIComponent(item.id);
  if (item.kind === 'showcase') return action === 'view' ? `#showcase/${id}` : `#my-content/showcases/${id}`;
  if (item.kind === 'skill_submission') return action === 'view' && /^\/development\/submissions\/[0-9a-f-]{36}$/.test(item.path) ? item.path : `#opensource?submission=${id}&action=${encodeURIComponent(action)}`;
  if (item.kind === 'event') return `#events/${id}${action === 'edit' ? '?edit=1' : action === 'cancel' || action === 'cancel_review' ? '?action=cancel' : ''}`;
  return item.path.startsWith('#') ? item.path : null;
}

export function MyContent() {
  const { session } = usePortal();
  const [items, setItems] = useState<PersonalContentItem[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(selectedShowcase), [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('all');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    const sessionGeneration = client.sessionGeneration;
    const live = () => generation.current === current && sessionGeneration === client.sessionGeneration;
    setLoading(true); setError('');
    try {
      const rows = requireItems<PersonalContentItem>(await client.get('/me/content'), '我的內容');
      if (live()) setItems(rows);
    } catch (cause) { if (live()) setError(describeError(cause).message); }
    finally { if (live()) setLoading(false); }
  }, []);
  useEffect(() => { setItems([]); setFilter('all'); setCreating(false); void load(); return () => { generation.current++; }; }, [load, session.user.user_id, client.sessionGeneration]);
  useEffect(() => { const change = () => { setSelected(selectedShowcase()); setCreating(false); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  const close = () => { setCreating(false); setSelected(null); window.location.hash = 'my-content'; };
  if (creating || selected) return <ShowcaseDraftEditor key={selected ?? 'new'} id={selected} onChanged={() => void load()} onClose={close}/>;
  const shown = items.filter(item => filter === 'all' || item.kind === filter);
  return <div className="stack personal-content">
    <section className="card stack"><div className="section-head"><h2>草稿與已發布內容</h2><div className="actions"><button type="button" className="btn btn-secondary btn-small" onClick={() => setCreating(true)}>新增私人作品草稿</button><a className="btn btn-secondary btn-small" href="#opensource">投稿技能</a><a className="btn btn-secondary btn-small" href="#events">建立活動</a></div></div>
      <p className="hint">狀態、可見範圍與操作由原始作品、投稿及活動紀錄提供。保存草稿不會發布。</p>
      <label className="field">內容類型<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    </section>
    {loading && <p role="status">載入我的內容…</p>}
    {error && <div className="banner banner-error" role="alert">{error}<div className="actions"><button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>重新載入</button></div></div>}
    {!loading && !error && shown.length === 0 && <p className="empty">目前沒有這類內容。</p>}
    {!error && shown.map(item => <article className="card stack" key={`${item.kind}:${item.id}`} aria-label={`${kinds[item.kind]}：${item.title}`}>
      <div className="card-head"><h3 className="work-sharing-preview">{item.title || '未命名內容'}</h3><span className="pill">{kinds[item.kind]}</span></div>
      <dl className="meta"><div><dt>狀態</dt><dd>{statuses[item.status] ?? item.status}</dd></div><div><dt>可見範圍</dt><dd>{visibility[item.visibility] ?? item.visibility}</dd></div>{item.version !== null && <div><dt>來源版本</dt><dd>{item.version}</dd></div>}</dl>
      <div className="actions">{item.actions.map(action => { if (item.kind === 'social_post' && action === 'withdraw') return <SocialWithdrawal key={action} item={item} onChanged={() => void load()}/>; const path = actionPath(item, action); return path && actionLabels[action] ? <a className="btn btn-secondary btn-small" key={action} href={path}>{actionLabels[action]}</a> : null; })}</div>
    </article>)}
  </div>;
}

function SocialWithdrawal({ item, onChanged }: { item: PersonalContentItem; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = useRef<string | null>(null), mounted = useRef(true), locked = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function withdraw() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    key.current ??= crypto.randomUUID();
    const csrf = client.csrfToken;
    const generation = client.sessionGeneration;
    const live = () => mounted.current && generation === client.sessionGeneration;
    try {
      if (!csrf) throw new Error('請重新登入後再撤下動態。');
      const response = await accessAwareFetch(`/api/v1/social-posts/${encodeURIComponent(item.id)}`, {
        method: 'DELETE', credentials: 'same-origin', body: '{}',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': key.current },
      });
      if (!live()) return;
      if (!response.ok) {
        const problem = await response.json();
        throw new Error(problem.detail ?? '動態未能撤下。');
      }
      if (live()) onChanged();
    } catch (cause) { if (live()) setError(describeError(cause).message); }
    finally { locked.current = false; if (live()) setBusy(false); }
  }
  return <div className="stack">{confirm ? <><p>確認刪除「{item.title}」？原始動態會撤下。</p><div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void withdraw()}>{error ? '重試撤下' : '確認撤下'}</button><button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => setConfirm(false)}>取消</button></div></> : <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirm(true)}>撤下</button>}{error && <p role="alert">{error}</p>}</div>;
}
