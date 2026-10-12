import React from 'react';
import {MyStoresPageSchema} from '../../contracts/guild-launchpad/v1/storefront-pagination';
import {useGuildRead, type GuildBlockProps} from '../../packages/guild-presentation/block';
import {GuildBlockState} from '../../apps/portal-web/src/guild-blocks/GuildBlockState';

const parse = (value: unknown) => MyStoresPageSchema.parse(value);
export const title = '商品與供貨';

export default function CatalogBlock({client, viewer, navigate, startApplication, startableApplications = []}: GuildBlockProps) {
  const {state, retry} = useGuildRead(client, viewer, '/me/supply-catalogs?pagination=cursor', parse);
  return <div className="stack">
    <p>管理商品、供貨價與合作條件，再決定是否公開供貨版本。不必先建立零售店。</p>
    <GuildBlockState state={state} retry={retry} noun="供貨商品庫"/>
    {state.kind === 'ready' && <>
      {state.data.items.length ? <ul className="stack">{state.data.items.slice(0, 3).map(item => <li key={item.instance_id}>
        <button type="button" className={`btn ${state.data.items.length === 1 && !state.data.next_cursor ? 'btn-primary' : 'btn-ghost'} btn-small`} onClick={() => navigate(`#stores/${item.tenant_id}/${item.instance_id}/supply`)}>{item.name ?? '尚未命名的供貨商品庫'}</button>
        <p className="field-hint">{item.setup_state === 'setup_required' ? '待設定供貨資料' : '供貨資料已就緒'}；是否可編輯由商品庫目前授權決定。</p>
      </li>)}</ul> : <p>目前沒有可讀取的供貨商品庫。</p>}
      <div className="actions">
        {(state.data.items.length > 3 || state.data.next_cursor) && <button type="button" className="btn btn-ghost btn-small" onClick={() => navigate('#stores/supply')}>查看全部供貨商品庫</button>}
        {viewer === 'member' && startApplication && startableApplications.includes('hosted-store') && <button type="button" className={`btn ${state.data.items.length ? 'btn-ghost' : 'btn-primary'} btn-small`} onClick={() => startApplication('hosted-store')}>開始供貨設定</button>}
      </div>
      <details className="question-note"><summary>供貨與預留流程</summary><p className="field-hint">公開供貨、同意店主售價與開放預留是不同步驟。進入商品庫可確認目前狀態，並回查自己的供貨訂單。</p></details>
      {viewer === 'read_only' && <p className="field-hint">這個入口以唯讀方式呈現；公會身分不會增加商品或庫存權限。</p>}
    </>}
  </div>;
}
