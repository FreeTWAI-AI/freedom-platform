import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { guideObjectKey, guideSha256, parseGuideManifest, webpDimensions,type GuidePackId } from '../packages/public-guide-assets/index.js';
import { readLocalGuideBytes } from '../packages/public-guide-assets/node.js';
import {GUIDE_ASSET_CATALOG} from '../packages/public-guide-assets/catalog.js';
const root = fileURLToPath(new URL('../', import.meta.url));
/** Read-only local plan. No credentials, provider SDK, upload, bucket creation or execution mode. */
export async function guidePublishPlan(fixtureRoot: string,pack:GuidePackId='dragon') {
  if(!Object.hasOwn(GUIDE_ASSET_CATALOG,pack))throw Error('unregistered_guide_pack');
  const {release,manifestText}=GUIDE_ASSET_CATALOG[pack];
  const manifestBytes = await readFile(resolve(root, 'contracts/guide-packs', release.version + '.json'));
  if (!manifestBytes.equals(Buffer.from(manifestText, 'utf8'))) throw Error('guide_embedded_manifest_drift');
  const manifest = await parseGuideManifest(manifestBytes, release.manifestSha256);
  if(manifest.pack!==pack || manifest.version!==release.version)throw Error('guide_release_identity_mismatch');
  const objects = [];
  for (const asset of manifest.assets) {
    const bytes = await readLocalGuideBytes(fixtureRoot, asset);
    if (await guideSha256(bytes) !== asset.sha256) throw Error('guide_asset_integrity_failed');
    const dimensions = webpDimensions(bytes);
    const image = sharp(bytes, { animated: true, limitInputPixels: 4096 * 4096, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'webp' || (metadata.pages ?? 1) !== 1 || metadata.width !== asset.width || metadata.height !== asset.height
      || dimensions.width !== asset.width || dimensions.height !== asset.height) throw Error('guide_asset_format_failed');
    await image.stats(); // Decode actual bytes, rather than trusting filename or headers.
    objects.push({ logicalId: asset.logicalId, key: guideObjectKey(manifest, asset), sha256: asset.sha256,
      byteLength: bytes.byteLength, mime: asset.mime, width: asset.width, height: asset.height });
  }
  return { schema: 'freedom.guide-pack-publish-plan/v1', status: 'verified_local_plan',
    pack: manifest.pack, version: manifest.version, source: manifest.source,
    manifestSha256: release.manifestSha256, purpose: manifest.purpose, binding: 'GUIDE_STATIC',
    private_origin_required: true, production_enabled: false, provider_mutations: 0, publisher_receipts: 'not_run',
    object_count: objects.length, unique_object_count: new Set(objects.map(item => item.sha256)).size,
    total_bytes: objects.reduce((sum, item) => sum + item.byteLength, 0), objects };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (![2,4].includes(args.length) || args[0] !== '--fixture-root' || !args[1] || args[1].startsWith('-') || (args.length===4 && (args[2]!=='--pack' || !['dragon','ai-sister'].includes(args[3]!)))) {
    console.error('Usage: tsx scripts/guide-pack-publish-plan.ts --fixture-root <local-art-directory> [--pack dragon|ai-sister] (plan only)'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await guidePublishPlan(resolve(args[1]),args[3] as GuidePackId|undefined), null, 2)); }
    catch { console.error('Guide publish plan failed local integrity/format validation; nothing was published.'); process.exitCode = 1; }
  }
}
