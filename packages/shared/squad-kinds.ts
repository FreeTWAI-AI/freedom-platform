// Keep persisted keys stable when the member-facing names change.
export const SQUAD_KINDS = ['project', 'mutual_help', 'coaching', 'social'] as const;
export type SquadKind = typeof SQUAD_KINDS[number];
export const SQUAD_KIND_LABELS: Record<SquadKind, string> = {
  project: '開源專案合作團隊',
  mutual_help: '生意機會合作團隊',
  coaching: '技能學習陪跑小隊',
  social: '吃喝玩樂交流小隊',
};
