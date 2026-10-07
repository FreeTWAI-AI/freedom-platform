import type { TabId } from './types';
import './PlatformPurpose.css';

export type EntryIntent = 'supplier' | 'showcase' | 'tasks';
const intentLabels: Record<EntryIntent, string> = {
  supplier: '展示商品與供貨條件',
  showcase: '作品與合作案件',
  tasks: '社群專案與任務',
};

// An explicit entry choice survives refreshes without adding profile fields or bypassing onboarding.
export function entryIntentFromHash(): EntryIntent | null {
  const match = /^#join\/(supplier|showcase|tasks)$/.exec(window.location.hash);
  return match ? match[1] as EntryIntent : null;
}
export function entryIntentLabel(intent: EntryIntent): string { return intentLabels[intent]; }

const roles: {
  name: string; summary: string; mobileSummary: string; description: string; target: EntryIntent;
  entryLabel: string; actions: { label: string; target: TabId }[];
}[] = [
  {
    name: '供貨商', summary: '展示商品，找推廣與銷售夥伴。', mobileSummary: '展示商品',
    description: '展示商品、訂供貨條件，找到願意推廣與銷售的夥伴。',
    target: 'supplier', entryLabel: '供貨商：展示商品、找合作',
    actions: [{ label: '展示我的商品', target: 'supplier' }, { label: '找合作夥伴', target: 'members' }],
  },
  {
    name: '創作者', summary: '找案件、挑商品，洽談推廣分潤。', mobileSummary: '找合作',
    description: '用作品找到案件，挑商品推廣、洽談合作分潤。',
    target: 'showcase', entryLabel: '創作者：找案件與推廣合作',
    actions: [{ label: '找合作案件', target: 'showcase' }, { label: '挑商品推廣', target: 'retail' }],
  },
  {
    name: '開發者', summary: '找任務、秀技術，和夥伴做產品。', mobileSummary: '找專案',
    description: '分享技術、找專案任務，和不同專長的人一起做產品。',
    target: 'tasks', entryLabel: '開發者：找專案與夥伴',
    actions: [{ label: '找專案任務', target: 'tasks' }, { label: '分享開發作品', target: 'showcase' }],
  },
];

export function PlatformPurpose({ variant, onAction, disabled = false }: {
  variant: 'public' | 'member'; onAction: (target: TabId) => void; disabled?: boolean;
}) {
  return <section className={`platform-purpose platform-purpose--${variant}`} aria-label="商品、創作與開發合作入口">
    {variant === 'member' && <h2>從你的專長開始</h2>}
    <div className="purpose-roles">
      {roles.map(role => variant === 'public'
        ? <button key={role.name} type="button" className="purpose-entry" aria-label={role.entryLabel} disabled={disabled} onClick={() => onAction(role.target)}>
          <strong>{role.name}</strong><span className="purpose-summary">{role.summary}</span><span className="purpose-mobile-summary" aria-hidden="true">{role.mobileSummary}</span><span className="purpose-arrow" aria-hidden="true">→</span>
        </button>
        : <article key={role.name} className="purpose-role">
          <h3>{role.name}</h3><p>{role.description}</p>
          <div className="purpose-actions">{role.actions.map(action => <button key={action.label} type="button" className="btn btn-ghost" onClick={() => onAction(action.target)}>{action.label}</button>)}</div>
        </article>)}
    </div>
    <p className="purpose-terms">合作報酬與分潤條件，由合作雙方約定。</p>
  </section>;
}
