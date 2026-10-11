import {useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PortalClient, type RequestOptions} from '../src/api';
import {GuildBlockHost} from '../src/modules/guild-blocks/GuildBlockHost';
import type {GuildBlockContext as Context} from '../../../packages/shared/guild-block-ui';
import type {LaunchpadApplication} from '../../../contracts/guild-launchpad/v1/module-registry';
type GuildBlockContext = Context<LaunchpadApplication>;
import '../src/styles.css';
import '../src/modules/GuildLaunchpad.css';

type Scenario = 'loading' | 'empty' | 'error' | 'member' | 'visitor' | 'intern';
class SyntheticClient extends PortalClient {
  constructor(private scenario: Scenario) {super();}
  override async get<T>(path: string, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    if (this.scenario === 'loading') return new Promise<T>((_, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true}));
    if (this.scenario === 'error') throw Error('Synthetic read failure');
    if (path === '/events') return {items: this.scenario === 'empty' ? [] : [{event_id: '00000000-0000-4000-8000-000000000001', title: '合成活動：社群交流', starts_at: '2099-10-12T10:00:00Z', state: 'published'}]} as T;
    if (path === '/me/supply-catalogs?pagination=cursor') return {items: this.scenario === 'empty' ? [] : [{tenant_id: '00000000-0000-4000-8000-000000000002', tenant_display_name: '合成業務空間', instance_id: '00000000-0000-4000-8000-000000000003', setup_state: 'ready', name: '合成供貨商品庫', slug: null, publication_state: 'never_published', public_path: null, version: '1'}], next_cursor: null} as T;
    throw Error('Preview does not implement this endpoint');
  }
  override post<T>(): Promise<T> {return Promise.reject(Error('Synthetic preview never writes'));}
  override patch<T>(): Promise<T> {return Promise.reject(Error('Synthetic preview never writes'));}
}
function Preview() {
  const [scenario, setScenario] = useState<Scenario>('member');
  const [guildKey, setGuildKey] = useState('guild_product_quality_supply');
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState('');
  const client = useMemo(() => new SyntheticClient(scenario), [scenario, guildKey]);
  const visitor = scenario === 'visitor';
  const context: GuildBlockContext = {client, guildKey, userId: visitor ? undefined : 'synthetic-member', visitor,
    memberTier: scenario === 'intern' ? 'intern' : 'full', mode: visitor ? 'public' : 'member', showPrimary: !visitor,
    primary: {application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0', display_name: '合成應用', eligibility: {can_launch: true, tenant_action: 'create', reason_codes: [], required_guild_tier: 'full', policy_revision: '1'}},
    onCreate: () => setNotice(blocked ? '合成離頁守衛已阻擋' : '合成建立入口；未呼叫任何寫入 API'),
    navigate: path => {setNotice(blocked ? '合成離頁守衛已阻擋' : `合成導覽目標：${path}`); return false;},
  };
  return <main className="guild-launchpad" style={{maxWidth: 900, margin: '0 auto', padding: 24}}>
    <h1>公會區塊合成預覽</h1>
    <p className="banner">只有本機假資料；不連 API／PostgreSQL，不是權限、部署或真人驗收證據。</p>
    <div className="actions">
      <label className="field">公會<select value={guildKey} onChange={event => {setGuildKey(event.target.value);setNotice('');}}><option value="guild_product_quality_supply">商品品質與供應</option><option value="guild_event_space">活動與空間</option></select></label>
      <label className="field">合成狀態<select value={scenario} onChange={event => {setScenario(event.target.value as Scenario);setNotice('');}}>{(['loading','empty','error','member','visitor','intern'] as const).map(value => <option key={value}>{value}</option>)}</select></label>
      <label><input type="checkbox" checked={blocked} onChange={event => setBlocked(event.target.checked)}/>模擬離頁阻擋</label>
    </div>
    <p role="status">{notice}</p>
    <GuildBlockHost key={`${guildKey}:${scenario}`} context={context} primary={null}>
      <section className="guild-launchpad-block"><h2>既有核心區塊位置</h2><p>這個獨立預覽只檢查附加區塊；正式啟動台仍使用原本七區塊與設定。</p></section>
    </GuildBlockHost>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
