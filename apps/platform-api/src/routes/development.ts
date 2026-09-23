import {Hono} from 'hono';
import {developmentMap,developmentPage,pageMarkdown,skillMarkdown,llmsIndex,developmentCss,pageHtml,indexHtml} from '../../../../modules/development/service.js';
export function createDevelopmentRoutes(){
 const app=new Hono();
 app.get('/api/v1/development-map',c=>c.json(developmentMap()));
 app.get('/.well-known/freedom-development.json',c=>c.json(developmentMap()));
 app.get('/llms.txt',c=>c.text(llmsIndex()));
 app.get('/development.css',c=>{c.header('Content-Type','text/css; charset=utf-8');return c.body(developmentCss);});
 app.get('/development',c=>c.html(indexHtml()));
 app.get('/development/',c=>c.html(indexHtml()));
 app.get('/development/skills/:id',c=>{
   const raw=c.req.param('id'),markdown=raw.endsWith('.md'),id=markdown?raw.slice(0,-3):raw,text=skillMarkdown(id);
   if(!text)return c.text('找不到這本技能書。',404);
   return markdown?c.text(text):c.html(pageHtml(text.split('\n')[0].slice(2),text,`/development/skills/${encodeURIComponent(id)}.md`));
 });
 app.get('/development/:id',c=>{
   const raw=c.req.param('id'),markdown=raw.endsWith('.md'),id=markdown?raw.slice(0,-3):raw,page=developmentPage(id);
   if(!page)return c.text('找不到這個開發指引。',404);
   const text=pageMarkdown(page);return markdown?c.text(text):c.html(pageHtml(page.title,text,`/development/${id}.md`));
 });
 app.all('/development/*',c=>c.text('找不到這個開發指引。',404));
 return app;
}
