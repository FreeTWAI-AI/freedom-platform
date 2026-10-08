import type {InstanceView} from '../../../../contracts/guild-launchpad/v1/module-registry';

export function moduleWord(key: string): string {
  return key === 'work' ? '人工工作' : key === 'storefront' ? '商店' : key;
}

export const INSTANCE_STATUS_WORDS: Record<InstanceView['status'], string> = {
  requested: '已送出', provisioning: '配置中', active: '使用中', failed: '建立失敗', suspended: '已暫停', archived: '已封存',
};
