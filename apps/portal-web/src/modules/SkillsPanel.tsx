import { useEffect, useState } from 'react';
import { RepositoryLibrary } from './Community';
import type { ModulePanelProps } from './shared';

export function SkillsPanel({ client, onNavigate }: ModulePanelProps) {
  const [scope, setScope] = useState<'unlocked' | 'locked'>('unlocked');
  const [ids, setIds] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError(''); setIds(null);
    void client.get<{ items: { book_id: string }[] }>('/me/skill-books').then(result => {
      if (active) setIds([...new Set(result.items.map(book => book.book_id))]);
    }).catch(() => { if (active) setError('技能書解鎖紀錄暫時無法載入。'); });
    return () => { active = false; };
  }, [client, reload]);
  return <section className="module-panel skills-panel" aria-label="技能書目錄">
    <div className="page-toolbar">
      <div className="scope-tabs" role="group" aria-label="技能書範圍">
        <button className="btn btn-ghost" aria-pressed={scope === 'unlocked'} onClick={() => setScope('unlocked')}>已解鎖{ids ? ` · ${ids.length}` : ''}</button>
        <button className="btn btn-ghost" aria-pressed={scope === 'locked'} onClick={() => setScope('locked')}>未解鎖</button>
      </div>
      <button className="btn btn-ghost" onClick={() => onNavigate?.('opensource')}>投稿開源作品</button>
    </div>
    {error ? <div role="alert" className="banner banner-error">{error}<button className="btn btn-ghost" onClick={() => setReload(value => value + 1)}>重新載入解鎖紀錄</button></div>
      : ids === null ? <p role="status">正在載入解鎖紀錄…</p>
      : <>
        {(scope === 'locked' || ids.length === 0) && <div className="skill-unlock-prompt"><p>{scope === 'locked'?'加入公會即可解鎖對應技能書，也可先免費預覽。':'加入公會，領取你的技能書。'}</p><button className="btn btn-ghost" onClick={() => onNavigate?.('guilds')}>選擇公會</button></div>}
        <RepositoryLibrary key={scope} client={client} ids={scope === 'unlocked' ? ids : undefined} excludeIds={scope === 'locked'?ids:undefined} access={scope} title={scope === 'unlocked' ? '已解鎖技能書' : '未解鎖技能書'} compact/>
      </>}
  </section>;
}
