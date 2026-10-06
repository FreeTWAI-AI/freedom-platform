import type { TenantView } from '../../../../contracts/guild-launchpad/v1/tenant';

const ROLE_LABEL = { owner: '擁有者', admin: '管理員', operator: '操作者', viewer: '檢視者' } as const;

export function roleLabel(role: TenantView['my_membership']['role']): string {
  return ROLE_LABEL[role];
}

/** In-memory acting tenant. The server never reads this selection as authority. */
export function TenantSelector({ tenants, selectedId, onSelect }: {
  tenants: TenantView[];
  selectedId: string | null;
  onSelect: (tenantId: string) => void;
}) {
  return <section className="stack" aria-label="我的業務空間">
    <h2>我的業務空間</h2>
    {tenants.length === 0
      ? <p className="field-hint">你還沒有業務空間。填寫名稱後即可建立。</p>
      : <ul className="stack">
        {tenants.map(tenant => <li key={tenant.tenant_id}>
          <button type="button" className={tenant.tenant_id === selectedId ? 'btn btn-primary' : 'btn btn-ghost'} aria-current={tenant.tenant_id === selectedId ? 'true' : undefined} onClick={() => onSelect(tenant.tenant_id)}>
            {tenant.display_name}・{roleLabel(tenant.my_membership.role)}
          </button>
        </li>)}
      </ul>}
  </section>;
}
