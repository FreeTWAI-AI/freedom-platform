import { createPublicGuideAssets, type PublicGuideAssets } from './index.js';
import { createR2GuideReader, type GuideR2Binding } from './r2.js';
import { dragonManifestText } from './dragon-manifest.generated.js';
import { DRAGON_GUIDE_RELEASE } from './release.js';
/** Both a reviewed enabled release AND explicit native binding are required.
 * No fixture flag, arbitrary manifest input, external URL or MEDIA fallback. */
export async function installWorkerGuideAssets(env: { GUIDE_STATIC?: GuideR2Binding;
  FREEDOM_PUBLIC_GUIDE_ENABLED?: string }): Promise<PublicGuideAssets | undefined> {
  if (!DRAGON_GUIDE_RELEASE.enabled || env.FREEDOM_PUBLIC_GUIDE_ENABLED !== 'true' || !env.GUIDE_STATIC) return undefined;
  try {
    return await createPublicGuideAssets({ manifestBytes: new TextEncoder().encode(dragonManifestText),
      expectedSha256: DRAGON_GUIDE_RELEASE.manifestSha256, reader: manifest => createR2GuideReader(env.GUIDE_STATIC!, manifest) });
  } catch { return undefined; }
}
