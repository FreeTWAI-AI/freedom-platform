import {resolveExperienceProfile} from '../../experience-profiles';
import {pageGuideSupport} from './page-support';
import {DRAGON_RELEASE_PIN} from './release-pin';
export function canRequestGuide(profile:unknown,pageId:string,memberAccess:boolean,scopeKey:string):boolean {
  return memberAccess && Boolean(scopeKey) && resolveExperienceProfile(profile).guidePack==='dragon'
    && pageGuideSupport(pageId)?.status==='supported';
}
export function acceptsGuideRelease(value:unknown):boolean {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const release=value as Record<string,unknown>;
  return release.enabled===true && release.pack===DRAGON_RELEASE_PIN.pack
    && release.version===DRAGON_RELEASE_PIN.version && release.manifestSha256===DRAGON_RELEASE_PIN.manifestSha256;
}
