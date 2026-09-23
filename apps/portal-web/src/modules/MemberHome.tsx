import { useEffect, useState } from 'react';
import type { ModulePanelProps } from './shared';
import type { TabId } from '../types';

const entries: { id: TabId; number: string; title: string; action: string; description: string; outcome: string }[] = [
  { id: 'supplier', number: '01', title: '供貨中心', action: '我有實體商品可以供貨', description: '整理商品、供貨價格與出貨條件，找到願意合作的店主。', outcome: '商品資料 → 供貨方案 → 店主合作' },
  { id: 'retail', number: '02', title: '開店與銷售', action: '我要選品，經營自己的店', description: '從供貨目錄挑選商品，建立商店與售價，向供貨商提出合作。', outcome: '建立商店 → 選品 → 確認供貨' },
  { id: 'opensource', number: '03', title: '開源作品', action: '我要分享或尋找開源作品', description: '連結 GitHub 專案，說明用途與使用方式，讓別人看見和參與。', outcome: '連結專案 → 保存版本 → 分享與協作' },
  { id: 'marketing', number: '04', title: '行銷工作室', action: '我要把作品介紹給對的人', description: '從具體作品與事實規劃內容，保存行銷草稿與自己的分享紀錄。', outcome: '選擇作品 → 撰寫內容 → 記錄分享' },
];

type MemberDirection = {
  profile: { real_world_occupations: string[]; goals: string; desired_roles: string[]; weekly_minutes: number } | null;
  tracks: { track_key: string; name: string }[];
  recommendations: { name: string; first_result: string; reason: string }[];
};
export function MemberHome({ client, session, onNavigate }: ModulePanelProps) {
  const [direction, setDirection] = useState<MemberDirection | null>(null);
  const [guildNames, setGuildNames] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  return <div className="member-home">
    <section className="member-welcome">
      <div>
        <p className="eyebrow">YOUR PLACE TO BUILD</p>
        <h2>{session.user.display_name}，從你想參與的事開始。</h2>
        <p>把你的能力、商品與作品，接到需要它們的人。你可以同時參與不同角色。</p>
      </div>
      <span className="member-stage">內部預覽</span>
    </section>
    <section className="member-direction" aria-labelledby="member-direction-title">
      <div className="direction-copy">
        <span className="module-kicker">先認識自己，再選擇方向</span>
        <h2 id="member-direction-title">我的定位</h2>
        {direction?.profile ? <>
          <p className="direction-goal">{direction.profile.goals}</p>
          <p className="hint">{direction.profile.real_world_occupations.join('、') || '尚未填寫目前身分'} · 每週可投入 {direction.profile.weekly_minutes} 分鐘</p>
          {guildNames.length > 0 && <p className="hint">已加入：{guildNames.join('、')}</p>}
        </> : <>
          <p>整理你的專長、目標與可投入時間，選擇想發展的職業方向，找到一起成長的公會。</p>
          <p className="hint">定位可以隨時調整，也可以先逛其他模組。</p>
        </>}
        {loadError && <p role="alert">{loadError}</p>}
      </div>
      <div className="actions">
        <button className="btn btn-primary" onClick={() => onNavigate?.('positioning')}>整理我的定位</button>
        <button className="btn btn-ghost" onClick={() => onNavigate?.('guilds')}>看看職業公會</button>
      </div>
    </section>
    <div className="module-section-heading"><h2>你今天想做什麼？</h2><p>每個入口都有自己的工作流程。</p></div>
    <div className="module-grid">
      {entries.map(entry => <article key={entry.id} className={`module-entry module-entry-${entry.id}`}>
        <div className="module-entry-heading"><span className="module-number">{entry.number}</span><span className="module-kicker">{entry.title}</span></div>
        <h3>{entry.action}</h3>
        <p>{entry.description}</p>
        <p className="module-outcome">{entry.outcome}</p>
        <button className="btn btn-module" onClick={() => onNavigate?.(entry.id)}>進入{entry.title}<span aria-hidden="true">↗</span></button>
      </article>)}
    </div>
    <section className="member-common">
      <div><h2>已經在一起做事？</h2><p>回到你認領的工作，或繼續處理雙方的合作紀錄。</p></div>
      <div className="actions"><button className="btn btn-ghost" onClick={() => onNavigate?.('workbench')}>查看我的工作</button><button className="btn btn-ghost" onClick={() => onNavigate?.('engagement')}>查看合作紀錄</button></div>
    </section>
  </div>;
}
