import { z } from 'zod';

/** Human-authored content of an existing tenant Work Result; not a member assessment. */
export const POSITIONING_CARD_PROFILE = 'freedom.positioning-action-card/v1' as const;
export const POSITIONING_CARD_FILENAME = 'positioning-action-card.md';
const MAX_BYTES = 262144;
const encoder = new TextEncoder();
const text = (max = 4000) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), '不允許的字元');
export const PositioningActionCardSchema = z.object({
  profile: z.literal(POSITIONING_CARD_PROFILE),
  work_id: z.string().uuid(),
  situation: text(),
  experience: text(),
  desired_change: text(),
  activities: z.array(text(1000)).min(1).max(2),
  selected_activity: z.number().int().min(0).max(1).nullable(),
  completion_criteria: text(),
  available_time: text(500),
  support_needed: text(),
  review_date: z.string().refine(value => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, '請填寫有效日期'),
  personally_confirmed: z.boolean(),
  review: text(),
  next_step: text(),
}).strict().superRefine((value, ctx) => {
  const chosen = value.selected_activity;
  if (chosen !== null && (chosen >= value.activities.length || !value.activities[chosen]?.trim()))
    ctx.addIssue({ code: 'custom', path: ['selected_activity'], message: '請選擇已填寫的小活動' });
  if (value.personally_confirmed && (chosen === null || !value.desired_change.trim() || !value.completion_criteria.trim() || !value.available_time.trim() || !value.review_date))
    ctx.addIssue({ code: 'custom', path: ['personally_confirmed'], message: '確認前請填寫本週目標、選定活動、完成條件、可投入時間與回顧日期' });
});
export type PositioningActionCard = z.infer<typeof PositioningActionCardSchema>;
export function emptyPositioningActionCard(workId: string): PositioningActionCard {
  return { profile: POSITIONING_CARD_PROFILE, work_id: workId, situation: '', experience: '', desired_change: '', activities: [''],
    selected_activity: null, completion_criteria: '', available_time: '', support_needed: '', review_date: '', personally_confirmed: false, review: '', next_step: '' };
}
export function serializePositioningActionCard(value: PositioningActionCard): string {
  const parsed = PositioningActionCardSchema.parse(value);
  const output = `<!-- ${POSITIONING_CARD_PROFILE} -->\n# 我的方向卡\n\n本人填寫的小活動與回顧；沿目前業務空間的讀取權限保存。\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`;
  if (encoder.encode(output).length > MAX_BYTES) throw new Error('方向卡超過 262144 位元組，請縮短內容。');
  return output;
}
export type PositioningCardParse = { kind: 'ordinary' } | { kind: 'blocked'; reason: string } | { kind: 'document'; value: PositioningActionCard };
export function parsePositioningActionCard(content: string, workId: string): PositioningCardParse {
  if (!content.includes('freedom.positioning-action-card/')) return { kind: 'ordinary' };
  const blocked = (reason: string): PositioningCardParse => ({ kind: 'blocked', reason });
  if (!content.startsWith(`<!-- ${POSITIONING_CARD_PROFILE} -->\n`)) return blocked('方向卡使用未知格式；請保留原始版本，勿覆寫。');
  if (encoder.encode(content).length > MAX_BYTES) return blocked('方向卡超過大小上限。');
  const start = content.indexOf('\n```json\n');
  if (start < 0 || !content.endsWith('\n```\n')) return blocked('方向卡不完整，請保留原始版本。');
  try {
    const value = PositioningActionCardSchema.parse(JSON.parse(content.slice(start + 9, -5)));
    if (value.work_id !== workId) return blocked('方向卡屬於另一份工作；不能在這裡覆寫。');
    return { kind: 'document', value };
  } catch { return blocked('方向卡欄位無效，請保留原始版本。'); }
}
