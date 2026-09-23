import { useEffect, useState } from 'react';
import type { ModulePanelProps } from './shared';
import type { TabId } from '../types';
import { BrandPoster, CommunityLinks } from './Community';
import { loadLabels, type MemberCardData } from './Membership';
import './HomeDesign.css';

const entries: { id: TabId; number: string; title: string; action: string; description: string; outcome: string; cover: string; category: string }[] = [
  { id: 'supplier', number: '01', title: '供貨中心', action: '我有實體商品可以供貨', description: '整理商品、供貨價格與出貨條件，找到願意合作的店主。', outcome: '商品資料 → 供貨方案 → 店主合作', cover: 'market-network', category: 'SUPPLY' },
  { id: 'retail', number: '02', title: '開店與銷售', action: '我要選品，經營自己的店', description: '從供貨目錄挑選商品，建立商店與售價，向供貨商提出合作。', outcome: '建立商店 → 選品 → 確認供貨', cover: 'workshop-hub', category: 'STORE' },
  { id: 'opensource', number: '03', title: '開源作品', action: '我要分享或尋找開源作品', description: '連結 GitHub 專案，說明用途與使用方式，讓別人看見和參與。', outcome: '連結專案 → 保存版本 → 分享與協作', cover: 'skill-codex', category: 'OPEN SOURCE' },
  { id: 'marketing', number: '04', title: '行銷工作室', action: '我要把作品介紹給對的人', description: '從具體作品與事實規劃內容，保存行銷草稿與自己的分享紀錄。', outcome: '選擇作品 → 撰寫內容 → 記錄分享', cover: 'cooperation-forge', category: 'STUDIO' },
];

type MemberDirection = {
  profile: { real_world_occupations: string[]; goals: string; desired_roles: string[]; weekly_minutes: number } | null;
  tracks: { track_key: string; name: string }[];
  recommendations: { name: string; first_result: string; reason: string }[];
};

