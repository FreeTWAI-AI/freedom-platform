import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { text } from '../../packages/shared/validation.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { externalLink, githubCoordinate } from '../opensource-marketing/github.js';

export const SHARE_INTRODUCTION_COUNT = 100;
export const COVER_MAX_BYTES = 512 * 1024;
export const COVER_MAX_DIMENSION = 4096;
export const COVER_MAX_PIXELS = 16_777_216;
const COVER_OUTPUT_WIDTH = 1200, COVER_OUTPUT_HEIGHT = 630;
// Base64 of the largest accepted image, without whitespace.
const COVER_MAX_BASE64 = Math.ceil(COVER_MAX_BYTES / 3) * 4;
const COVER_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const invalidCover = () => new Problem(422, 'invalid_cover_image', '示意圖無法使用。請提供完整的靜態 PNG、JPEG 或 WebP，512 KiB 以下，長寬各不超過 4096 像素。');
// C0/C1 controls, DEL and Unicode line/paragraph separators are rejected in introductions.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const introduction = z.string().max(1000).transform((value, ctx) => {
  const normalized = value.normalize('NFC').trim();
  const length = [...normalized].length;
  if (CONTROL.test(normalized)) ctx.addIssue({ code: 'custom', message: '分享介紹不能包含換行或控制字元。' });
  else if (length < 8 || length > 200) ctx.addIssue({ code: 'custom', message: '每則分享介紹需為 8 到 200 字。' });
  return normalized;
});
const coverImage = z.object({
  mime_type: z.enum(COVER_MIME_TYPES, { message: '示意圖只接受 image/png、image/jpeg 或 image/webp。' }),
  data_base64: z.string().max(COVER_MAX_BASE64 + 4, { message: '示意圖需為 512 KiB 以下。' }),
}).strict();

// Exactly what an agent may submit. Consent, official status and member ids are
// intentionally absent: `.strict()` rejects them instead of silently dropping.
export const skillSubmissionPayload = z.object({
  repository_url: z.string().trim().max(300).transform(value => `https://github.com/${githubCoordinate(value)}`),
  title: text(120),
  description: text(2000),
  use_notes: text(3000),
  demo_url: externalLink.nullable().default(null),
  relationship: z.enum(['author', 'maintainer', 'contributor', 'curator']),
  share_introductions: z.array(introduction).length(SHARE_INTRODUCTION_COUNT, { message: `分享介紹必須剛好 ${SHARE_INTRODUCTION_COUNT} 則。` })
    .superRefine((items, ctx) => {
      const seen = new Map<string, number>();
      items.forEach((item, index) => {
        // Case and internal spacing differences do not make an introduction distinct.
        const key = item.toLowerCase().replace(/\s+/g, ' ');
        const prior = seen.get(key);
        if (prior !== undefined) ctx.addIssue({ code: 'custom', path: [index], message: `第 ${index + 1} 則與第 ${prior + 1} 則分享介紹重複。` });
        else seen.set(key, index);
      });
    }),
  cover_image: coverImage.optional(),
}).strict();

export type SkillSubmissionContent = Omit<z.output<typeof skillSubmissionPayload>, 'cover_image'>;
export interface NormalizedSubmission {
  payload: SkillSubmissionContent;
  // Digest of canonical text fields plus the decoded original image bytes;
  // identical retries match even though re-encoding happens every time.
  payload_sha256: string;
  image: Buffer | null;
}

function decodeBase64(value: string): Buffer {
  requireCondition(value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 422, 'invalid_cover_image', '示意圖必須是標準 base64（不含換行或 data: 前綴）。');
  requireCondition(value.length <= COVER_MAX_BASE64, 413, 'cover_image_too_large', '示意圖需為 512 KiB 以下。');
  const bytes = Buffer.from(value, 'base64');
  // Reject non-canonical padding bits so one image has exactly one encoding.
  requireCondition(bytes.toString('base64') === value, 422, 'invalid_cover_image', '示意圖必須是標準 base64（不含換行或 data: 前綴）。');
  requireCondition(bytes.length > 0 && bytes.length <= COVER_MAX_BYTES, 413, 'cover_image_too_large', '示意圖需為 512 KiB 以下。');
  return bytes;
}

function rasterFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpeg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function rejectAnimation(bytes: Buffer, format: 'png' | 'jpeg' | 'webp') {
  if (format === 'png') {
    // libpng may decode only the first APNG frame; reject the animation chunk itself.
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw invalidCover();
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') throw invalidCover();
      offset += length + 12;
      if (type === 'IEND') break;
    }
  } else if (format === 'webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      if (length > bytes.length - offset - 8) throw invalidCover();
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && length >= 1 && (bytes[offset + 8] & 0x02))) throw invalidCover();
      offset += 8 + length + (length & 1);
    }
  }
}

export async function normalizeCoverImage(mime: string, data: string): Promise<{ original: Buffer; webp: Buffer }> {
  const original = decodeBase64(data);
  // Signature first: SVG, GIF, HTML and archives never reach the decoder.
  const format = rasterFormat(original);
  if (!format || mime !== `image/${format}`) throw invalidCover();
  rejectAnimation(original, format);
  try {
    // The request's processor (sharp on Node) fully decodes, orients and strips metadata.
    const webp = await normalizeImage(original, { purpose: 'skill_cover', format, maxDimension: COVER_MAX_DIMENSION, maxPixels: COVER_MAX_PIXELS,
      output: { width: COVER_OUTPUT_WIDTH, height: COVER_OUTPUT_HEIGHT, fit: 'contain', background: '#101827', quality: 82, effort: 4 } });
    requireCondition(webp.length > 0 && webp.length <= COVER_MAX_BYTES, 422, 'invalid_cover_image', '這張示意圖壓縮後仍過大，請換一張較簡單的圖片。');
    return { original, webp };
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw invalidCover();
  }
}

export async function normalizeSubmission(raw: unknown): Promise<NormalizedSubmission> {
  const parsed = skillSubmissionPayload.parse(raw);
  const { cover_image, ...payload } = parsed;
  const cover = cover_image ? await normalizeCoverImage(cover_image.mime_type, cover_image.data_base64) : null;
  const payload_sha256 = digest({
    payload,
    cover_image: cover ? { mime_type: cover_image!.mime_type, sha256: createHash('sha256').update(cover.original).digest('hex') } : null,
  });
  return { payload, payload_sha256, image: cover?.webp ?? null };
}
