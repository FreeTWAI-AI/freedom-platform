import { useEffect, useState } from 'react';
import { WorkshopIcon } from './WorkshopIcon';
import type { TabId } from './types';

export const TAB_TITLES: Record<TabId, string> = {
  home: '會員首頁', positioning: '我的定位', guilds: '職業公會', skills: '技能書架',
  members: '工坊夥伴', account: '我的名片', cocreation: '一起開發', squads: '小隊集合',
  opensource: '開源投稿', workbench: '我的工作', showcase: '作品與需求', engagement: '合作紀錄',
  supplier: '供貨中心', retail: '開店與銷售', marketing: '行銷工作室',
  'guild-workspace': '公會管理', community: '自由工坊社群',
  todos: '待辦清單', messages: '我的訊息',
};

const primary: TabId[] = ['home', 'positioning', 'guilds', 'skills', 'members'];
const groups: { label: string; pages: TabId[] }[] = [
  { label: '一起協作', pages: ['cocreation', 'squads', 'opensource', 'workbench', 'showcase', 'engagement'] },
  { label: '供貨與銷售', pages: ['supplier', 'retail', 'marketing'] },
  { label: '管理', pages: ['guild-workspace'] },
];

export function Navigation({ current, onSelect, canManageGuild, mobileOpen }: {
  current: TabId; onSelect: (id: TabId) => void; canManageGuild: boolean; mobileOpen: boolean;
}) {
  const [expanded, setExpanded] = useState<string[]>(() => groups.filter(group => group.pages.includes(current)).map(group => group.label));
  useEffect(() => { setExpanded(groups.filter(group => group.pages.includes(current)).map(group => group.label)); }, [current]);
  const item = (id: TabId) => <button key={id} type="button" className={`nav-item${current === id ? ' is-active' : ''}`}
    aria-current={current === id ? 'page' : undefined} onClick={() => onSelect(id)}>
    <WorkshopIcon name={id}/><span>{TAB_TITLES[id]}</span>
  </button>;
  return <nav id="workspace-navigation" className={`nav workspace-navigation${mobileOpen ? ' is-open' : ''}`} aria-label="主要工作區">
    <div className="nav-primary">{primary.map(item)}</div>
    {groups.map(group => <details className="nav-section" key={group.label} open={expanded.includes(group.label)}>
      <summary onClick={event => { event.preventDefault(); setExpanded(value => value.includes(group.label) ? value.filter(label => label !== group.label) : [...value, group.label]); }}>
        {group.label}<span aria-hidden="true">⌄</span>
      </summary>
      <div className="nav-section-items">
        {group.pages.filter(id => id !== 'guild-workspace' || canManageGuild).map(item)}
        {group.label === '管理' && <a className="nav-item" href="/admin">平台管理 <span aria-hidden="true">↗</span></a>}
      </div>
    </details>)}
    <div className="nav-footer">{item('community')}</div>
  </nav>;
}
