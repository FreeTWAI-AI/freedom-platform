import {Hono} from 'hono';
import {LIVE_SITE_ORIGIN,developmentMap,developmentPage,pageMarkdown,skillMarkdown,llmsIndex,developmentCss,collaborationCss,developmentShareJs,pageHtml,indexHtml,skillAgentMarkdown,pageAgentMarkdown} from '../../../../modules/development/service.js';
import {getSkillCollaboration,type SkillEditorial} from '../../../../modules/community/skill-collaboration.js';
import type {SkillDiscoveryBook} from '../../../../modules/community/discovery.js';
import type {GitHubMetrics} from '../../../../modules/github-social/service.js';
import {getSkillShareContent,skillShareContentVersion} from '../../../../modules/community/skill-share-content.js';
import {githubSocialCss} from '../generated/runtime-text.js';
export function createDevelopmentRoutes(readMetrics?:(id:string)=>Promise<GitHubMetrics>,readEditorial?:(id:string)=>Promise<SkillEditorial|null>,readDiscovery?:(id:string)=>Promise<SkillDiscoveryBook|undefined>,publicOrigin=LIVE_SITE_ORIGIN){
 const app=new Hono();
 app.get('/api/v1/skills/:id/share-content',c=>{
   const content=getSkillShareContent(c.req.param('id'));
   return content?c.json({...content,version:skillShareContentVersion}):c.json({error:'skill_not_found'},404);
 });
 app.get('/api/v1/development-map',c=>c.json(developmentMap()));
 app.get('/.well-known/freedom-development.json',c=>c.json(developmentMap()));
 app.get('/api/v1/skills/:id/collaboration',async c=>{
   const id=c.req.param('id');if(!getSkillCollaboration(id))return c.json({error:'skill_not_found'},404);
   return c.json(getSkillCollaboration(id,await readEditorial?.(id)));
 });
 app.get('/llms.txt',c=>c.text(llmsIndex()));
 app.get('/development.css',c=>{c.header('Content-Type','text/css; charset=utf-8');return c.body(developmentCss+collaborationCss+githubSocialCss);});
 app.get('/development-share.js',c=>{c.header('Content-Type','text/javascript; charset=utf-8');return c.body(developmentShareJs);});
 app.get('/development',c=>c.html(indexHtml()));
 app.get('/development/',c=>c.html(indexHtml()));
 app.get('/development/skills/:id/SKILL.md',async c=>{
   const id=c.req.param('id');if(!getSkillCollaboration(id))return c.text('找不到這本技能書。',404);
   const text=skillAgentMarkdown(id,await readEditorial?.(id),publicOrigin);
   c.header('Content-Type','text/markdown; charset=utf-8');return c.body(text!);
 });
 app.get('/development/:id/SKILL.md',c=>{
   const page=developmentPage(c.req.param('id'));if(!page)return c.text('找不到這個開發指引。',404);
   c.header('Content-Type','text/markdown; charset=utf-8');return c.body(pageAgentMarkdown(page,publicOrigin));
 });
 app.get('/development/skills/:id',async c=>{
   const raw=c.req.param('id'),markdown=raw.endsWith('.md'),id=markdown?raw.slice(0,-3):raw;
   if(!getSkillCollaboration(id))return c.text('找不到這本技能書。',404);
   const editorial=await readEditorial?.(id),text=skillMarkdown(id,editorial)!;
   // Public guidance never fetches GitHub or reads member credentials.
   const metrics=markdown?undefined:await readMetrics?.(id).catch(()=>undefined);
   const discovery=markdown?undefined:await readDiscovery?.(id).catch(()=>undefined);
   return markdown?c.text(text):c.html(pageHtml(text.split('\n')[0].slice(2),text,`/development/skills/${encodeURIComponent(id)}.md`,metrics,editorial,discovery,c.req.query('intro'),publicOrigin));
 });
 app.get('/development/:id',c=>{
   const raw=c.req.param('id'),markdown=raw.endsWith('.md'),id=markdown?raw.slice(0,-3):raw,page=developmentPage(id);
   if(!page)return c.text('找不到這個開發指引。',404);
   const text=pageMarkdown(page);return markdown?c.text(text):c.html(pageHtml(page.title,text,`/development/${id}.md`,undefined,undefined,undefined,undefined,publicOrigin));
 });
 app.all('/development/*',c=>c.text('找不到這個開發指引。',404));
 return app;
}
