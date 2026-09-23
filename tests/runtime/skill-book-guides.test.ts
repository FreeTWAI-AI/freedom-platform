import {test} from 'node:test';
import assert from 'node:assert/strict';
import {communityCatalog,skillBooksForGuild} from '../../modules/community/catalog.js';
import {skillBookGuides} from '../../modules/community/skill-book-guides.js';
import {developmentMap,skillMarkdown,pageHtml} from '../../modules/development/service.js';
import {skillBookCoverUrl,skillBookStarUrl} from '../../apps/portal-web/src/modules/SkillBookCover.js';

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

test('all 22 books expose distinct covers, original-author stars and the same beginner guidance in public formats',()=>{
  const covers=new Set<string>();
  for(const book of developmentMap().skill_books){
    const guide=book.guide!;
    assert.ok(guide.beginner,book.id);
    for(const [field,value] of Object.entries(guide.beginner))assert.ok(value.trim().length>0,`${book.id}/${field}`);
    assert.ok(guide.beginner.purpose.length<=80,book.id);
    assert.equal(book.cover_url,`/art/skills/${book.id}.webp`);
    assert.equal(book.star_url,book.upstream_url);
    assert.equal(skillBookStarUrl(book),book.upstream_url);
    covers.add(book.cover_url!);
    const markdown=skillMarkdown(book.id)!;
    for(const value of Object.values(guide.beginner))assert.ok(markdown.includes(value),book.id);
    for(const value of [book.cover_url!,book.star_url!,book.repository_url,book.fork_url,guide.first_result,guide.status,guide.source_commit])assert.ok(markdown.includes(value),`${book.id}/${value}`);
    const html=pageHtml(book.title,markdown,book.markdown_url);
    assert.ok(html.includes(`src="${book.cover_url}"`),book.id);
    assert.ok(html.includes(`href="${book.upstream_url}" target="_blank" rel="noopener noreferrer">到 GitHub 點星星`),book.id);
  }
  assert.equal(covers.size,22);
  const external=communityCatalog.skill_books.find(book=>book.id==='social-post')!;
  assert.notEqual(external.star_url,external.repository_url);
  assert.equal(external.star_url,'https://github.com/Hao0321/claude-skill-social-post');
  for(const book of skillBooksForGuild('guild_marketing'))assert.ok(book.cover_url&&book.star_url&&book.guide?.beginner);
});

test('covers accept catalog or granted-book identities and star links stay on an original GitHub repository',()=>{
  assert.equal(skillBookCoverUrl({id:'social-post'}),'/art/skills/social-post.webp');
  assert.equal(skillBookCoverUrl({book_id:'social-post'}),'/art/skills/social-post.webp');
  assert.equal(skillBookCoverUrl({book_id:'../private'}),null);
  assert.equal(skillBookCoverUrl({cover_url:'https://external.invalid/tracker'}),null);
  const source={repository_url:'https://github.com/FreeTWAI-AI/claude-skill-social-post',upstream_url:'https://github.com/Hao0321/claude-skill-social-post'};
  assert.equal(skillBookStarUrl(source),source.upstream_url);
  for(const upstream_url of ['https://github.com.evil.invalid/owner/repo','https://token@github.com/owner/repo','javascript:alert(1)','https://github.com/owner/repo/issues','https://github.com:8443/owner/repo'])assert.equal(skillBookStarUrl({...source,upstream_url}),null);
});
