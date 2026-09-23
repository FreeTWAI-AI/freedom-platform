import { useEffect, useState } from 'react';
import type { ModulePanelProps } from './shared';
import type { TabId } from '../types';
import { WorkshopIcon } from '../WorkshopIcon';
import { loadLabels, type MemberCardData } from './Membership';
import { MemberAvatar } from './MemberAvatar';
import './HomeDesign.css';

const shortcuts: { id: TabId; title: string }[] = [
  { id: 'guilds', title: '我的公會' },
  { id: 'skills', title: '技能書架' },
  { id: 'cocreation', title: '一起開發' },
  { id: 'workbench', title: '我的工作' },
];
const entries: { id: TabId; title: string; description: string; cover: string }[] = [
  { id: 'supplier', title: '供貨中心', description: '刊登商品與供貨條件', cover: 'market-network' },
  { id: 'retail', title: '開店與銷售', description: '選品、建立商店與合作', cover: 'workshop-hub' },
  { id: 'opensource', title: '開源投稿', description: '登錄你的 GitHub 專案', cover: 'cooperation-forge' },
  { id: 'marketing', title: '行銷工作室', description: '撰寫介紹與記錄分享', cover: 'cooperation-forge' },
];

export function MemberHome({ client, session, onNavigate }: ModulePanelProps) {
  const [member, setMember] = useState<MemberCardData | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client.get<MemberCardData>(`/members/${session.user.user_id}`).then(data => { if (active) setMember(data); }).catch(() => { if (active) setLoadError('名片暫時無法載入，請重新整理。'); });
    void loadLabels(client).then(data => { if (active) setLabels(data); }).catch(() => {});
    return () => { active = false; };
  }, [client, session.user.user_id]);

  const nickname = member?.nickname ?? session.user.display_name;
  const featured = (member?.featured_capabilities ?? member?.capabilities.slice(0, 3) ?? []).slice(0, 3);
  const skillLabel = (id: string) => id.startsWith('custom:') ? id.slice(7) : labels[id] ?? id;

  return <div className="member-home freedom-home">
    <section className="member-card home-member-summary guild-base-hero" aria-label="我的會員摘要">
      <img className="guild-base-art" src="/art/rpg/workshop-hub.webp" alt="" width="1536" height="1024" fetchPriority="high"/>
      <div className="home-member-identity">
        <MemberAvatar nickname={nickname} avatarUrl={member?.avatar_url} className="home-member-initial"/>
        <div>
          <p className="home-member-name">{nickname}{member?.positioning_title && <span className="positioning-title">{member.positioning_title}</span>}</p>
          {member && <p className="home-member-guild">{member.primary_guild ? `主要公會 · ${member.primary_guild.name}` : '尚未設定主要公會'}</p>}
        </div>
      </div>
      {featured.length > 0 && <div className="member-featured home-member-skills" aria-label="擅長的能力">
        {featured.map(id => <span className="pill" key={id}>{skillLabel(id)}</span>)}
      </div>}
      <div className="home-member-actions"><button type="button" className="btn btn-ghost" onClick={() => onNavigate?.('account')}>編輯我的名片</button></div>
    </section>
    {loadError && <p role="alert" className="banner banner-error">{loadError}</p>}

    <nav className="home-shortcuts" aria-label="常用入口">
      {shortcuts.map(entry => <button key={entry.id} type="button" className="home-shortcut" onClick={() => onNavigate?.(entry.id)}>
        <WorkshopIcon name={entry.id}/><span>{entry.title}</span><span className="home-shortcut-arrow" aria-hidden="true">↗</span>
      </button>)}
    </nav>

    <section className="home-module-section" aria-labelledby="home-module-title">
      <header className="home-section-heading"><h2 id="home-module-title">商品、作品與推廣</h2></header>
      <div className="home-module-grid">
        {entries.map(entry => <article key={entry.id} className={`home-module-card home-module-${entry.id}`}>
          <div className="home-module-cover"><img src={`/art/rpg/${entry.cover}.webp`} alt="" width="768" height="512" loading="lazy"/></div>
          <div className="home-module-body">
            <h3 className="home-module-name">{entry.title}</h3>
            <p className="home-module-description">{entry.description}</p>
            <button type="button" className="btn home-module-button" onClick={() => onNavigate?.(entry.id)}>進入{entry.title}<span aria-hidden="true">↗</span></button>
          </div>
        </article>)}
      </div>
    </section>
  </div>;
}
