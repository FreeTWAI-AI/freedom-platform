import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {z} from 'zod';
import {developmentPages} from '../../modules/development/pages.js';
import {applyExperienceProfile} from '../../apps/portal-web/src/experience-profiles.js';
import {AI_SISTER_PAGE_SUPPORT} from '../../apps/portal-web/src/modules/newcomer-guides/ai-sister-pages.js';
import {AI_SISTER_PACK} from '../../apps/portal-web/src/modules/newcomer-guides/packs/ai-sister/index.js';
import {AI_SISTER_RELEASE_PIN} from '../../apps/portal-web/src/modules/newcomer-guides/ai-sister-release-pin.js';
import {AI_SISTER_CHARACTER_IDS,readAiSisterCharacter,resolveAiSisterCharacter} from '../../apps/portal-web/src/modules/newcomer-guides/character-choice.js';
import {canRequestGuide,acceptsGuideRelease} from '../../apps/portal-web/src/modules/newcomer-guides/gate.js';
import {DRAGON_RELEASE_PIN} from '../../apps/portal-web/src/modules/newcomer-guides/release-pin.js';
import {createPageSession} from '../../apps/portal-web/src/modules/newcomer-guides/engine/core.js';
import {AI_SISTER_GUIDE_RELEASE} from '../../packages/public-guide-assets/ai-sister-release.js';
import {aiSisterManifestText} from '../../packages/public-guide-assets/ai-sister-manifest.generated.js';
import {GUIDE_PACK_LIMITS,guideManifestSchema,parseGuideManifest,guideSha256,guideAssetPath} from '../../packages/public-guide-assets/index.js';
import {createLocalGuideCatalog} from '../../packages/public-guide-assets/node.js';
import {installWorkerGuideAssets} from '../../packages/public-guide-assets/worker.js';
import type {GuideR2Binding} from '../../packages/public-guide-assets/r2.js';
import {guidePublishPlan} from '../../scripts/guide-pack-publish-plan.js';
import {createApp} from '../../apps/platform-api/src/app.js';

test('AI Sister is light, opt-in and independently gated by release/page/member scope',()=>{
  const root={dataset:{}} as unknown as HTMLElement;
  applyExperienceProfile('guide-ai-sister',root);
  assert.deepEqual(root.dataset,{theme:'light',experienceProfile:'guide-ai-sister',guideSkin:'ai-sister'});
  for(const id of ['light','dark','versefolk']){applyExperienceProfile(id,root);assert.equal(root.dataset.guideSkin,undefined);}
  assert.equal(canRequestGuide('guide-ai-sister','home',true,'member-1'),true);
  for(const [page,access,scope] of [['home',false,'member-1'],['home',true,''],['private-ai',true,'member-1'],['onboarding',true,'member-1'],['__proto__',true,'member-1']] as const)assert.equal(canRequestGuide('guide-ai-sister',page,access,scope),false);
  assert.equal(acceptsGuideRelease({...AI_SISTER_RELEASE_PIN,enabled:true},'ai-sister'),true);
  assert.equal(acceptsGuideRelease({...DRAGON_RELEASE_PIN,enabled:true},'ai-sister'),false);
  assert.equal(acceptsGuideRelease({...AI_SISTER_RELEASE_PIN,enabled:true},'dragon'),false);
  assert.equal(acceptsGuideRelease({...AI_SISTER_RELEASE_PIN,enabled:false},'ai-sister'),false);
});

