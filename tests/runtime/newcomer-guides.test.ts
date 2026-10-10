import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {developmentPages} from '../../modules/development/pages.js';
import {TAB_TITLES} from '../../apps/portal-web/src/Navigation.js';
import {EXPERIENCE_PROFILES,WORKSHOP_THEMES,resolveExperienceProfile,applyExperienceProfile} from '../../apps/portal-web/src/experience-profiles.js';
import {DRAGON_PAGE_SUPPORT,pageGuideSupport} from '../../apps/portal-web/src/modules/newcomer-guides/page-support.js';
import {canRequestGuide,acceptsGuideRelease} from '../../apps/portal-web/src/modules/newcomer-guides/gate.js';
import {DRAGON_RELEASE_PIN} from '../../apps/portal-web/src/modules/newcomer-guides/release-pin.js';
import {DRAGON_PACK} from '../../apps/portal-web/src/modules/newcomer-guides/packs/dragon/index.js';
import {AI_SISTER_PACK} from '../../apps/portal-web/src/modules/newcomer-guides/packs/ai-sister/index.js';
import manifest from '../../contracts/guide-packs/dragon-v1-20261004.json';

const enabled={...DRAGON_RELEASE_PIN,enabled:true};
test('one profile preserves every legacy theme and uses a dark-base opt-in skin without a second activation preference',()=>{
  assert.deepEqual(WORKSHOP_THEMES.map(([id])=>id),['light','dark','versefolk','guide-dragon','guide-ai-sister']);
  for(const id of ['light','dark','versefolk'] as const){
    assert.equal(EXPERIENCE_PROFILES[id].baseTheme,id);assert.equal(EXPERIENCE_PROFILES[id].skin,null);assert.equal(EXPERIENCE_PROFILES[id].guidePack,null);
  }
  const root={dataset:{}} as unknown as HTMLElement;
  assert.equal(applyExperienceProfile('guide-dragon',root),'guide-dragon');
  assert.deepEqual(root.dataset,{theme:'dark',experienceProfile:'guide-dragon',guideSkin:'dragon'});
  for(const id of ['light','dark','versefolk']){applyExperienceProfile(id,root);assert.equal(root.dataset.theme,id);assert.equal(root.dataset.guideSkin,undefined);}
  for(const value of [null,undefined,'dragon','unknown','__proto__','constructor',{},true])assert.equal(resolveExperienceProfile(value).id,'light');
});
test('page support exactly covers both actual development registry and all navigation pages',()=>{
  assert.deepEqual(Object.keys(DRAGON_PAGE_SUPPORT).sort(),developmentPages.map(page=>page.id).sort());
  for(const id of Object.keys(TAB_TITLES))assert.ok(Object.hasOwn(DRAGON_PAGE_SUPPORT,id),id);
  for(const [id,support] of Object.entries(DRAGON_PAGE_SUPPORT)){
    if(support.status==='disabled')assert.ok(support.reason.trim(),id);
    else {assert.equal(support.characterId,id);assert.equal(support.contentId,id);assert.equal(support.anchorContractVersion,1);assert.ok(support.guideIds.length,id);}
  }
  assert.equal(pageGuideSupport('private-ai')?.status,'disabled');
  for(const id of ['unknown','constructor','__proto__'])assert.equal(pageGuideSupport(id),null);
});
test('profile, access and explicit page gates run before any release, character or pack loading',()=>{
  for(const profile of ['light','dark','versefolk','unknown'])assert.equal(canRequestGuide(profile,'home',true,'member-1'),false);
  for(const page of ['unknown','__proto__','private-ai','messages','registration','onboarding','admin','skillbooks'])assert.equal(canRequestGuide('guide-dragon',page,true,'member-1'),false);
  assert.equal(canRequestGuide('guide-dragon','home',false,'member-1'),false);assert.equal(canRequestGuide('guide-dragon','home',true,''),false);
  assert.equal(canRequestGuide('guide-dragon','home',true,'member-1'),true);
  for(const value of [undefined,null,{},false,{...enabled,enabled:false},{...enabled,version:'old'},{...enabled,manifestSha256:'0'.repeat(64)},{...enabled,pack:'foreign'}])assert.equal(acceptsGuideRelease(value),false);
  assert.equal(acceptsGuideRelease(enabled),true);
});
test('all supported refs resolve to reviewed content and exact public digest assets; unknown runtime pages reject',async()=>{
  const allowed=new Set(manifest.assets.map(asset=>`/public/guide-packs/${manifest.pack}/${manifest.version}/${asset.sha256}.webp`));
  for(const [id,status] of Object.entries(DRAGON_PAGE_SUPPORT)){
    if(status.status!=='supported'){await assert.rejects(DRAGON_PACK.loadPage(id));continue;}
    const page=await DRAGON_PACK.loadPage(id),content=await page.loadContent();
    assert.equal(content.id,id);assert.equal(page.character.pageId,id);assert.equal(content.characterName,page.character.name);
    assert.deepEqual(Object.keys(page.guides).sort(),[...status.guideIds].sort());
    for(const guideId of status.guideIds)assert.ok(content.topics.some(topic=>topic.id===guideId),guideId);
    for(const asset of [page.character.portrait,page.character.hero,...page.character.frames,...page.character.views])assert.ok(allowed.has(asset),asset);
  }
  for(const id of ['unknown','constructor','__proto__'])await assert.rejects(DRAGON_PACK.loadPage(id));
});
test('frontend release pin binds exact manifest bytes and source author commit',()=>{
  const bytes=readFileSync(new URL('../../contracts/guide-packs/dragon-v1-20261004.json',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),DRAGON_RELEASE_PIN.manifestSha256);
  assert.equal(manifest.source.repository,'https://github.com/mars-tw/freedom-platform');assert.equal(manifest.source.commit,'46a40342509a9278c3a7b8a940bce27b7f464227');
  assert.equal(manifest.assets.length,364);assert.equal(manifest.assets.reduce((total,asset)=>total+asset.byteLength,0),41016186);
});


test('retired message page rejects both packs before loading guide content',async()=>{
  const support=pageGuideSupport('messages');
  assert.equal(support?.status,'disabled');
  if(support?.status==='disabled')assert.match(support.reason,/常駐聊天室/);
  for(const profile of ['guide-dragon','guide-ai-sister'])assert.equal(canRequestGuide(profile,'messages',true,'member-1'),false);
  await assert.rejects(DRAGON_PACK.loadPage('messages'),/Unsupported guide page/);
  await assert.rejects(AI_SISTER_PACK.loadPage('messages'),/Unsupported guide page/);
});
