import type { R2Bucket } from '@cloudflare/workers-types';
import { GuideAssetError, guideObjectKey, type GuideAssetReader, type GuideManifest } from './index.js';
/** Only GET is captured. This deliberately is not the member/private ObjectStore. */
export type GuideR2Binding = Pick<R2Bucket, 'get'>;
export function createR2GuideReader(binding: GuideR2Binding, manifest: GuideManifest): GuideAssetReader {
  if (!binding || typeof binding.get !== 'function') throw new GuideAssetError();
  const get = binding.get.bind(binding), allowlist = new Map(manifest.assets.map(asset => [asset.sha256, asset]));
  return Object.freeze({ async readDigest(digest: string) {
    const asset = allowlist.get(digest); if (!asset) throw new GuideAssetError();
    const key = guideObjectKey(manifest, asset);
    const object = await get(key);
    if (!object) return null;
    if (!('body' in object)) throw new GuideAssetError();
    if (object.key !== key || (object.range && (!('offset' in object.range) || object.range.offset !== 0 || !('length' in object.range) || object.range.length !== asset.byteLength)) || object.httpMetadata?.contentType !== asset.mime || object.size !== asset.byteLength) {
      try { await object.body.cancel(); } catch {} throw new GuideAssetError();
    }
    return { byteLength: object.size, mime: asset.mime, body: object.body as unknown as ReadableStream<Uint8Array> };
  } });
}