test('all 17 choices retain canonical names and all 20 actual outfits with three real reaction poses',()=>{
  assert.deepEqual(AI_SISTER_PACK.characterChoices?.map(choice=>choice.id),[...AI_SISTER_CHARACTER_IDS]);
  assert.equal(AI_SISTER_PACK.gallery.find(character=>character.pageId==='venice')?.name,'Llama');
  assert.equal(AI_SISTER_PACK.gallery.find(character=>character.pageId==='chatgpt')?.name,'ChatGPT');
  for(const character of AI_SISTER_PACK.gallery){
    assert.equal(character.outfits?.length,20);assert.equal(new Set(character.outfits?.map(outfit=>outfit.id)).size,20);
    assert.equal(character.frames.length,0,'reaction stills are not fabricated six-frame animations');
    for(const outfit of character.outfits!){assert.equal(outfit.views.length,4);assert.equal(outfit.viewLabels.length,4);assert.equal(new Set(outfit.views).size,4);assert.deepEqual(Object.keys(outfit.reactions),['wave','think','cheer']);}
  }
  for(const bad of [null,undefined,'unknown','__proto__','constructor',{},true])assert.equal(resolveAiSisterCharacter(bad),'claude');
  assert.equal(readAiSisterCharacter({getItem(){throw Error('blocked')}}),'claude');
  assert.equal(readAiSisterCharacter({getItem(){return 'kimi'}}),'kimi');
});

test('every member-selected character stays the same on every supported page while its outfit and facts follow that page',async()=>{
  assert.deepEqual(Object.keys(AI_SISTER_PAGE_SUPPORT).sort(),developmentPages.map(page=>page.id).sort());
  const manifest=await parseGuideManifest(new TextEncoder().encode(aiSisterManifestText),AI_SISTER_RELEASE_PIN.manifestSha256);
  const paths=new Set(manifest.assets.map(asset=>guideAssetPath(manifest,asset)));
  for(const id of AI_SISTER_CHARACTER_IDS)for(const [pageId,support] of Object.entries(AI_SISTER_PAGE_SUPPORT)){
    if(support.status!=='supported'){assert.ok(support.reason);await assert.rejects(AI_SISTER_PACK.loadPage(pageId,id));continue;}
    const page=await AI_SISTER_PACK.loadPage(pageId,id),content=await page.loadContent();
    assert.equal(page.character.pageId,id);assert.equal(page.character.outfitId,support.outfitId);
    assert.equal(content.id,pageId);assert.equal(content.characterName,page.character.name);assert.ok(content.entryLine.startsWith(`我是 ${page.character.name}。`));
    assert.ok(paths.has(page.character.hero));assert.ok(paths.has(page.character.portrait));
    for(const src of Object.values(page.character.reactions!))assert.ok(paths.has(src));
    assert.deepEqual(Object.keys(page.guides).sort(),[...support.guideIds].sort());
    const session=createPageSession(content);
    for(const topic of content.topics)assert.equal(session.ask(topic.label,topic.id).text,topic.answer);
  }
  for(const id of ['unknown','__proto__','constructor'])await assert.rejects(AI_SISTER_PACK.loadPage(id,'kimi'));
});

test('all wardrobe bytes decode and match the pinned manifest, without implying upload or enabling production',async()=>{
  const bytes=await readFile('contracts/guide-packs/ai-sister-v1-20261005.json');
  assert.equal(bytes.toString('utf8'),aiSisterManifestText);assert.equal(await guideSha256(bytes),AI_SISTER_RELEASE_PIN.manifestSha256);
  assert.equal(AI_SISTER_GUIDE_RELEASE.manifestSha256,AI_SISTER_RELEASE_PIN.manifestSha256);
  const plan=await guidePublishPlan('assets/guide-packs/ai-sister-v1-20261005','ai-sister');
  assert.equal(plan.object_count,1377);assert.equal(plan.unique_object_count,1377);
  assert.equal(plan.provider_mutations,0);assert.equal(plan.publisher_receipts,'not_run');
  assert.ok(plan.objects.every(object=>object.key.startsWith('guide-packs/ai-sister/ai-sister-v1-20261005/')));
  assert.ok(plan.total_bytes<GUIDE_PACK_LIMITS['ai-sister'].totalBytes);
});

