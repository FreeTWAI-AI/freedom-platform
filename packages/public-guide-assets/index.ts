import { z } from 'zod';

// Absolute parser ceilings; each installed pack also has its own closed budget.
export const GUIDE_MAX_ASSETS = 1536;
export const GUIDE_MAX_OBJECT_BYTES = 2 * 1024 * 1024;
export const GUIDE_MAX_MANIFEST_BYTES = 512 * 1024;
export const GUIDE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const GUIDE_PACK_LIMITS = Object.freeze({
  dragon: {assets:512,manifestBytes:256*1024,totalBytes:64*1024*1024},
  'ai-sister': {assets:1536,manifestBytes:512*1024,totalBytes:64*1024*1024},
});
export const GUIDE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const GUIDE_PREFIX = '/public/guide-packs';
const sha = /^[0-9a-f]{64}$/;
const logical = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/;
const assetSchema=z.object({ logicalId: z.string().regex(logical), sha256: z.string().regex(sha),
  byteLength: z.number().int().min(12).max(GUIDE_MAX_OBJECT_BYTES), mime: z.literal('image/webp'),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }).strict();
const manifestFields={
  schema: z.literal('freedom.guide-pack/v1'),
  purpose: z.literal('platform-public'),
  source: z.object({ repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
};
export const guideManifestSchema=z.discriminatedUnion('pack',[
  z.object({...manifestFields,pack:z.literal('dragon'),version:z.string().regex(/^dragon-v[1-9][0-9]*-[0-9]{8}$/).max(48),assets:z.array(assetSchema).min(1).max(GUIDE_PACK_LIMITS.dragon.assets)}).strict(),
  z.object({...manifestFields,pack:z.literal('ai-sister'),version:z.string().regex(/^ai-sister-v[1-9][0-9]*-[0-9]{8}$/).max(48),assets:z.array(assetSchema).min(1).max(GUIDE_PACK_LIMITS['ai-sister'].assets)}).strict(),
]);
export type GuideManifest = z.infer<typeof guideManifestSchema>;
export type GuideAsset = Readonly<GuideManifest['assets'][number]>;
export type GuidePackId = GuideManifest['pack'];
export type GuideRelease = Readonly<{ enabled: true; pack: GuidePackId; version: string; manifestSha256: string }>;
/** The only app port. No arbitrary key, URL, credentials, list or mutation methods. */
export type PublicGuideAssets = Readonly<{ release?: GuideRelease; releases?:Readonly<Partial<Record<GuidePackId,GuideRelease>>>; fetch: (request: Request) => Promise<Response> }>;
export type GuideAssetService = PublicGuideAssets & Readonly<{release:GuideRelease}>;
export type GuideReadObject = { byteLength: number; mime: string; body: ReadableStream<Uint8Array> };
/** A host read adapter must still constrain this digest to its pinned manifest. */
export type GuideAssetReader = Readonly<{ readDigest: (digest: string) => Promise<GuideReadObject | null> }>;
export class GuideAssetError extends Error { constructor() { super('guide_asset_unavailable'); } }
const fail = (): never => { throw new GuideAssetError(); };
export async function guideSha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function parseGuideManifest(bytes: Uint8Array, expectedSha256: string): Promise<GuideManifest> {
  if (!sha.test(expectedSha256) || bytes.byteLength > GUIDE_MAX_MANIFEST_BYTES || await guideSha256(bytes) !== expectedSha256) fail();
  let result: GuideManifest;
  try { result = guideManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { return fail(); }
  const limits=GUIDE_PACK_LIMITS[result.pack];
  if(bytes.byteLength>limits.manifestBytes)fail();
  let total = 0;
  const ids = new Set<string>(), digests = new Map<string, GuideAsset>();
  for (const asset of result.assets) {
    if (ids.has(asset.logicalId)) fail(); ids.add(asset.logicalId);
    const existing = digests.get(asset.sha256);
    if (existing && (existing.byteLength !== asset.byteLength || existing.width !== asset.width || existing.height !== asset.height)) fail();
    digests.set(asset.sha256, asset); total += asset.byteLength;
    Object.freeze(asset);
  }
  if (total > limits.totalBytes) fail();
  Object.freeze(result.source); Object.freeze(result.assets); return Object.freeze(result);
}
export function guideAssetPath(manifest: GuideManifest, asset: GuideAsset): string {
  return `${GUIDE_PREFIX}/${manifest.pack}/${manifest.version}/${asset.sha256}.webp`;
}
/** Fixed storage namespace, never a request-selected arbitrary key. */
export function guideObjectKey(manifest: GuideManifest, asset: GuideAsset): string {
  return `guide-packs/${manifest.pack}/${manifest.version}/${asset.sha256}.webp`;
}
const safeHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
export function unavailableGuideResponse(status = 404): Response {
  return new Response(null, { status, headers: safeHeaders });
}
/** Bounded full read even for HEAD; metadata alone never authorizes an immutable response. */
export async function readGuideBytes(object: GuideReadObject, asset: GuideAsset): Promise<Uint8Array> {
  if (object.byteLength !== asset.byteLength || object.mime !== 'image/webp') { try { void object.body.cancel().catch(() => {}); } catch {} return fail(); }
  const reader = object.body.getReader();
  const output = new Uint8Array(asset.byteLength); let offset = 0, chunks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GuideAssetError()), 5000); });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      if (++chunks > 4096 || !(next.value instanceof Uint8Array) || !next.value.byteLength || next.value.byteLength > output.length - offset) fail();
      output.set(next.value, offset); offset += next.value.byteLength;
    }
    if (offset !== asset.byteLength || await guideSha256(output) !== asset.sha256) fail();
    const dimensions = webpDimensions(output);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) fail();
    return output;
  } finally {
    clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
/** Parse bounded static WebP container/header, without a decoder or executable formats. */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 20 || bytes.length > GUIDE_MAX_OBJECT_BYTES) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) !== bytes.length - 8) return fail();
  let dimensions: {width: number; height: number} | undefined, pixels = 0, chunks = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (++chunks > 128 || offset + 8 > bytes.length) return fail();
    const kind = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size + (size & 1) > bytes.length || ['ANIM', 'ANMF'].includes(kind)) return fail();
    if (kind === 'VP8X') {
      if (offset !== 12 || size !== 10 || (bytes[start]! & 2)) return fail();
      const u24 = (at: number) => bytes[at]! | bytes[at + 1]! << 8 | bytes[at + 2]! << 16;
      dimensions = { width: u24(start + 4) + 1, height: u24(start + 7) + 1 };
    } else if (kind === 'VP8 ') {
      if (++pixels > 1 || size < 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) return fail();
      const decoded = { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
      if (dimensions && (dimensions.width !== decoded.width || dimensions.height !== decoded.height)) return fail();
      dimensions = decoded;
    } else if (kind === 'VP8L') {
      if (++pixels > 1 || size < 5 || bytes[start] !== 0x2f) return fail();
      const bits = view.getUint32(start + 1, true), decoded = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      if (dimensions && (dimensions.width !== decoded.width || dimensions.height !== decoded.height)) return fail();
      dimensions = decoded;
    } else if (!['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(kind)) return fail();
    offset = start + size + (size & 1);
  }
  if (pixels !== 1 || !dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 4096 || dimensions.height > 4096) return fail();
  return dimensions;
}
async function readWithDeadline(reader: GuideAssetReader, digest: string): Promise<GuideReadObject | null> {
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new GuideAssetError()); }, 5000); });
  try {
    const pending = reader.readDigest(digest).then(object => {
      if (expired) { if(object)void object.body.cancel().catch(() => {}); throw new GuideAssetError(); } return object;
    });
    return await Promise.race([pending, deadline]);
  } finally { clearTimeout(timer); }
}
export async function createPublicGuideAssets(options: { manifestBytes: Uint8Array; expectedSha256: string;
  reader: (manifest: GuideManifest) => GuideAssetReader }): Promise<GuideAssetService> {
  const manifest = await parseGuideManifest(Uint8Array.from(options.manifestBytes), options.expectedSha256);
  const paths = new Map(manifest.assets.map(asset => [guideAssetPath(manifest, asset), asset]));
  const reader = options.reader(manifest);
  return Object.freeze({
    release: Object.freeze({ enabled: true as const, pack: manifest.pack, version: manifest.version, manifestSha256: options.expectedSha256 }),
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      // No query aliases, redirects, ranges, user-selected versions, proxy URLs or manifest mutation.
      if (!['GET', 'HEAD'].includes(request.method) || url.search || request.headers.has('Range')) return unavailableGuideResponse();
      const asset = paths.get(url.pathname); if (!asset) return unavailableGuideResponse();
      try {
        const object = await readWithDeadline(reader, asset.sha256); if (!object) return unavailableGuideResponse();
        const bytes = await readGuideBytes(object, asset);
        return new Response(request.method === 'HEAD' ? null : Uint8Array.from(bytes).buffer, { status: 200, headers: { ...safeHeaders,
          'Content-Type': asset.mime, 'Content-Length': String(asset.byteLength), ETag: `"sha256-${asset.sha256}"`,
          'Cache-Control': GUIDE_CACHE_CONTROL } });
      } catch { return unavailableGuideResponse(503); }
    },
  });
}

/** Install only independently verified services. Unknown packs and aliases are
 * terminal; no service may borrow another pack's objects or the MEDIA bucket. */
export function combinePublicGuideAssets(services:readonly GuideAssetService[]):PublicGuideAssets{
  const byPack=new Map<GuidePackId,GuideAssetService>();
  for(const service of services){
    if(byPack.has(service.release.pack))throw new GuideAssetError();
    byPack.set(service.release.pack,service);
  }
  const releases=Object.freeze(Object.fromEntries([...byPack].map(([pack,service])=>[pack,service.release])) as Partial<Record<GuidePackId,GuideRelease>>);
  return Object.freeze({release:releases.dragon,releases,async fetch(request:Request){
    const path=new URL(request.url).pathname;
    for(const [pack,service] of byPack)if(path.startsWith(`${GUIDE_PREFIX}/${pack}/`))return service.fetch(request);
    return unavailableGuideResponse();
  }});
}
