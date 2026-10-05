import type {GuidePackId} from '../../experience-profiles';
import {DRAGON_PAGE_SUPPORT} from './page-support';
import {AI_SISTER_PAGE_SUPPORT} from './ai-sister-pages';
import {DRAGON_RELEASE_PIN} from './release-pin';
import {AI_SISTER_RELEASE_PIN} from './ai-sister-release-pin';
import type {GuidePack,PageGuideSupport} from './contracts';

// Lightweight gates only: character/art/content modules stay behind dynamic imports.
export const GUIDE_PACKS={
  dragon:{pin:DRAGON_RELEASE_PIN,pages:DRAGON_PAGE_SUPPORT,releasePath:'/api/v1/guide-packs/release',load:()=>import('./packs/dragon').then(module=>module.DRAGON_PACK)},
  'ai-sister':{pin:AI_SISTER_RELEASE_PIN,pages:AI_SISTER_PAGE_SUPPORT,releasePath:'/api/v1/guide-packs/release/ai-sister',load:()=>import('./packs/ai-sister').then(module=>module.AI_SISTER_PACK)},
} satisfies Record<GuidePackId,{pin:{pack:GuidePackId;version:string;manifestSha256:string};pages:Readonly<Record<string,PageGuideSupport>>;releasePath:string;load:()=>Promise<GuidePack>}>;
