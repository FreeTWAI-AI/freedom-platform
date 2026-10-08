import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { publicDiscoverySchema, type PublicDiscovery as DiscoveryData, type PublicDiscoverySection } from '../../../../packages/shared/community-discovery';

const sections: { kind: PublicDiscoverySection['kind']; title: string; empty: string }[] = [
  { kind: 'resources', title: '公開資源', empty: '目前沒有可公開探索的資源。' },
  { kind: 'works', title: '會員作品', empty: '目前沒有可公開探索的作品。' },
  { kind: 'events', title: '近期活動', empty: '目前沒有可公開探索的近期活動。' },
  { kind: 'highlights', title: '活動回顧', empty: '目前沒有可公開探索的活動回顧。' },
  { kind: 'services', title: '會員服務', empty: '目前沒有可公開探索的會員服務。' },
];
const publicContentUuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const publicDiscoveryPathPattern = new RegExp(`^/(?:development/skills/[A-Za-z0-9_-]+|(?:development/submissions|events|highlights|services)/${publicContentUuid})$`);

// Only content routes, never referral codes, tokens, hashes or arbitrary destinations.
export function publicDiscoveryPath(value: string | null): string | null {
  if (!value) return null;
  return publicDiscoveryPathPattern.test(value) ? value : null;
}

export async function validatePublicReturn(path: string): Promise<boolean> {
  if (publicDiscoveryPath(path) !== path) return false;
  const site = await fetch('/api/v1/site', { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!site.ok || z.object({ community_discovery_enabled: z.boolean() }).parse(await site.json()).community_discovery_enabled !== true) return false;
  const eventId = /^\/events\/([^/]+)$/.exec(path)?.[1];
  const response = await fetch(eventId ? `/api/v1/public/events/${eventId}` : path, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) return false;
  if (eventId) {
    const event = z.object({ visibility: z.string() }).parse(await response.json());
    return event.visibility === 'open';
  }
  return response.headers.get('content-type')?.includes('text/html') === true;
}

export function PublicDiscovery({ onJoin, registrationEnabled }: { onJoin: () => void; registrationEnabled: boolean }) {
  const [data, setData] = useState<DiscoveryData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    // Clear revoked cards before every revalidation, including bfcache restoration.
    setData(null); setError(false); setLoading(true);
    void fetch('/api/v1/public/community-discovery', { cache: 'no-store', credentials: 'omit', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('unavailable'); return publicDiscoverySchema.parse(await response.json()); })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, []);
  useEffect(() => {
    refresh();
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { request.current?.abort(); window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  return <section className="public-discovery stack" aria-labelledby="discovery-heading">
    <header className="discovery-heading"><h1 id="discovery-heading">探索自由工坊</h1><p className="muted">先看看公開資源、作品與活動，找到想參與的事。</p>
      <div className="actions"><a className="btn btn-ghost" href="#discovery-resources">探索公開內容</a>{registrationEnabled && <button className="btn btn-primary" type="button" onClick={onJoin}>加入並分享</button>}</div>
    </header>
    {sections.map(({kind,title,empty}) => {
      const source = data?.sections.find(section => section.kind === kind);
      const unavailable = error || (!loading && (!source || source.state === 'unavailable'));
      return <section className="discovery-section" key={kind} aria-labelledby={`discovery-${kind}`} aria-busy={loading}>
        <h2 id={`discovery-${kind}`} tabIndex={-1}>{title}</h2>
        {loading ? <p className="muted" role="status">正在載入{title}…</p> : unavailable ? <div><p role="status">{title}暫時無法載入。{!error && '其他已載入的內容仍可探索。'}</p><button type="button" className="btn btn-ghost" onClick={refresh}>重新載入{title}</button></div> : !source?.items.length ? <p className="muted">{empty}</p> :
          <div className="discovery-cards">{source.items.map(item => {
            const path = publicDiscoveryPath(item.path);
            return path ? <article className="card discovery-card" key={item.id}><h3><a href={path}>{item.title}</a></h3><p>{item.summary}</p><div className="discovery-card-meta">{item.author_name && <span>由 {item.author_name} 分享</span>}{item.occurred_at && Number.isFinite(Date.parse(item.occurred_at)) && <time dateTime={item.occurred_at}>{new Date(item.occurred_at).toLocaleDateString('zh-TW')}</time>}</div></article> : null;
          })}</div>}
      </section>;
    })}
  </section>;
}
