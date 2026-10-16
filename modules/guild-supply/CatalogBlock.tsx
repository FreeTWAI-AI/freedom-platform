import React from 'react';
import {MyStoresPageSchema} from '../../contracts/guild-launchpad/v1/storefront-pagination';
import {SupplierSummarySchema} from '../../contracts/guild-launchpad/v1/supplier-console';
import {useGuildRead, type GuildBlockProps} from '../../packages/guild-presentation/block';
import {GuildBlockState} from '../../apps/portal-web/src/guild-blocks/GuildBlockState';

const parse = (value: unknown) => MyStoresPageSchema.parse(value);
const parseSummary = (value: unknown) => SupplierSummarySchema.parse(value);
export const title = '商品與供貨';

type SummaryState = ReturnType<typeof useGuildRead<ReturnType<typeof parseSummary>>>['state'];

export function SupplySummaryView({state, name, tenantId, instanceId, retry}: {
  state: SummaryState;
  name: string;
  tenantId: string;
  instanceId: string;
  retry?: () => void;
}) {
  if (state.kind === 'loading') {
    return <p className="field-hint">正在讀取待辦…</p>;
  }
  if (state.kind === 'error') {
    return <p className="field-hint">暫時無法讀取待辦。<button type="button" className="btn btn-ghost btn-small" onClick={retry}>重新讀取待辦<span className="sr-only">：{name}</span></button></p>;
  }
  if (state.kind === 'ready') {
    if (state.data.tenant_id !== tenantId || state.data.instance_id !== instanceId) {
      return <p className="field-hint">暫時無法讀取待辦。<button type="button" className="btn btn-ghost btn-small" onClick={retry}>重新讀取待辦<span className="sr-only">：{name}</span></button></p>;
    }
    const {todos} = state.data;
    if (todos.state === 'unavailable') {
      return <p className="field-hint">需要商品編輯權限才能查看待辦。</p>;
    }
    if (todos.pending_requests === 0 && todos.outdated_offers === 0 && todos.out_of_stock_products === 0) {
      return <p className="field-hint">目前沒有待辦。</p>;
    }
    return <p className="field-hint">待辦：待確認售價申請 {todos.pending_requests}、供貨版本需重新公開 {todos.outdated_offers}、缺貨商品 {todos.out_of_stock_products}</p>;
  }
  return null;
}

function CatalogSummaryItem({client, viewer, item}: {
  client: GuildBlockProps['client'];
  viewer: GuildBlockProps['viewer'];
  item: {tenant_id: string; instance_id: string; name: string | null};
}) {
  const {state, retry} = useGuildRead(
    client,
    viewer,
    `/tenants/${item.tenant_id}/storefronts/${item.instance_id}/supplier-console/summary`,
    parseSummary,
  );
  return <SupplySummaryView state={state} name={item.name ?? '尚未命名的供貨商品庫'} tenantId={item.tenant_id} instanceId={item.instance_id} retry={retry} />;
}

export default function CatalogBlock({client, viewer, navigate, startApplication, startableApplications = [], supplierConsoleEnabled}: GuildBlockProps) {
  const {state, retry} = useGuildRead(client, viewer, '/me/supply-catalogs?pagination=cursor', parse);
  return <div className="stack">
    <p>管理商品、供貨價與合作條件，再決定是否公開供貨版本。不必先建立零售店。</p>
    <GuildBlockState state={state} retry={retry} noun="供貨商品庫"/>
    {state.kind === 'ready' && <>
      {state.data.items.length ? <ul className="stack">{state.data.items.slice(0, 3).map(item => <li key={item.instance_id}>
        <button type="button" className={`btn ${state.data.items.length === 1 && !state.data.next_cursor ? 'btn-primary' : 'btn-ghost'} btn-small`} onClick={() => navigate(`#stores/${item.tenant_id}/${item.instance_id}/supply`)}>{item.name ?? '尚未命名的供貨商品庫'}</button>
        <p className="field-hint">{item.setup_state === 'setup_required' ? '待設定供貨資料' : '供貨資料已就緒'}；是否可編輯由商品庫目前授權決定。</p>
        {supplierConsoleEnabled === true && item.setup_state === 'ready' && <CatalogSummaryItem client={client} viewer={viewer} item={item} />}
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