export function MemberHome({ client, session, onNavigate }: ModulePanelProps) {
  const [member, setMember] = useState<MemberCardData | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState<MemberDirection | null>(null);
  const [guildNames, setGuildNames] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client.get<MemberCardData>(`/members/${session.user.user_id}`).then(data => { if (active) setMember(data); }).catch(() => {});
    void loadLabels(client).then(data => { if (active) setLabels(data); }).catch(() => {});
    return () => { active = false; };
  }, [client, session.user.user_id]);

  useEffect(() => {
    let active = true;
    Promise.all([
      client.get<MemberDirection>('/me/positioning'),
      client.get<{ items: { name: string; membership: { state: string } | null }[] }>('/guilds'),
    ]).then(([profile, guilds]) => {
      if (!active) return;
      setDirection(profile);
      setGuildNames(guilds.items.filter(g => g.membership?.state === 'active').map(g => g.name));
    }).catch(() => { if (active) setLoadError('暫時無法讀取你的定位與公會。仍可從下方進入各模組。'); });
    return () => { active = false; };
  }, [client, session.user.user_id]);

  const nickname = member?.nickname ?? session.user.display_name;
  const featured = (member?.featured_capabilities ?? member?.capabilities.slice(0, 3) ?? []).slice(0, 3);
  const abilities = [...(member?.capabilities ?? []), ...(member?.custom_capabilities ?? []).map(value => `custom:${value}`)];
  const equipment = [...(member?.equipment ?? []), ...(member?.custom_equipment ?? []).map(value => `custom:${value}`)];
  const skillLabel = (id: string) => id.startsWith('custom:') ? id.slice(7) : labels[id] ?? id;

  return <div className="member-home freedom-home">
    <section className="guild-base-hero" aria-labelledby="guild-base-title">
      <img className="guild-base-art" src="/art/rpg/workshop-hub.webp" alt="" width="1536" height="1024" fetchPriority="high"/>
      <div className="guild-base-copy">
        <p className="home-eyebrow"><span aria-hidden="true">✦</span> FREEDOM WORKSHOP / 會員基地</p>
        <h2 id="guild-base-title">你的專長，<br/>下一段共同創作。</h2>
        <p>{nickname}，歡迎回到自由工坊。<br/>帶上你的能力、商品與作品，找到一起實現的人。</p>
        <span className="guild-base-caption">自由創作，一起實現 <span aria-hidden="true">↗</span></span>
      </div>
      <div className="guild-base-coordinate" aria-hidden="true">BUILD WITHOUT LIMITS <span>✳</span></div>
    </section>

    {member && <section className="member-card home-member-summary" aria-label="我的會員摘要">
      <div className="home-member-identity">
        <div className="home-member-initial" aria-hidden="true">{member.nickname.slice(0, 1)}</div>
        <div>
          <p className="home-member-name">{member.nickname}<span className="positioning-title">{member.positioning_title ?? '探索自己的方向'}</span></p>
          <p className="home-member-guild">{member.primary_guild ? `主要公會 · ${member.primary_guild.name}` : '尚未設定主要公會'}</p>
        </div>
      </div>
      <div className="member-featured home-member-skills" aria-label="擅長的能力">
        {featured.length ? featured.map(id => <span className="pill" key={id}>{skillLabel(id)}</span>) : <span>還在探索自己的專長</span>}
      </div>
      <div className="home-member-actions">
        <button className="btn btn-ghost" onClick={() => onNavigate?.('account')}>編輯我的名片</button>
        <button className="btn btn-ghost" onClick={() => onNavigate?.('guilds')}>我的公會與技能書</button>
      </div>
      <details className="member-full-profile home-member-details">
        <summary>完整能力與裝備 · {abilities.length} 項能力／{equipment.length} 項裝備</summary>
        <div className="home-member-detail-grid">
          <div><h3>基本能力</h3><div className="tag-list">{abilities.length ? abilities.map(id => <span className="pill" key={id}>{skillLabel(id)}</span>) : <p className="muted">尚未填寫</p>}</div></div>
          <div><h3>裝備</h3><div className="tag-list">{equipment.length ? equipment.map(id => <span className="pill" key={id}>{skillLabel(id)}</span>) : <p className="muted">尚未填寫</p>}</div></div>
          <div><h3>次要公會</h3><p className="muted">{member.secondary_guilds.map(guild => guild.name).join('、') || '先專注在主要公會'}</p></div>
        </div>
      </details>
    </section>}

    <section className="home-module-section" aria-labelledby="home-module-title">
      <header className="home-section-heading">
        <div><p className="home-eyebrow">CHOOSE YOUR NEXT MOVE</p><h2 id="home-module-title">你今天想做什麼？</h2></div>
        <p>從一件想完成的事開始。</p>
      </header>
      <div className="home-module-grid">
        {entries.map(entry => <article key={entry.id} className={`home-module-card home-module-${entry.id}`}>
          <div className="home-module-cover">
            <img src={`/art/rpg/${entry.cover}.webp`} alt="" width="768" height="512" loading="lazy"/>
            <span className="home-module-index" aria-hidden="true">{entry.number} / {entry.category}</span>
          </div>
          <div className="home-module-body">
            <p className="home-module-name">{entry.title}</p>
            <h3>{entry.action}</h3>
            <p className="home-module-description">{entry.description}</p>
            <p className="home-module-outcome">{entry.outcome}</p>
            <button className="btn home-module-button" onClick={() => onNavigate?.(entry.id)}>進入{entry.title}<span aria-hidden="true">↗</span></button>
          </div>
        </article>)}
      </div>
    </section>

    <section className="home-direction" aria-labelledby="member-direction-title">
      <div className="home-direction-symbol" aria-hidden="true"><span>✳</span></div>
      <div className="home-direction-copy">
        <p className="home-eyebrow">CONTINUE YOUR JOURNEY</p>
        <h2 id="member-direction-title">我的定位</h2>
        {direction?.profile ? <>
          <p className="home-direction-goal">{direction.profile.goals || '從你選擇的方向，繼續下一步。'}</p>
          <p className="home-direction-detail">{direction.profile.real_world_occupations.join('、') || '尚未填寫目前身分'} · 每週可投入 {direction.profile.weekly_minutes} 分鐘</p>
          {guildNames.length > 0 && <p className="home-direction-detail">已加入：{guildNames.join('、')}</p>}
        </> : member?.primary_guild ? <>
          <p className="home-direction-goal">定位已完成{member.positioning_title ? ` · ${member.positioning_title}` : ''}</p>
          <p className="home-direction-detail">主要公會 · {member.primary_guild.name}</p>
          <p className="home-direction-detail">從公會技能書開始練習，或參與作品共創。合作偏好可以隨時補充。</p>
        </> : <>
          <p>整理你的專長、目標與可投入時間，找到適合的方向與公會。</p>
          <p className="home-direction-detail">定位可以隨時調整，讓方向跟著你的成長改變。</p>
        </>}
        {loadError && <p role="alert">{loadError}</p>}
      </div>
      <div className="home-direction-actions">
        <button className="btn btn-primary" onClick={() => onNavigate?.('positioning')}>整理我的定位</button>
        <button className="btn btn-ghost" onClick={() => onNavigate?.('guilds')}>看看職業公會</button>
      </div>
    </section>

    <section className="home-cooperation" aria-labelledby="home-cooperation-title">
      <div className="home-cooperation-image"><img src="/art/rpg/cooperation-forge.webp" alt="" width="768" height="512" loading="lazy"/></div>
      <div className="home-cooperation-copy">
        <p className="home-eyebrow">BETTER TOGETHER</p>
        <h2 id="home-cooperation-title">已經在一起做事？</h2>
        <p>回到你認領的工作，或繼續處理雙方的合作紀錄。<br/>每一個共同完成的成果，都從下一步開始。</p>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => onNavigate?.('workbench')}>查看我的工作</button>
          <button className="btn btn-ghost" onClick={() => onNavigate?.('engagement')}>查看合作紀錄</button>
        </div>
      </div>
    </section>
    <div className="home-community-signature"><BrandPoster compact/><CommunityLinks/></div>
  </div>;
}
