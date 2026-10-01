// Browser-safe service fields. The form and the API share this check.
import { normalizeShareUrl } from './share-url.js';

export const SERVICE_CATEGORIES = ['hair_beauty', 'courses', 'language', 'design', 'photo_video', 'tech', 'consulting', 'handmade', 'other'] as const;
export type ServiceCategory = typeof SERVICE_CATEGORIES[number];
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  hair_beauty: '美髮造型・假髮',
  courses: '課程・教學',
  language: '語言教學',
  design: '設計',
  photo_video: '攝影・影音',
  tech: '技術・開發',
  consulting: '顧問・諮詢',
  handmade: '手作・商品',
  other: '其他',
};
export const SERVICE_MODES = ['online', 'in_person', 'both'] as const;
export type ServiceMode = typeof SERVICE_MODES[number];
export const SERVICE_MODE_LABELS: Record<ServiceMode, string> = {
  online: '線上', in_person: '實體', both: '線上・實體',
};
export const SERVICE_LIMIT = 5;

const LINE = /[\u0000-\u001f\u007f]/;
const TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const FIELDS = new Set(['title', 'category', 'summary', 'description', 'price_text', 'area_text', 'service_mode', 'contacts']);

export type ServiceContact = { label: string; url: string };
export type ServiceDraft = {
  title: string; category: ServiceCategory; summary: string; description: string | null;
  price_text: string | null; area_text: string | null; service_mode: ServiceMode; contacts: ServiceContact[];
};
export type ServiceIssue = { field: string; code: string; message: string };

const chars = (value: string) => [...value].length;

function line(value: unknown, max: number, field: string, label: string, required: boolean, issues: ServiceIssue[]) {
  if (typeof value !== 'string') { if (required) issues.push({ field, code: 'validation_failed', message: `請填寫${label}。` }); return null; }
  if (LINE.test(value)) { issues.push({ field, code: 'validation_failed', message: `${label}含有無法使用的字元。` }); return null; }
  const trimmed = value.trim();
  if (!trimmed) { if (required) issues.push({ field, code: 'validation_failed', message: `請填寫${label}。` }); return null; }
  if (chars(trimmed) > max) { issues.push({ field, code: 'validation_failed', message: `${label}請在 ${max} 字以內。` }); return null; }
  return trimmed;
}

/** One definition of a service draft. Contact URLs go through normalizeShareUrl. */
export function validateMemberService(raw: unknown): { ok: true; value: ServiceDraft } | { ok: false; issues: ServiceIssue[] } {
  const issues: ServiceIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, issues: [{ field: 'title', code: 'validation_failed', message: '請填寫標題。' }] };
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!FIELDS.has(key)) issues.push({ field: key, code: 'validation_failed', message: '內容有無法使用的欄位。' });
  const title = line(body.title, 80, 'title', '標題', true, issues);
  const summary = line(body.summary, 160, 'summary', '簡介', true, issues);
  const price = line(body.price_text, 60, 'price_text', '價格', false, issues);
  const area = line(body.area_text, 60, 'area_text', '地區', false, issues);
  let description: string | null = null;
  if (typeof body.description === 'string' && body.description.trim()) {
    if (TEXT.test(body.description)) issues.push({ field: 'description', code: 'validation_failed', message: '說明含有無法使用的字元。' });
    else {
      description = body.description.replace(/\r\n/g, '\n').trim();
      if (chars(description) > 2000) issues.push({ field: 'description', code: 'validation_failed', message: '說明請在 2000 字以內。' });
    }
  } else if (body.description != null && body.description !== '') issues.push({ field: 'description', code: 'validation_failed', message: '說明格式不正確。' });
  const category = (SERVICE_CATEGORIES as readonly string[]).includes(String(body.category)) ? body.category as ServiceCategory : null;
  if (!category) issues.push({ field: 'category', code: 'validation_failed', message: '請選擇分類。' });
  const serviceMode = (SERVICE_MODES as readonly string[]).includes(String(body.service_mode)) ? body.service_mode as ServiceMode : null;
  if (!serviceMode) issues.push({ field: 'service_mode', code: 'validation_failed', message: '請選擇服務方式。' });
  const contacts: ServiceContact[] = [];
  if (!Array.isArray(body.contacts) || body.contacts.length < 1) issues.push({ field: 'contacts', code: 'validation_failed', message: '請至少留下一個聯絡方式。' });
  else if (body.contacts.length > 3) issues.push({ field: 'contacts', code: 'validation_failed', message: '聯絡方式最多 3 個。' });
  else body.contacts.forEach((item, index) => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (item && typeof item === 'object') for (const key of Object.keys(row)) if (key !== 'label' && key !== 'url') issues.push({ field: `contacts.${index}.${key}`, code: 'validation_failed', message: '聯絡方式有無法使用的欄位。' });
    const label = line(row.label, 20, `contacts.${index}.label`, '聯絡名稱', true, issues);
    const normalized = typeof row.url === 'string' ? normalizeShareUrl(row.url) : { ok: false as const };
    if (!normalized.ok) issues.push({ field: `contacts.${index}.url`, code: 'member_service_contact', message: '請填寫有效的 https 連結。' });
    else if (label) contacts.push({ label, url: normalized.url });
  });
  if (issues.length || !title || !summary || !category || !serviceMode || contacts.length !== (Array.isArray(body.contacts) ? body.contacts.length : 0)) return { ok: false, issues };
  return { ok: true, value: { title, category, summary, description, price_text: price, area_text: area, service_mode: serviceMode, contacts } };
}