test('pack-specific budgets preserve Dragon limits and reject mismatched pack/version contracts',async()=>{
  assert.deepEqual(GUIDE_PACK_LIMITS.dragon,{assets:512,manifestBytes:256*1024,totalBytes:64*1024*1024});
  const schema=JSON.parse(await readFile('contracts/guide-packs/manifest.schema.json','utf8'));
  assert.deepEqual(schema,z.toJSONSchema(guideManifestSchema));
  const manifest=JSON.parse(aiSisterManifestText);
  for(const change of [(m:any)=>{m.pack='dragon'},(m:any)=>{m.version='dragon-v1-20261004'},(m:any)=>{m.pack='__proto__'},(m:any)=>{m.assets=Array.from({length:1537},(_,i)=>({...m.assets[0],logicalId:`claude/item-${i}`}))}]){
    const copy=structuredClone(manifest);change(copy);const bytes=new TextEncoder().encode(JSON.stringify(copy));await assert.rejects(parseGuideManifest(bytes,await guideSha256(bytes)));
  }
});

test('AI Sister activation pins complete private-origin readbacks for both environments',async()=>{
  const root='contracts/guide-packs/receipts/';
  const bytes=await readFile(root+'ai-sister-v1-20261005.json');
  assert.equal(AI_SISTER_GUIDE_RELEASE.enabled,true);
  assert.equal(AI_SISTER_GUIDE_RELEASE.publisherReceipt,'sha256:'+await guideSha256(bytes));
  const set=JSON.parse(bytes.toString());
  assert.equal(set.schema,'freedom.guide-publisher-receipt-set/v1');
  assert.equal(set.manifestSha256,AI_SISTER_GUIDE_RELEASE.manifestSha256);
  assert.equal(set.sourceCommit,'2325b2ddd41832306982417822f56c990c9dccc1');
  assert.equal(set.binding,'GUIDE_STATIC');assert.equal(set.privateOriginRequired,true);
  assert.deepEqual(set.receipts.map((entry:any)=>entry.environment).sort(),['next','staging']);
  const manifest=await parseGuideManifest(new TextEncoder().encode(aiSisterManifestText),AI_SISTER_GUIDE_RELEASE.manifestSha256);
  const expected=new Map(manifest.assets.map(asset=>[asset.sha256,asset]));
  assert.equal(expected.size,1377);
  for(const entry of set.receipts){
    assert.equal(entry.receipt,`ai-sister-v1-20261005-${entry.environment}.json`);
    assert.equal(entry.bucket,entry.environment==='next'?'freedom-next-guide-static':'freedom-staging-next-guide-static');
    const receiptBytes=await readFile(root+entry.receipt);assert.equal(await guideSha256(receiptBytes),entry.sha256);
    const receipt=JSON.parse(receiptBytes.toString());
    assert.equal(receipt.schema,'freedom.guide-publisher-receipt/v1');assert.equal(receipt.status,'verified');
    assert.equal(receipt.target,entry.environment);assert.equal(receipt.bucket,entry.bucket);
    assert.equal(receipt.sourceCommit,set.sourceCommit);assert.equal(receipt.manifestSha256,set.manifestSha256);
    assert.equal(receipt.binding,'GUIDE_STATIC');assert.equal(receipt.productionEnabled,false,'publication receipts precede activation');
    for(const origin of [receipt.originBefore,receipt.originAfter]){
      assert.equal(origin.bucket,entry.bucket);assert.equal(origin.managedEnabled,false);assert.deepEqual(origin.customDomains,[]);
    }
    assert.equal(entry.objectCount,expected.size);assert.equal(receipt.objectCount,expected.size);assert.equal(receipt.objects.length,expected.size);
    assert.equal(new Set(receipt.objects.map((object:any)=>object.sha256)).size,expected.size);
    for(const object of receipt.objects){
      const asset=expected.get(object.sha256);assert(asset);
      assert.equal(object.key,`guide-packs/ai-sister/${manifest.version}/${asset.sha256}.webp`);
      assert.equal(object.byteLength,asset.byteLength);assert.equal(object.mime,asset.mime);
      assert.ok(Number.isFinite(Date.parse(object.checkedAt)));assert.ok(object.cfRay);
    }
    const total=[...expected.values()].reduce((sum,asset)=>sum+asset.byteLength,0);
    assert.equal(receipt.totalBytes,total);assert.equal(entry.totalBytes,total);assert.equal(total,62_044_286);
  }
});

