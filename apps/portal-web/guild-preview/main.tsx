import {useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GuildBlock} from '../src/guild-blocks/runtime';
import {guildBlockLoaders} from '../src/guild-blocks/registry.generated';
import type {GuildBlockProps, GuildReadClient} from '../../../packages/guild-presentation/block';
import '../src/styles.css';
import '../src/rpg-theme.css';
import '../src/light-theme.css';
import '../src/versefolk-theme.css';
import './preview.css';

type Scenario = 'ready' | 'empty' | 'denied' | 'unavailable' | 'error' | 'loading' | 'missing-key';
const PREVIEW_GUILD_KEY = 'guild_preview_events';
const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
function syntheticClient(scenario: Scenario, generation: number): GuildReadClient {
  return {sessionGeneration: generation, async get<T>(path: string, options?: {signal?: AbortSignal}): Promise<T> {
    if (scenario === 'loading') return new Promise<T>((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
    if (scenario === 'denied' || scenario === 'unavailable' || scenario === 'error') throw Object.assign(new Error('Synthetic response'), {status: scenario === 'denied' ? 403 : scenario === 'unavailable' ? 404 : 503});
    if (path === '/me/supply-catalogs?pagination=cursor') return {items: scenario === 'empty' ? [] : [{tenant_id: id(1), tenant_display_name: '合成供應工作室', instance_id: id(2), setup_state: 'ready', name: '山間茶作 · 示範供貨', slug: null, publication_state: 'never_published', public_path: null, version: '1'}], next_cursor: null} as T;
    if (path === `/tenants/${id(1)}/storefronts/${id(2)}/supplier-console/summary`) return {profile: 'freedom.supplier-console.summary/v1', tenant_id: id(1), instance_id: id(2), as_of: new Date().toISOString(), todos: {state: 'ready', pending_requests: 2, outdated_offers: 1, out_of_stock_products: 0}} as T;
    if (path === '/me/content') return {items: scenario === 'empty' ? [] : [{kind: 'showcase', id: id(3), title: '社區活動行事曆 · 合成開源作品', status: 'draft', visibility: 'private', actions: ['edit','publish','withdraw']}, {kind: 'skill_submission', id: id(4), title: '圖片整理工具 · 合成技能投稿', status: 'published', visibility: 'public', actions: ['view']}]} as T;
    if (path === '/events') return {items: scenario === 'empty' ? [] : [
      {event_id: id(12), title: '山間茶席 · 稍後場', starts_at: hoursFromNow(48), ends_at: hoursFromNow(50), mode: 'in_person', state: 'published', guild_key: PREVIEW_GUILD_KEY, location: '合成場地'},
      {event_id: id(11), title: '晨間讀書會 · 示範活動', starts_at: hoursFromNow(5), ends_at: hoursFromNow(7), mode: 'online', state: 'published', guild_key: PREVIEW_GUILD_KEY, organizer_name: '合成會員'},
      {event_id: id(13), title: '別的公會夜談', starts_at: hoursFromNow(3), ends_at: hoursFromNow(4), mode: 'online', state: 'published', guild_key: 'guild_other_preview'},
      {event_id: id(14), title: '尚未送出的草稿', starts_at: hoursFromNow(2), ends_at: hoursFromNow(3), mode: 'hybrid', state: 'draft', guild_key: PREVIEW_GUILD_KEY},
      {event_id: id(15), title: '已經結束的茶會', starts_at: hoursFromNow(-10), ends_at: hoursFromNow(-8), mode: 'in_person', state: 'published', guild_key: PREVIEW_GUILD_KEY},
      {event_id: id(16), title: '尚未完成入會的活動列', starts_at: hoursFromNow(1), ends_at: hoursFromNow(2), mode: 'online', state: 'published'},
      {event_id: id(17), title: '待審核的交流', starts_at: hoursFromNow(4), ends_at: hoursFromNow(6), mode: 'online', state: 'pending', guild_key: PREVIEW_GUILD_KEY},
    ]} as T;
    throw new Error('Unrecognised synthetic endpoint');
  }};
}

function Preview() {
  const [viewer, setViewer] = useState<GuildBlockProps['viewer']>('member');
  const [scenario, setScenario] = useState<Scenario>('ready');
  const [selected, setSelected] = useState(Object.keys(guildBlockLoaders)[0]);
  const [action, setAction] = useState('');
  const [generation, setGeneration] = useState(0);
  const client = useMemo(() => syntheticClient(scenario, generation), [scenario, generation]);
  return <main className="guild-preview stack">
    <header><img className="guild-preview-brand" src={new URL('../public/brand/freedom-workshop.webp', import.meta.url).href} alt="自由工坊" width="1280" height="720"/><p className="eyebrow">自由工坊 · 開發預覽</p><h1>公會區塊</h1><p>全部為合成資料。此入口不連接會員 API、不保存或發布內容。</p></header>
    <section className="card stack" aria-label="預覽情境">
      <div className="guild-preview-controls">
        <label className="field">區塊<select value={selected} onChange={event => {setSelected(event.target.value); setAction('');}}>{Object.keys(guildBlockLoaders).map(key => <option key={key}>{key}</option>)}<option value="unknown">未知版本</option></select></label>
        <label className="field">檢視身分<select value={viewer} onChange={event => {setViewer(event.target.value as GuildBlockProps['viewer']); setGeneration(value => value + 1); setAction('');}}><option value="visitor">訪客</option><option value="member">正式會員</option><option value="read_only">唯讀成員</option></select></label>
        <label className="field">資料情境<select value={scenario} onChange={event => {setScenario(event.target.value as Scenario); setAction('');}}><option value="ready">已有內容</option><option value="empty">空資料</option><option value="denied">無權限</option><option value="unavailable">功能未啟用</option><option value="error">暫時錯誤</option><option value="loading">載入中</option><option value="missing-key">未提供公會代碼</option></select></label>
        <label className="field">外觀<select defaultValue="dark" onChange={event => {document.documentElement.dataset.theme = event.target.value;}}><option value="dark">夜航</option><option value="light">明亮</option><option value="versefolk">敘生</option></select></label>
      </div>
    </section>
    <section className="card stack" aria-label="區塊畫面"><GuildBlock key={selected} id={selected} loaders={guildBlockLoaders} viewer={viewer} client={client} guildKey={scenario === 'missing-key' ? undefined : PREVIEW_GUILD_KEY} navigate={path => setAction(`預覽導向：${path}`)} startableApplications={['hosted-store']} supplierConsoleEnabled startApplication={viewer === 'member' ? key => setAction(`預覽啟動：${key}；實際建立仍由既有應用流程驗權。`) : undefined}/></section>
    <p role="status" className="field-hint">{action}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
