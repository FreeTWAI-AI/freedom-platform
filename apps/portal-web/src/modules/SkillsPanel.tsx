import { useEffect, useState } from 'react';
import { RepositoryLibrary } from './Community';
import type { ModulePanelProps } from './shared';

export function SkillsPanel({ client, onNavigate }: ModulePanelProps) {
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [ids, setIds] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError(''); setIds(null);
    void client.get<{ items: { book_id: string }[] }>('/me/skill-books').then(result => {
      if (active) setIds(result.items.map(book => book.book_id));
    }).catch(() => { if (active) setError('我的技能書暫時無法載入。'); });
    return () => { active = false; };
  }, [client, reload]);
  return <section className="module-panel skills-panel" aria-label="技能書目錄">
    <div className="page-toolbar">
      <div className="scope-tabs" role="group" aria-label="技能書範圍">
        <button className="btn btn-ghost" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>全部技能書</button>
        <button className="btn btn-ghost" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>我的技能書{ids ? ` · ${ids.length}` : ''}</button>
      </div>
      <button className="btn btn-ghost" onClick={() => onNavigate?.('opensource')}>投稿開源作品</button>
    </div>
    {scope === 'mine' && error ? <div role="alert" className="banner banner-error">{error}<button className="btn btn-ghost" onClick={() => setReload(value => value + 1)}>重新載入我的技能書</button></div>
      : scope === 'mine' && ids === null ? <p role="status">正在載入我的技能書…</p>
      : <>
        {scope === 'mine' && ids?.length === 0 && <div className="empty"><p>加入公會，領取你的技能書。</p><button className="btn btn-primary" onClick={() => onNavigate?.('guilds')}>選擇公會</button></div>}
        <RepositoryLibrary key={scope} client={client} ids={scope === 'mine' ? ids ?? [] : undefined} title={scope === 'mine' ? '我的技能書' : '全部技能書'} compact/>
      </>}
  </section>;
}
