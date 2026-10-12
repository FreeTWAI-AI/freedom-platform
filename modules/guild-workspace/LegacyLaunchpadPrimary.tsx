import React from 'react';
import type {Config} from '../../contracts/guild-launchpad/v2/config';
import type {LaunchpadApplication} from '../../contracts/guild-launchpad/v1/module-registry';
import type {PortalClient} from '../../apps/portal-web/src/api';
import {MyStoreAction} from '../../apps/portal-web/src/modules/MyStoreAction';
import {REASONS, startable, type LaunchRequest} from '../../apps/portal-web/src/modules/GuildLaunchpadApplications';

/** Compatibility for already-published layouts. New guild tools are module surfaces,
 * not entries in this adapter. No business data or authority is owned here. */
export const legacyWorkNavigationGuard = (guildKey: string) => ['guild_commercial_production', 'guild_talent_direction'].includes(guildKey);
export const legacyStorePath = (guildKey: string, tenantId: string, instanceId: string) =>
  `stores/${tenantId}/${instanceId}${guildKey === 'guild_product_quality_supply' ? '/supply' : ''}`;
export const legacyPrimaryVisible = (primary: LaunchpadApplication | undefined, applicationsVisible: boolean) =>
  Boolean(primary && (primary.application_key === 'manual-workspace' || applicationsVisible));

export const legacyPrimaryLabel = (guildKey: string, primary: LaunchpadApplication) =>
  guildKey === 'guild_product_quality_supply' && primary.application_key === 'hosted-store' ? '商品與供貨' : primary.display_name;

export function LegacyLaunchpadPrimary({primary, config, guildKey, memberTier, internHint: INTERN_HINT, client, focusWork, canLeave, canNavigate, launchRequest, setLaunchRequest}: {
  primary: LaunchpadApplication; config: Config; guildKey: string; memberTier?: string; internHint: string;
  client: PortalClient; focusWork: () => void; canLeave: () => boolean; canNavigate: () => boolean;
  launchRequest?: LaunchRequest; setLaunchRequest: (request: LaunchRequest) => void;
}) {
  const supplyPrimary = guildKey === 'guild_product_quality_supply' && primary.application_key === 'hosted-store';
  return (
    <section className="card guild-launchpad-primary" aria-label="主要動作">
      <h2>{primary.application_key === 'manual-workspace' ? config.starter.title_label : legacyPrimaryLabel(guildKey, primary)}</h2>
      {supplyPrimary && <p>管理商品、供貨價與合作條件。不需要商店網址或零售展示頁；已有商店可直接沿用。</p>}
      {primary.application_key === 'manual-workspace' ? <>
        <p>{config.starter.objective_hint}</p>
        {guildKey === 'guild_talent_direction' && memberTier === 'full' && <p className="field-hint">在下方選擇可使用的工作空間，再建立新方向卡或繼續原卡；尚未完成設定時，依下方提示完成設定。</p>}
        {memberTier === 'intern' ? <p className="field-hint">{INTERN_HINT}</p>
          : <div className="actions"><button type="button" className="btn btn-primary" onClick={focusWork}>{guildKey === 'guild_talent_direction' ? '前往方向卡' : '前往我的工作'}</button></div>}
      </> : primary.application_key === 'hosted-store' ? memberTier === 'intern' ? <p className="field-hint">{INTERN_HINT}</p>
        : <MyStoreAction client={client} purpose={supplyPrimary ? 'supply' : undefined} canStart={startable(primary)} reasons={primary.eligibility.reason_codes.filter(code => code !== 'tenant_manage_required' || !startable(primary)).map(code => REASONS[code])}
          onCreate={() => {if (canLeave()) setLaunchRequest({application_key: primary.application_key, release_ref: primary.release_ref, nonce: (launchRequest?.nonce ?? 0) + 1});}}
          onEnter={path => {if (canNavigate()) window.location.hash = path;}}/> : <>
        {primary.eligibility.tenant_action !== 'denied' && <div className="actions"><button type="button" className="btn btn-primary" disabled={!primary.eligibility.can_launch} onClick={() => setLaunchRequest({application_key: primary.application_key, release_ref: primary.release_ref, nonce: (launchRequest?.nonce ?? 0) + 1})}>{primary.eligibility.tenant_action === 'continue' ? '繼續使用' : '啟動'}{primary.display_name}</button></div>}
        {primary.eligibility.reason_codes.map(code => <p key={code} className="field-hint">{REASONS[code]}</p>)}
        {primary.eligibility.reason_codes.includes('tenant_manage_required') && <div className="actions"><a className="btn btn-ghost" href="#business" onClick={event => {if (!canNavigate()) event.preventDefault();}}>建立或選擇業務空間</a></div>}
      </>}
    </section>
  );
}
