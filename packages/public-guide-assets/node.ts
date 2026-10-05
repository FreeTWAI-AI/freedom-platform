import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPublicGuideAssets, GuideAssetError, type GuideAsset, type GuideAssetReader, type GuideManifest } from './index.js';
/** Local fixture bytes only. No network, credentials, uploads, or public static mount. */
export async function readLocalGuideBytes(root: string, asset: GuideAsset): Promise<Uint8Array> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/.test(asset.logicalId)) throw new GuideAssetError();
  const canonical = resolve(root), file = join(canonical, asset.logicalId + '.webp');
  if (await realpath(canonical) !== canonical || await realpath(file) !== file) throw new GuideAssetError();
  for (const path of [canonical, join(canonical, asset.logicalId.split('/')[0]!)]) {
    const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GuideAssetError();
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== asset.byteLength) throw new GuideAssetError();
    const bytes = new Uint8Array(asset.byteLength + 1); let offset = 0;
    while (offset < bytes.length) {
      const next = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) break; offset += next.bytesRead;
    }
    if (offset !== asset.byteLength) throw new GuideAssetError();
    return bytes.slice(0, offset);
  } finally { await handle.close(); }
}
export function createLocalGuideReader(root: string, manifest: GuideManifest): GuideAssetReader {
  const allowlist = new Map(manifest.assets.map(asset => [asset.sha256, asset]));
  return Object.freeze({ async readDigest(digest: string) {
    const asset = allowlist.get(digest); if (!asset) throw new GuideAssetError();
    const bytes = await readLocalGuideBytes(root, asset);
    return { byteLength: bytes.byteLength, mime: asset.mime,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  } });
}
export async function createLocalGuideAssets(options: { freedomEnv: string; fixtureDirectory: string;
  manifestBytes: Uint8Array; expectedSha256: string }) {
  if (options.freedomEnv !== 'local') throw new GuideAssetError();
  return createPublicGuideAssets({ ...options, reader: manifest => createLocalGuideReader(options.fixtureDirectory, manifest) });
}
