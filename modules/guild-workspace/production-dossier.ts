import { z } from 'zod';

/** Content profile for an immutable, private tenant Work Result. No new authority or project identity. */
export const PRODUCTION_PROFILE = 'freedom.production-dossier/v1' as const;
export const PRODUCTION_FILENAME = 'production-dossier.md';
export const PRODUCTION_MAX_BYTES = 262144;
const encoder = new TextEncoder();
const text = (max = 4000) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), '不允許的字元');
const label = text(160).refine(value => value.trim().length > 0, '請填寫內容');
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^[1-9][0-9]*$/);
const https = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}, '請使用不含帳密的 HTTPS 網址');
export const ProductionReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('same_work_text_result'), result_id: id, sha256: digest, revision: version }).strict(),
  z.object({ kind: z.literal('external_reference'), url: https, declared_version: label }).strict(),
]);
export type ProductionReference = z.infer<typeof ProductionReferenceSchema>;
const material = z.object({ id, label, reference: ProductionReferenceSchema, rights_note: text(2000) }).strict();
const deliveryTarget = z.object({ material_id: id, label, reference: ProductionReferenceSchema }).strict();
export const ProductionDossierSchema = z.object({
  profile: z.literal(PRODUCTION_PROFILE),
  work_id: id,
  brief: z.object({ audience: text(), channel: text(), subject: text(), key_message: text(), constraints: text(), planned_date: text(160) }).strict(),
  specifications: z.array(z.object({ id, kind: z.enum(['photo', 'video', 'text']), dimensions: text(160), duration: text(160), quantity: z.number().int().min(1).max(10000), notes: text() }).strict()).max(40),
  shots: z.array(z.object({ id, description: label, framing: text(1000), lighting_props: text(2000), owner_label: text(160), material_ids: z.array(id).max(40) }).strict()).max(100),
  materials: z.array(material).max(100),
  deliveries: z.array(z.object({ id, version_label: label, change_summary: text(), status: z.enum(['prepared', 'recorded_handoff']), method: text(1000), recipient_label: text(160), targets: z.array(deliveryTarget).min(1).max(40) }).strict()).max(100),
  feedback: z.array(z.object({ id, delivery_id: id, target_version: label, source: z.enum(['internal_note', 'externally_reported']), text: label, follow_up: text(), status: z.enum(['open', 'addressed']) }).strict()).max(200),
}).strict().superRefine((value, ctx) => {
  for (const field of ['specifications', 'shots', 'materials', 'deliveries', 'feedback'] as const) {
    if (new Set(value[field].map(row => row.id)).size !== value[field].length) ctx.addIssue({ code: 'custom', path: [field], message: '識別碼不可重複' });
  }
  const materials = new Set(value.materials.map(row => row.id));
  value.shots.forEach((shot, index) => {
    if (shot.material_ids.some(key => !materials.has(key))) ctx.addIssue({ code: 'custom', path: ['shots', index, 'material_ids'], message: '鏡位引用的素材不存在' });
  });
  value.deliveries.forEach((delivery, index) => {
    // A delivery freezes the exact reference: later material edits must not retarget it.
    if (new Set(delivery.targets.map(row => row.material_id)).size !== delivery.targets.length) ctx.addIssue({ code: 'custom', path: ['deliveries', index], message: '交付素材不可重複' });
  });
  value.feedback.forEach((feedback, index) => {
    const target = value.deliveries.find(row => row.id === feedback.delivery_id);
    if (!target || target.version_label !== feedback.target_version) ctx.addIssue({ code: 'custom', path: ['feedback', index], message: '回饋必須對應確切交付版本' });
  });
});
export type ProductionDossier = z.infer<typeof ProductionDossierSchema>;

export function emptyProductionDossier(workId: string): ProductionDossier {
  return ProductionDossierSchema.parse({ profile: PRODUCTION_PROFILE, work_id: workId,
    brief: { audience: '', channel: '', subject: '', key_message: '', constraints: '', planned_date: '' },
    specifications: [], shots: [], materials: [], deliveries: [], feedback: [] });
}

export function serializeProductionDossier(value: ProductionDossier): string {
  const parsed = ProductionDossierSchema.parse(value);
  const output = `<!-- ${PRODUCTION_PROFILE} -->\n# 製作專案企劃與版本\n\n這份私人文字成果保存企劃與版本引用；外部交付和回饋是填寫者的紀錄。\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`;
  if (encoder.encode(output).length > PRODUCTION_MAX_BYTES) throw new Error('製作資料超過 262144 位元組，請縮短內容。');
  return output;
}

export type ProductionParse = { kind: 'ordinary' } | { kind: 'blocked'; reason: string } | { kind: 'dossier'; value: ProductionDossier };
export function parseProductionDossier(content: string, workId: string): ProductionParse {
  if (!content.includes('freedom.production-dossier/')) return { kind: 'ordinary' };
  const blocked = (reason: string): ProductionParse => ({ kind: 'blocked', reason });
  if (!content.startsWith(`<!-- ${PRODUCTION_PROFILE} -->\n`)) return blocked('製作資料使用未知格式；請下載原始版本，勿覆寫。');
  if (encoder.encode(content).length > PRODUCTION_MAX_BYTES) return blocked('製作資料超過大小上限。');
  const start = content.indexOf('\n```json\n');
  if (start < 0 || !content.endsWith('\n```\n')) return blocked('製作資料不完整，請保留原始版本。');
  try {
    const value = ProductionDossierSchema.parse(JSON.parse(content.slice(start + 9, -5)));
    if (value.work_id !== workId) return blocked('製作資料屬於另一份工作；不能在這裡覆寫。');
    return { kind: 'dossier', value };
  } catch { return blocked('製作資料欄位或版本引用無效，請保留原始版本。'); }
}

/** Compare by the exact immutable reference, never by material label or latest Result. */
export function sameProductionReference(a: ProductionReference, b: ProductionReference): boolean {
  return JSON.stringify(ProductionReferenceSchema.parse(a)) === JSON.stringify(ProductionReferenceSchema.parse(b));
}