test('two installed packs expose independent releases and retain explicit Worker host/binding gates',async()=>{
  const assets=await createLocalGuideCatalog('local');
  const pool={query(){throw Error('Guide assets must not query private member data')}} as unknown as Pool;
  const app=createApp(pool,'http://127.0.0.1:4377','local',{publicGuideAssets:assets});
  for(const pack of ['dragon','ai-sister'] as const){
    const response=await app.request(`/api/v1/guide-packs/release/${pack}`);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal((await response.json()).pack,pack);
  }
  assert.equal((await (await app.request('/api/v1/guide-packs/release')).json()).pack,'dragon');
  assert.deepEqual(await (await app.request('/api/v1/guide-packs/release/__proto__')).json(),{enabled:false});
  const manifest=JSON.parse(aiSisterManifestText),path=guideAssetPath(manifest,manifest.assets[0]);
  assert.equal((await app.request(path)).status,200);
  for(const bad of [path.replace('/ai-sister/','/dragon/'),path+'?pack=dragon',path.replace('ai-sister-v1-20261005','ai-sister-v2-20261005')])assert.equal((await app.request(bad)).status,404);
  await assert.rejects(createLocalGuideCatalog('public'));
  let reads=0;
  const asset=manifest.assets[0],bytes=await readFile(`assets/guide-packs/${manifest.version}/${asset.logicalId}.webp`);
  const binding={async get(key:string){reads++;assert.equal(key,`guide-packs/ai-sister/${manifest.version}/${asset.sha256}.webp`);return {key,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}}),size:bytes.length,httpMetadata:{contentType:'image/webp'}};}} as unknown as GuideR2Binding;
  assert.equal(await installWorkerGuideAssets({GUIDE_STATIC:binding}),undefined);
  assert.equal(await installWorkerGuideAssets({GUIDE_STATIC:binding,FREEDOM_PUBLIC_GUIDE_ENABLED:'false'}),undefined);
  assert.equal(await installWorkerGuideAssets({FREEDOM_PUBLIC_GUIDE_ENABLED:'true'}),undefined);
  assert.equal(reads,0);
  const worker=await installWorkerGuideAssets({GUIDE_STATIC:binding,FREEDOM_PUBLIC_GUIDE_ENABLED:'true'});
  assert.equal(worker?.releases?.['ai-sister']?.manifestSha256,AI_SISTER_RELEASE_PIN.manifestSha256);
  assert.equal(worker?.releases?.dragon?.manifestSha256,DRAGON_RELEASE_PIN.manifestSha256);
  assert.equal(reads,0,'initialization does not read R2');
  for(const method of ['GET','HEAD']){
    const response:Response=await worker!.fetch(new Request('https://guide.test'+path,{method}));assert.equal(response.status,200);
    assert.equal((await response.arrayBuffer()).byteLength,method==='HEAD'?0:bytes.length);
  }
  assert.equal(reads,2,'each response verifies fresh storage bytes');
  assert.equal((await worker!.fetch(new Request('https://guide.test'+path.replace('/ai-sister/','/dragon/')))).status,404);
  assert.equal(reads,2,'cross-pack requests never reach storage');
  assert.equal(await installWorkerGuideAssets({GUIDE_STATIC:binding,FREEDOM_PUBLIC_GUIDE_ENABLED:'false'}),undefined,'cached initialization cannot bypass host disablement');
});
