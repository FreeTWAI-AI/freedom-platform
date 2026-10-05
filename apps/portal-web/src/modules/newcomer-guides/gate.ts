import {resolveExperienceProfile,type GuidePackId} from '../../experience-profiles';
import {GUIDE_PACKS} from './pack-registry';
import type {PageGuideSupport} from './contracts';
export function canRequestGuide(profile:unknown,pageId:string,memberAccess:boolean,scopeKey:string):boolean {
  const pack=resolveExperienceProfile(profile).guidePack;
  if(!memberAccess || !scopeKey || !pack)return false;
  const pages:Readonly<Record<string,PageGuideSupport>>=GUIDE_PACKS[pack].pages;
  return Object.hasOwn(pages,pageId) && pages[pageId].status==='supported';
}
export function acceptsGuideRelease(value:unknown,pack:GuidePackId='dragon'):boolean {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const release=value as Record<string,unknown>;
  const pin=GUIDE_PACKS[pack].pin;
  return release.enabled===true && release.pack===pin.pack
    && release.version===pin.version && release.manifestSha256===pin.manifestSha256;
}
