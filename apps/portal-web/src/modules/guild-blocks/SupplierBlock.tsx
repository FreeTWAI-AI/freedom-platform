import type {LaunchpadApplication} from '../../../../../contracts/guild-launchpad/v1/module-registry';
import {MyStoreAction} from '../MyStoreAction';
import {REASONS, startable} from '../application-eligibility';
import type {GuildBlockContext as Context} from '../../../../../packages/shared/guild-block-ui';
type GuildBlockContext = Context<LaunchpadApplication>;

const INTERN_HINT = '你是這個公會的實習成員：可以閱讀公會內容、在公會聊天室聊天。想發布或編輯，可以在聊天室跟會長打聲招呼，會長能把你設為正式成員。';

export const supplierStorePath = (tenantId: string, instanceId: string) => `#stores/${tenantId}/${instanceId}/supply`;

/** Reuses the existing supply catalog reader and original application launch flow. */
export function SupplierBlock({client, primary, memberTier, onCreate, navigate}: GuildBlockContext) {
  if (!primary) return null;
  return <section className="card guild-launchpad-primary" aria-label="主要動作">
    <h2>商品與供貨</h2>
    <p>建立供貨商品庫，管理商品、供貨價、運費與退換貨條件，再自行決定是否向同社群店主公開供貨版本。不需要商店網址或零售展示頁；已有商店可直接沿用。</p>
    {memberTier === 'intern' ? <p className="field-hint">{INTERN_HINT}</p>
      : <MyStoreAction client={client} purpose="supply" canStart={startable(primary)} reasons={primary.eligibility.reason_codes.map(code => REASONS[code])}
        onCreate={onCreate} onEnter={navigate}/>}
  </section>;
}
