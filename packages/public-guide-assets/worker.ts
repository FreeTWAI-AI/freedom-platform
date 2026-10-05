import { createPublicGuideAssets, type PublicGuideAssets } from './index.js';
import { createR2GuideReader, type GuideR2Binding } from './r2.js';
import { dragonManifestText } from './dragon-manifest.generated.js';
import { DRAGON_GUIDE_RELEASE } from './release.js';
// Initialization only hashes/parses bundled bytes. Never share R2 I/O, response
// bodies or image bytes across requests. A different native bucket gets its own
// service, and disabled hosts check their flag before consulting this cache.
const installed = new WeakMap<GuideR2Binding, Promise<PublicGuideAssets | undefined>>();
/** Both a reviewed enabled release AND explicit native binding are required.
 * No fixture flag, arbitrary manifest input, external URL or MEDIA fallback. */
export async function installWorkerGuideAssets(env: { GUIDE_STATIC?: GuideR2Binding;
  FREEDOM_PUBLIC_GUIDE_ENABLED?: string }): Promise<PublicGuideAssets | undefined> {
  if (!DRAGON_GUIDE_RELEASE.enabled || env.FREEDOM_PUBLIC_GUIDE_ENABLED !== 'true' || !env.GUIDE_STATIC) return undefined;
  const binding = env.GUIDE_STATIC;
  if (typeof binding !== 'object') return undefined;
  const cached = installed.get(binding);
  if (cached) return cached;
  const pending: Promise<PublicGuideAssets | undefined> = createPublicGuideAssets({
    manifestBytes: new TextEncoder().encode(dragonManifestText),
    expectedSha256: DRAGON_GUIDE_RELEASE.manifestSha256,
    reader: manifest => createR2GuideReader(binding, manifest),
  }).catch(() => {
    if (installed.get(binding) === pending) installed.delete(binding);
    return undefined;
  });
  installed.set(binding, pending);
  return pending;
}
