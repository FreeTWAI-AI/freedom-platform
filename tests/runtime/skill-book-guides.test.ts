import {test} from 'node:test';
import assert from 'node:assert/strict';
import {communityCatalog,skillBooksForGuild} from '../../modules/community/catalog.js';
import {skillBookGuides} from '../../modules/community/skill-book-guides.js';

test('every catalog and featured skill book carries a complete, specific guide with pinned primary evidence',()=>{
  assert.deepEqual(Object.keys(skillBookGuides).sort(),communityCatalog.skill_books.map(book=>book.id).sort());
  const summaries=new Set<string>(),deliverables=new Set<string>();
  for(const book of [...communityCatalog.skill_books,...communityCatalog.featured_projects]){
    const guide=book.guide;assert.ok(guide,book.id);assert.equal(guide,skillBookGuides[book.id]);
    assert.equal(book.description,guide.summary);assert.equal(book.source_commit,guide.source_commit);assert.match(guide.source_commit,/^[0-9a-f]{40}$/);
    assert.ok(guide.audience.length&&guide.features.length>=2&&guide.prerequisites.length&&guide.first_steps.length>=2,book.id);
    assert.ok(guide.first_result.length>15&&guide.status.length>15&&guide.contribution.length>15,book.id);
    const upstream=new URL(book.upstream_url);
    for(const evidence of guide.source_evidence){const url=new URL(evidence.url);assert.equal(url.protocol,'https:');assert.equal(url.hostname,'github.com');assert.equal(url.username,'');assert.equal(url.pathname,`${upstream.pathname}/blob/${guide.source_commit}/${evidence.path}`);}
    assert.ok(guide.source_evidence.some(evidence=>evidence.url===guide.reading_url),book.id);
    assert.equal(new URL(guide.contribution_url).pathname,`${new URL(book.repository_url).pathname}/issues`);
    if(guide.website_url){const url=new URL(guide.website_url);assert.equal(url.protocol,'https:');assert.equal(url.username,'');}
    if(guide.quickstart){assert.ok(guide.quickstart.commands.trim());assert.match(guide.quickstart.context,/沒有代為安裝或執行/);assert.doesNotMatch(guide.quickstart.commands,/curl.*\|\s*(sh|bash)|wrangler deploy|sudo|--remote/);}
    summaries.add(guide.summary);deliverables.add(guide.first_result);
  }
  assert.equal(summaries.size,communityCatalog.skill_books.length);assert.equal(deliverables.size,communityCatalog.skill_books.length);
  assert.ok(skillBooksForGuild('guild_commerce_sales').every(book=>book.guide));
});

test('guides keep working client, local demo, alpha and unimplemented service boundaries distinct',()=>{
  assert.match(skillBookGuides['supplier-client'].status,/沒有寫入或付款權限/);
  assert.match(skillBookGuides.storefront.status,/結帳、訂單與金流尚未實作/);
  assert.match(skillBookGuides['agent-kit'].status,/本機示範/);
  assert.match(skillBookGuides['hao-studio'].status,/靜態網站/);
  assert.match(skillBookGuides['ai-sister'].status,/alpha/);
  assert.match(skillBookGuides['security-scanner'].status,/HOLD/);
  assert.match(skillBookGuides['music-mv'].status,/手冊/);
  assert.match(skillBookGuides['social-post'].status,/未全面驗收/);
});
