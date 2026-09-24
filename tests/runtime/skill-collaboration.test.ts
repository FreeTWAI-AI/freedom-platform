import {test} from 'node:test';
import assert from 'node:assert/strict';
import {communityCatalog} from '../../modules/community/catalog.js';
import {getSkillCollaboration,type SkillEditorial} from '../../modules/community/skill-collaboration.js';
import {developmentMap,skillAgentMarkdown,pageAgentMarkdown} from '../../modules/development/service.js';
import {createDevelopmentRoutes} from '../../apps/platform-api/src/routes/development.js';
import {developmentPages} from '../../modules/development/pages.js';

const origin='https://freetwai.com';
const editorial:SkillEditorial={summary:'維護者的新剪輯摘要',collaboration_intro:'共做字幕同步與分享範例',milestones:[{id:'m-one',title:'可重現範例'}],tasks:[{id:'t-one',title:'補字幕壞例',description:'修改單一 fixture',acceptance:['倒序時間必須拒絕'],issue_url:'https://github.com/FreeTWAI-AI/video-autopilot-kit/issues/3',milestone_id:'m-one',status:'in_progress'}],updated_at:'2026-09-23T12:00:00Z',aggregate_version:2};

test('all books default contributions to their original source and keep workshop task provenance separate',()=>{
 const map=developmentMap();assert.equal(map.skill_books.length,25);
 for(const book of communityCatalog.skill_books){
  const data=getSkillCollaboration(book.id);assert.ok(data,book.id);
  const metadata=map.repositories.find(repo=>repo.repository===new URL(book.repository_url).pathname.slice(1))!;
  assert.equal(data.repository.url,book.repository_url);assert.equal(data.repository.default_branch,metadata.default_branch);
  assert.equal(data.repository.fork_url,book.fork_url);assert.equal(data.repository.upstream_url,book.upstream_url);
  assert.equal(data.contribution.url,book.upstream_url);assert.equal(data.contribution.fork_url,book.upstream_url+'/fork');
  assert.equal(data.contribution.default_branch,metadata.contribution_default_branch);assert.equal(metadata.contribution_target,book.upstream_url);
  assert.ok(data.tasks.length>0);assert.ok(data.tasks.every(task=>task.acceptance.length>0&&task.scope.length>10));
  assert.ok(data.validation_commands.length>0);assert.ok(data.read_first.some(source=>source.label==='AGENTS.md'));
  const agent=skillAgentMarkdown(book.id)!;assert.match(agent,/^---\nname: [a-z0-9-]{1,63}\ndescription: "[^\n]+"\n---\n/);
  assert.ok(agent.includes(data.repository.name+':'+metadata.default_branch));assert.ok(agent.includes('/issues'));
  assert.ok(agent.includes('預設 PR 目標：'+data.contribution.name+':'+data.contribution.default_branch));
  assert.ok(!agent.includes('回送原作者上游需另行協調'));assert.ok(agent.includes('commit 作者'));
  assert.ok(agent.includes('not_run'));assert.equal(data.editorial,null);
  if(book.id!=='video-autopilot')assert.ok(data.tasks.every(task=>task.status==='proposed'&&task.source_url===null));
 }
 assert.equal(getSkillCollaboration('multi-ai-chat')?.repository.default_branch,'master');
 assert.equal(getSkillCollaboration('multi-ai-chat')?.contribution.default_branch,'master');
 assert.equal(getSkillCollaboration('multi-ai-chat')?.contribution.name,'teddashh/multi-ai-chat');
 assert.equal(getSkillCollaboration('career-guide')?.contribution.name,'FreeTWAI-AI/freedom-skill-career-guide');
 assert.equal(getSkillCollaboration('unknown'),null);assert.equal(skillAgentMarkdown('unknown'),null);
 const video=getSkillCollaboration('video-autopilot')!;
 assert.equal(video.tasks.length,5);assert.ok(video.tasks.every(task=>task.status==='github_issue'&&task.source_url?.startsWith(video.repository.url+'/issues/')));
 assert.ok(video.boundaries.some(value=>value.includes('Editkin v4')));
 assert.ok(video.milestones.every(milestone=>milestone.status==='proposed'));
});

test('all pages expose a loadable agent skill and discovery links without granting private access',async()=>{
 const app=createDevelopmentRoutes();const map=developmentMap();assert.equal(map.pages.length,21);
 const index=await(await app.request(origin+'/llms.txt')).text();
 for(const page of developmentPages){
  const item=map.pages.find(item=>item.id===page.id)!;assert.ok(index.includes(item.agent_skill_url));
  const response=await app.request(origin+item.agent_skill_url);assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')??'',/text\/markdown/);
  const markdown=await response.text();assert.equal(markdown,pageAgentMarkdown(page));assert.match(markdown,/^---\nname: freedom-page-/);
  for(const path of page.source_paths)assert.ok(markdown.includes(path));
 }
 for(const book of map.skill_books){
  assert.ok(index.includes(book.agent_skill_url));
  const json=await(await app.request(origin+book.collaboration_url)).json();assert.equal(json.book_id,book.id);
  assert.equal((await app.request(origin+book.agent_skill_url)).status,200);
 }
 for(const path of ['/development/unknown/SKILL.md','/development/skills/unknown/SKILL.md','/api/v1/skills/unknown/collaboration'])assert.equal((await app.request(origin+path)).status,404);
});

