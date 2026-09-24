import { useEffect, useRef, useState } from 'react';
import { RepositoryLibrary } from './Community';
import type { ModulePanelProps } from './shared';
import { SkillUpload } from './SkillUpload';
import { CommunitySubmissions } from './CommunitySubmissions';
import { GitHubConnectionSummary } from './GitHubSocial';

export function SkillsPanel({ client, onNavigate }: ModulePanelProps) {
  const [scope, setScope] = useState<'unlocked' | 'locked'>('unlocked');
  const [ids, setIds] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [submissionsRevision,setSubmissionsRevision]=useState(0);
  const shown = useRef<string[] | null>(null), pending = useRef<string[] | null>(null), refocus = useRef(false), unlockedTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true, generation = 0;
    // Guild joins elsewhere (e.g. the development dialog) change grants. Keep any open book dialog
    // mounted and apply the new shelf once every dialog has closed.
    const apply = () => {
      if (!active || !pending.current || document.querySelector('dialog[open]')) return;
      const next = pending.current, added = next.filter(id => !shown.current?.includes(id)).length;
      pending.current = null; shown.current = next; refocus.current = true;
      setIds(next);
      if (added) setNotice(`已解鎖 ${added} 本新技能書，可在「已解鎖」查看。`);
    };
    const load = (initial: boolean) => {
      const current = ++generation;
      if (initial) { setError(''); setNotice(''); setIds(null); shown.current = null; pending.current = null; }
      void client.get<{ items: { book_id: string }[] }>('/me/skill-books').then(result => {
        if (!active || current !== generation) return;
        const next = [...new Set(result.items.map(book => book.book_id))];
        setError('');
        if (initial) { shown.current = next; setIds(next); } else { pending.current = next; apply(); }
      }).catch(() => { if (active && current === generation) setError(initial ? '技能書解鎖紀錄暫時無法載入。' : '技能書解鎖紀錄未能更新。'); });
    };
    const refresh = () => load(false);
    load(true);
    window.addEventListener('freedom-profile-updated', refresh);
    document.addEventListener('close', apply, true);
    return () => { active = false; window.removeEventListener('freedom-profile-updated', refresh); document.removeEventListener('close', apply, true); };
  }, [client, reload]);
  useEffect(() => {
    // A newly unlocked book leaves the locked list; keep keyboard focus inside the shelf.
    if (!refocus.current) return;
    refocus.current = false;
    if (!document.activeElement || document.activeElement === document.body) unlockedTab.current?.focus();
  }, [ids]);
  return <section className="module-panel skills-panel" aria-label="技能書目錄">
    <GitHubConnectionSummary returnTo="#skills" onManage={() => onNavigate?.('account')}/>
    <div className="page-toolbar">
      <div className="scope-tabs" role="group" aria-label="技能書範圍">
        <button ref={unlockedTab} className="btn btn-ghost" aria-pressed={scope === 'unlocked'} onClick={() => setScope('unlocked')}>已解鎖{ids ? ` · ${ids.length}` : ''}</button>
        <button className="btn btn-ghost" aria-pressed={scope === 'locked'} onClick={() => setScope('locked')}>未解鎖</button>
      </div>
      <div className="actions"><SkillUpload client={client} onPublished={()=>setSubmissionsRevision(value=>value+1)}/><button className="btn btn-ghost" onClick={() => onNavigate?.('opensource')}>手動登錄作品</button></div>
    </div>
    {notice && <p role="status" className="banner banner-info">{notice}</p>}
    {error && <div role="alert" className="banner banner-error">{error}<button className="btn btn-ghost" onClick={() => setReload(value => value + 1)}>重新載入解鎖紀錄</button></div>}
    {ids === null ? !error && <p role="status">正在載入解鎖紀錄…</p>
      : <>
        {(scope === 'locked' || ids.length === 0) && <div className="skill-unlock-prompt"><p>{scope === 'locked'?'加入公會即可解鎖對應技能書，也可先免費預覽。':'還沒有已解鎖的技能書。加入公會即可領取，也可先免費預覽。'}</p><div className="actions"><button className="btn btn-ghost" onClick={() => onNavigate?.('guilds')}>選擇公會</button>{scope === 'unlocked' && <button className="btn btn-primary" onClick={() => setScope('locked')}>免費預覽技能書</button>}</div></div>}
        {(scope === 'locked' || ids.length > 0) && <RepositoryLibrary key={scope} client={client} ids={scope === 'unlocked' ? ids : undefined} excludeIds={scope === 'locked'?ids:undefined} access={scope} title={scope === 'unlocked' ? '已解鎖技能書' : '未解鎖技能書'} compact/>}
      </>}
    <CommunitySubmissions client={client} revision={submissionsRevision}/>
  </section>;
}
