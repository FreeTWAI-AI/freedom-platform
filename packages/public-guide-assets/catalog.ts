import {dragonManifestText} from './dragon-manifest.generated.js';
import {aiSisterManifestText} from './ai-sister-manifest.generated.js';
import {DRAGON_GUIDE_RELEASE} from './release.js';
import {AI_SISTER_GUIDE_RELEASE} from './ai-sister-release.js';

// Reviewed build-time descriptors, never request-selected manifests or origins.
export const GUIDE_ASSET_CATALOG={
  dragon:{release:DRAGON_GUIDE_RELEASE,manifestText:dragonManifestText},
  'ai-sister':{release:AI_SISTER_GUIDE_RELEASE,manifestText:aiSisterManifestText},
} as const;