test('public share HTML is crawler-readable with canonical metadata, visible cooperation and safe external script',async()=>{
 const app=createDevelopmentRoutes();
 const response=await app.request(origin+'/development/skills/video-autopilot');assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/<link rel="canonical" href="https:\/\/freetwai\.com\/development\/skills\/video-autopilot">/);
 assert.match(html,/<meta property="og:image" content="https:\/\/freetwai\.com\/brand\/skill-illustrations\/video-autopilot.webp">/);
 assert.ok(html.indexOf('id="collaboration-title"')<html.indexOf('<details class="public-skill-details"'));
 assert.ok(html.includes('href="https://github.com/Hao0321/video-autopilot-kit/fork">從原作開始共創'));
 assert.ok(html.includes('預設 PR → Hao0321/video-autopilot-kit:main'));
 assert.ok(!html.includes('Fork 共創版本'));assert.ok(html.includes('/development/skills/video-autopilot/SKILL.md'));
 assert.ok(html.includes('官方公會技能'));assert.ok(!html.includes('工坊週榜 #'));
 assert.match(html,/<script src="\/development-share\.js" defer><\/script>/);assert.doesNotMatch(html,/<script(?! src=)|onclick=|onerror=/);
 const script=await app.request(origin+'/development-share.js');assert.equal(script.status,200);assert.match(script.headers.get('content-type')??'',/javascript/);
});

test('maintainer editorial changes cannot redirect the original fork or take ownership of upstream credit',async()=>{
 const app=createDevelopmentRoutes(undefined,async()=>editorial);
 const response=await app.request(origin+'/api/v1/skills/video-autopilot/collaboration');
 const data=await response.json();
 assert.equal(data.contribution.url,'https://github.com/Hao0321/video-autopilot-kit');
 assert.equal(data.contribution.fork_url,'https://github.com/Hao0321/video-autopilot-kit/fork');
 assert.equal(data.repository.url,'https://github.com/FreeTWAI-AI/video-autopilot-kit');
 assert.equal(data.tasks[0].source_url,editorial.tasks[0].issue_url,'existing workshop Issues stay real workshop evidence');
 const markdown=await(await app.request(origin+'/development/skills/video-autopilot/SKILL.md')).text();
 assert.ok(markdown.includes('預設 PR 目標：Hao0321/video-autopilot-kit:main'));
 assert.ok(markdown.includes('不把工坊新增的規則當成原作者的規則'));
 assert.ok(markdown.includes('工坊整合參考路徑'));
 assert.ok(markdown.includes('由原作維護者決定是否合併'));
});

test('published maintainer edits appear consistently in HTML, Markdown, Agent Skill and JSON without becoming GitHub merge facts',async()=>{
 const app=createDevelopmentRoutes(undefined,async()=>editorial);
 const data=getSkillCollaboration('video-autopilot',editorial)!;
 assert.equal(data.intent.status,'maintainer_published');assert.equal(data.purpose,editorial.summary);
 assert.equal(data.tasks.length,1);assert.equal(data.tasks[0].status,'maintainer_published');assert.equal(data.tasks[0].progress,'in_progress');
 assert.deepEqual(data.milestones[0].task_ids,['t-one']);
 for(const path of ['/development/skills/video-autopilot','/development/skills/video-autopilot.md','/development/skills/video-autopilot/SKILL.md','/api/v1/skills/video-autopilot/collaboration']){
  const response=await app.request(origin+path);assert.equal(response.status,200);const body=await response.text();
  assert.ok(body.includes(editorial.summary),path);assert.ok(body.includes(editorial.collaboration_intro),path);assert.ok(body.includes('補字幕壞例'),path);
  assert.ok(body.includes('維護者'),path);assert.ok(body.includes('Issue／PR'),path);
 }
 const next={...editorial,summary:'剛剛更新的摘要',aggregate_version:3};
 const fresh=createDevelopmentRoutes(undefined,async()=>next);assert.ok((await(await fresh.request(origin+'/development/skills/video-autopilot')).text()).includes(next.summary));
});

test('public HTML escapes authored editorial text and omits unknown or unavailable rank badges',async()=>{
 const evil={...editorial,summary:'<img src=x onerror="boom()">',collaboration_intro:'<script>boom()</script>',tasks:[{...editorial.tasks[0],title:'<iframe src=x>',description:'" onfocus="boom()'}]};
 const app=createDevelopmentRoutes(undefined,async()=>evil,async()=>({book_id:'video-autopilot',published_at:'2026-09-23T00:00:00Z',official_guild_keys:['guild_media_automation'],is_new_today:true,week_rank:2,month_rank:3,week_stars:2,month_stars:3}));
 const html=await(await app.request(origin+'/development/skills/video-autopilot')).text();
 assert.ok(html.includes('&lt;script&gt;boom()&lt;/script&gt;'));assert.ok(html.includes('&lt;iframe'));assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<iframe'));
 assert.ok(html.includes('每日新技能'));assert.ok(html.includes('工坊週榜 #2'));assert.ok(html.includes('工坊月榜 #3'));
});

// Share preview, dice, clipboard and native cancellation behavior are covered in skill-sharing.test.ts.
