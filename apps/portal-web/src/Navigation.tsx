import { useEffect, useRef, useState } from 'react';
import { WorkshopIcon } from './WorkshopIcon';
import type { TabId } from './types';
import {useLanguage} from './language';
import type {InterfaceMessage} from './interface-messages';

export const TAB_TITLES: Record<TabId, string> = {
  'private-ai': '私人工作與 AI', home: '會員首頁', positioning: '我的定位', guilds: '職業公會', skills: '技能書架',
  friends: '我的好友', members: '工坊夥伴', account: '我的名片', cocreation: '一起開發', squads: '小隊集合',
  opensource: '開源投稿', workbench: '我的工作', showcase: '作品與需求', engagement: '合作紀錄',
  supplier: '我有東西要賣', retail: '我可以賣東西', marketing: '行銷工作室',
  'guild-workspace': '公會管理', business: '業務空間', stores: '我的商店', community: '自由工坊社群',
  todos: '待辦清單', messages: '我的訊息', events: '社群活動', tasks: '社群任務',
  social: '社群分享', services: '社員服務', promotion: '推廣排行榜',
  highlights: '活動集錦',
};

const primary: TabId[] = ['home', 'social', 'messages', 'guilds', 'skills'];
const keywords:Partial<Record<TabId,string>>={messages:'聊天室 對話 私訊',members:'人才 找夥伴 媒合',skills:'學習 資源 免費',tasks:'任務 貢獻 參與','private-ai':'私人 AI 草稿 模型 執行',workbench:'工作 任務',showcase:'作品 分享 展示 需求 找人',opensource:'投稿 提交 上傳 GitHub 開源 工具 技能',supplier:'商品 商店 供應商',retail:'電商 販售 商店',account:'個人資料 設定 暱稱',friends:'朋友 好友 私訊',business:'業務 工作區 邀請',stores:'商店 開店 店鋪 商品 上架 發布'};
const groups: { label: string; pages: TabId[] }[] = [
  { label: '社群參與', pages: ['events', 'tasks', 'highlights'] },
  { label: '認識夥伴', pages: ['members', 'friends', 'positioning', 'squads', 'cocreation'] },
  { label: '分享推廣', pages: ['services', 'promotion'] },
  { label: '創作與合作', pages: ['workbench', 'private-ai', 'opensource', 'showcase', 'engagement'] },
  { label: '供貨與銷售', pages: ['stores', 'supplier', 'retail', 'marketing'] },
  { label: '管理', pages: ['guild-workspace', 'business'] },
];

export function Navigation({ current, onSelect, canManageGuild, guildLaunchpadEnabled, mobileOpen }: {
  current: TabId; onSelect: (id: TabId) => void; canManageGuild: boolean; guildLaunchpadEnabled: boolean; mobileOpen: boolean;
}) {
  const {t}=useLanguage();
  const groupKeys:Record<string,InterfaceMessage>={'社群參與':'nav.participation','認識夥伴':'nav.people','分享推廣':'nav.promotionGroup','創作與合作':'nav.creation','供貨與銷售':'nav.commerce','管理':'nav.management'};
  const [query,setQuery]=useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const nav = useRef<HTMLElement>(null), moreTrigger = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState<string[]>(() => groups.filter(group => group.pages.includes(current)).map(group => group.label));
  useEffect(() => { setExpanded(groups.filter(group => group.pages.includes(current)).map(group => group.label)); }, [current]);
  useEffect(() => { setMoreOpen(false); }, [current]);
  useEffect(() => { const close=(event:PointerEvent)=>{if(!nav.current?.contains(event.target as Node))setMoreOpen(false)};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close)},[]);
  const item = (id: TabId) => <button key={id} type="button" className={`nav-item${current === id ? ' is-active' : ''}`}
    aria-current={current === id ? 'page' : undefined} onClick={() => {setQuery('');onSelect(id)}}>
    <WorkshopIcon name={id}/><span>{t(`nav.${id}`)}</span>
  </button>;
  return <nav ref={nav} id="workspace-navigation" className={`nav workspace-navigation${mobileOpen ? ' is-open' : ''}`} aria-label={t('nav.main')} onKeyDown={event=>{if(event.key==='Escape'&&moreOpen){setMoreOpen(false);moreTrigger.current?.focus()}}}>
    <div className="nav-primary">{primary.map(item)}</div>
    <details className="nav-section nav-more" open={moreOpen}>
      <summary ref={moreTrigger} onClick={event => { event.preventDefault(); setMoreOpen(value => !value); }}>{t('nav.more')}<span aria-hidden="true">⌄</span></summary>
      <div className="nav-more-content">
    <label className="nav-search"><span className="sr-only">{t('nav.search')}</span><input type="search" value={query} onChange={event=>setQuery(event.target.value)} maxLength={80} placeholder={t('nav.example')}/></label>
    {query.trim()?<div className="nav-search-results" role="region" aria-label={t('nav.results')}>{(Object.keys(TAB_TITLES) as TabId[]).filter(id=>(id!=='guild-workspace'||canManageGuild)&&(!['business','stores'].includes(id)||guildLaunchpadEnabled)&&`${t(`nav.${id}`)} ${TAB_TITLES[id]} ${keywords[id]??''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item)}<p className="field-hint">{t('nav.searchHint')}</p></div>:<>
    {groups.map(group => <details className="nav-section" key={group.label} open={expanded.includes(group.label)}>
      <summary onClick={event => { event.preventDefault(); setExpanded(value => value.includes(group.label) ? value.filter(label => label !== group.label) : [...value, group.label]); }}>
        {t(groupKeys[group.label])}<span aria-hidden="true">⌄</span>
      </summary>
      <div className="nav-section-items">
        {group.pages.filter(id => (id !== 'guild-workspace' || canManageGuild) && (!['business', 'stores'].includes(id) || guildLaunchpadEnabled)).map(item)}
        {group.label === '管理' && <a className="nav-item" href="/admin">{t('nav.admin')} <span aria-hidden="true">↗</span></a>}
      </div>
    </details>)}
    <div className="nav-footer">{item('community')}</div>
    </>}
      </div>
    </details>
  </nav>;
}
