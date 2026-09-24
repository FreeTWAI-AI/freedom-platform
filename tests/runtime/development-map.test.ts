import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import type {Pool} from 'pg';
import {createApp} from '../../apps/platform-api/src/app.js';
import {developmentPages} from '../../modules/development/pages.js';
import {developmentMap,markdownBody} from '../../modules/development/service.js';

const origin='http://127.0.0.1:4310';
// Guidance may enrich a skill page from the public repository cache only.
const publicEditorial='SELECT summary,collaboration_intro,milestones,tasks,updated_at,aggregate_version FROM skill_book_editorial WHERE book_id=$1';
const publicDiscovery=new Set(['SELECT book_id,published_at FROM skill_publications WHERE published_at<=$1','SELECT book_id,summary FROM skill_book_editorial',`SELECT repository_key,count(*) FILTER(WHERE first_confirmed_at>$1 AND first_confirmed_at<=$3)::int AS week_stars, count(*) FILTER(WHERE first_confirmed_at>$2 AND first_confirmed_at<=$3)::int AS month_stars FROM skill_star_support WHERE active AND first_confirmed_at>$2 AND first_confirmed_at<=$3 GROUP BY repository_key`]);
const publiclyReadable=(sql:string)=>sql===publicEditorial||publicDiscovery.has(sql.replace(/\s+/g,' ').trim());
let privateQueries=0;
const pool={query:(sql:string)=>{
 if(publiclyReadable(sql)||sql==='SELECT snapshot,checked_at,retry_after,last_error FROM github_repository_metrics WHERE repository_key=$1')return Promise.resolve({rows:[]});
 privateQueries++;throw new Error('public guidance accessed private database');
}} as unknown as Pool;
const app=createApp(pool,origin);

test('every workspace page and entry flow maps to existing source, tests and an actual managed repository',()=>{
 const map=developmentMap(),repos=new Set(map.repositories.map(repo=>repo.repository));
 assert.equal(repos.size,43);assert.equal(map.skill_books.length,37);
 const types=readFileSync('apps/portal-web/src/types.ts','utf8');
 const tabs=[...types.match(/export type TabId = ([^\n]+)/)![1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
 for(const id of [...tabs,'registration','onboarding','admin','skillbooks'])assert.ok(developmentPages.some(page=>page.id===id),id);
 for(const page of map.pages){
  assert.ok(repos.has(page.repository));
  for(const repo of page.related_repositories)assert.ok(repos.has(repo),repo);
  for(const path of page.source_paths)assert.ok(existsSync(path),path);
  for(const command of page.checks)for(const match of command.matchAll(/tests\/[\w/.-]+/g))assert.ok(existsSync(match[0]),match[0]);
 }
 for(const book of map.skill_books){
  assert.ok(book.guide,book.id);assert.ok(repos.has(new URL(book.repository_url).pathname.slice(1)));
 }
});

test('unauthenticated crawlers get useful HTML, Markdown and JSON without JavaScript or member data',async()=>{
 const index=await app.request(origin+'/development');assert.equal(index.status,200);
 assert.match(index.headers.get('content-type')??'',/text\/html/);
 const html=await index.text();assert.match(html,/href="\/development\/onboarding"/);assert.match(html,/href="\/development\/skills\/security-scanner"/);
 const mapResponse=await app.request(origin+'/api/v1/development-map');assert.equal(mapResponse.status,200);
 const map:any=await mapResponse.json();assert.equal(map.format,'freedom.development-map/v1');
 assert.deepEqual(await (await app.request(origin+'/.well-known/freedom-development.json')).json(),map);
 for(const page of map.pages){
  const response=await app.request(origin+page.guide_url);assert.equal(response.status,200,page.id);
  const body=await response.text();assert.match(body,/href="https:\/\/github.com\/FreeTWAI-AI\/freedom-platform\/fork"/);
  assert.match(body,/AGENTS\.md/);assert.equal(body.includes('<script'),false);
  for(const repo of page.related_repositories)assert.ok(body.includes(`href="https://github.com/${repo}"`),repo);
  const markdown=await app.request(origin+page.markdown_url);assert.equal(markdown.status,200);assert.match(await markdown.text(),/^# /);
 }
 for(const book of map.skill_books){
  const response=await app.request(origin+book.guide_url);assert.equal(response.status,200,book.id);
  const body=await response.text();assert.ok(body.includes(book.guide.first_result));assert.ok(body.includes(book.fork_url));
  assert.match(await (await app.request(origin+book.markdown_url)).text(),/## 開始前準備/);
 }
 const llms=await (await app.request(origin+'/llms.txt')).text();assert.match(llms,/\/development\/admin\.md/);
 assert.doesNotMatch(JSON.stringify(map),/@|user_id|csrf_token|access_token|session_id|"\/home\/|"\/tmp\//);
 assert.equal((await app.request(origin+'/api/v1/me/account')).status,401);
 assert.equal((await app.request(origin+'/api/v1/dashboard')).status,401);
 assert.equal((await app.request(origin+'/admin/api/bootstrap')).status,503); // no Access configuration in local tests
 assert.equal(privateQueries,0);
});

test('public skill guidance survives a repository cache outage without substituting zero counts',async()=>{
 const offline=createApp({query:(sql:string)=>publiclyReadable(sql)?Promise.resolve({rows:[]}):Promise.reject(Error('cache unavailable'))} as unknown as Pool,origin);
 const response=await offline.request(origin+'/development/skills/security-scanner');assert.equal(response.status,200);
 const html=await response.text();assert.ok(html.includes('Stars —'));assert.ok(html.includes('尚未取得 GitHub 數據'));assert.ok(html.includes('Fork 原作'));
});

test('unknown guide paths do not become an SPA fallback and authored text cannot inject executable HTML',async()=>{
 for(const path of ['/development/unknown','/development/skills/unknown.md','/development/skills/unknown/other'])
  assert.equal((await app.request(origin+path)).status,404,path);
 const body=markdownBody('## <img src=x onerror=alert(1)>\nhttps://example.invalid/"onclick="alert(1)\n```sh\n<script>boom</script>\n```');
 assert.equal(body.includes('<img'),false);assert.equal(body.includes('<script>'),false);
 assert.equal(body.includes('href="javascript:'),false);assert.match(body,/&lt;script&gt;/);
});
