import { useEffect, useState } from 'react';
import { WorkshopIcon } from './WorkshopIcon';
import type { TabId } from './types';

export const TAB_TITLES: Record<TabId, string> = {
  home: '會員首頁', positioning: '我的定位', guilds: '職業公會', skills: '技能書架',
  friends: '我的好友', members: '工坊夥伴', account: '我的名片', cocreation: '一起開發', squads: '小隊集合',
  opensource: '開源投稿', workbench: '我的工作', showcase: '作品與需求', engagement: '合作紀錄',
  supplier: '我有東西要賣', retail: '我可以賣東西', marketing: '行銷工作室',
  'guild-workspace': '公會管理', community: '自由工坊社群',
  todos: '待辦清單', messages: '我的訊息', events: '社群活動', tasks: '社群任務',
};

const primary: TabId[] = ['home', 'guilds', 'skills', 'messages', 'events', 'tasks'];
const keywords:Partial<Record<TabId,string>>={messages:'聊天室 對話 私訊',members:'人才 找夥伴 媒合',skills:'學習 資源 免費',tasks:'任務 貢獻 參與',workbench:'工作 任務',showcase:'作品 需求 找人',supplier:'商品 商店 供應商',retail:'電商 販售 商店',account:'個人資料 設定 暱稱',friends:'朋友 好友 私訊'};
const groups: { label: string; pages: TabId[] }[] = [
  { label: '認識夥伴', pages: ['members', 'friends', 'positioning', 'squads', 'cocreation'] },
  { label: '創作與合作', pages: ['workbench', 'opensource', 'showcase', 'engagement'] },
  { label: '供貨與銷售', pages: ['supplier', 'retail', 'marketing'] },
  { label: '管理', pages: ['guild-workspace'] },
];

export function Navigation({ current, onSelect, canManageGuild, mobileOpen }: {
  current: TabId; onSelect: (id: TabId) => void; canManageGuild: boolean; mobileOpen: boolean;
}) {
  const [query,setQuery]=useState('');
  const [expanded, setExpanded] = useState<string[]>(() => groups.filter(group => group.pages.includes(current)).map(group => group.label));
  useEffect(() => { setExpanded(groups.filter(group => group.pages.includes(current)).map(group => group.label)); }, [current]);
  const item = (id: TabId) => <button key={id} type="button" className={`nav-item${current === id ? ' is-active' : ''}`}
    aria-current={current === id ? 'page' : undefined} onClick={() => {setQuery('');onSelect(id)}}>
    <WorkshopIcon name={id}/><span>{TAB_TITLES[id]}</span>
  </button>;
  return <nav id="workspace-navigation" className={`nav workspace-navigation${mobileOpen ? ' is-open' : ''}`} aria-label="主要工作區">
    <label className="nav-search"><span className="sr-only">搜尋功能</span><input type="search" value={query} onChange={event=>setQuery(event.target.value)} maxLength={80} placeholder="找功能，例如：聊天室"/></label>
    {query.trim()?<div className="nav-search-results" aria-label="功能搜尋結果">{(Object.keys(TAB_TITLES) as TabId[]).filter(id=>(id!=='guild-workspace'||canManageGuild)&&`${TAB_TITLES[id]} ${keywords[id]??''}`.includes(query.trim())).map(item)}<p className="field-hint">輸入其他關鍵字可換一組結果。</p></div>:<>
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
    </>}
  </nav>;
}
