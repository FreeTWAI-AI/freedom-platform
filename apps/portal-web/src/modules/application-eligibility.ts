import type {ApplicationView} from '../../../../contracts/guild-launchpad/v1/module-registry';

export const REASONS: Record<string, string> = {
  guild_full_member_required: '需要這個公會的正式會員身分，請在聊天室聯絡會長。',
  tenant_manage_required: '你目前沒有可管理的業務空間，請前往業務空間建立或接受邀請。',
  policy_unconfigured: '業務空間尚未設定容量政策，請聯絡擁有者。',
  application_not_available: '這個應用版本目前無法啟動，可以先閱讀版本資料。',
};
export const startable = (app: Pick<ApplicationView, 'eligibility'>) => app.eligibility?.can_launch === true
  || (app.eligibility?.tenant_action === 'create' && app.eligibility.reason_codes.length > 0
    && app.eligibility.reason_codes.every(code => code === 'tenant_manage_required'));
