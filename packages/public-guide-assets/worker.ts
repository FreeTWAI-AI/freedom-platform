import { combinePublicGuideAssets, createPublicGuideAssets, GuideAssetError, type PublicGuideAssets } from './index.js';
import { createR2GuideReader, type GuideR2Binding } from './r2.js';
import {GUIDE_ASSET_CATALOG} from './catalog.js';
// Initialization only hashes/parses bundled bytes. Never share R2 I/O, response
// bodies or image bytes across requests. A different native bucket gets its own
// service, and disabled hosts check their flag before consulting this cache.
const installed = new WeakMap<GuideR2Binding, Promise<PublicGuideAssets | undefined>>();
/** Both a reviewed enabled release AND explicit native binding are required.
 * No fixture flag, arbitrary manifest input, external URL or MEDIA fallback. */
export async function installWorkerGuideAssets(env: { GUIDE_STATIC?: GuideR2Binding;
  FREEDOM_PUBLIC_GUIDE_ENABLED?: string }): Promise<PublicGuideAssets | undefined> {
  if (env.FREEDOM_PUBLIC_GUIDE_ENABLED !== 'true' || !env.GUIDE_STATIC) return undefined;
  const enabled=Object.values(GUIDE_ASSET_CATALOG).filter(descriptor=>descriptor.release.enabled);
  if(!enabled.length)return undefined;
  const binding = env.GUIDE_STATIC;
  if (typeof binding !== 'object') return undefined;
  const cached = installed.get(binding);
  if (cached) return cached;
  const pending: Promise<PublicGuideAssets | undefined> = Promise.allSettled(enabled.map(async({manifestText,release})=>{
    const service=await createPublicGuideAssets({
      manifestBytes: new TextEncoder().encode(manifestText),
      expectedSha256: release.manifestSha256,
      reader: manifest => createR2GuideReader(binding, manifest),
    });
    if(service.release.pack!==release.pack || service.release.version!==release.version)throw new GuideAssetError();
    return service;
  })).then(results=>{
    const services=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
    // One corrupt pack must not hide another valid pack; retry failed setup later.
    if(services.length!==enabled.length && installed.get(binding)===pending)installed.delete(binding);
    return services.length?combinePublicGuideAssets(services):undefined;
  });
  installed.set(binding, pending);
  return pending;
}
