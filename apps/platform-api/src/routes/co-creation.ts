import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import {createCoCreation,getCoCreation,listCoCreation,listCoCreationGuilds} from '../../../../modules/co-creation/service.js';
import {CollaborationGitHub,projectBrief} from '../../../../modules/co-creation/github.js';
import {githubHistoryLeaderboards,githubHistoryPage,GITHUB_HISTORY_PAGE_CAP,historyRepositories,historyRepositoryViews} from '../../../../modules/community/github-history.js';
export function createCoCreationRoutes(pool:Pool,readToken:()=>string|undefined=()=>undefined,github=new CollaborationGitHub()){
  const app=new Hono<PlatformEnv>();
  app.get('/community/github-history/repositories',async c=>c.json({items:await historyRepositoryViews(pool,c.get('actor'))}));
  app.get('/community/github-history/items',async c=>{
    const query=z.object({repository:z.string(),kind:z.enum(['issue','pr']),page:z.coerce.number().int().min(1).max(GITHUB_HISTORY_PAGE_CAP).default(1)}).parse(c.req.query());
    const repositories=await historyRepositories(pool,c.get('actor'));
    const found=repositories.find(item=>item.name.toLowerCase()===query.repository.toLowerCase());
    if(!found)return c.json({code:'invalid_repository',message:'請選擇清單中的儲存庫。'},422);
    return c.json(await githubHistoryPage(pool,found.name,query.kind,query.page));
  });
  app.get('/community/github-history/leaderboards',async c=>c.json(await githubHistoryLeaderboards(pool,c.get('actor'))));
  app.get('/co-creation/projects',async c=>{
    const [items,guilds]=await Promise.all([listCoCreation(pool,c.get('actor')),listCoCreationGuilds(pool)]);
    return c.json({items,guilds});
  });
  app.post('/co-creation/projects',async c=>c.json(await createCoCreation(pool,await moduleCommand(c)),201));
  app.get('/co-creation/projects/:id/activity',async c=>c.json(await github.read(await getCoCreation(pool,c.get('actor'),c.req.param('id')),readToken())));
  app.get('/co-creation/projects/:id/brief',async c=>c.json(projectBrief(await getCoCreation(pool,c.get('actor'),c.req.param('id')))));
  app.get('/co-creation/projects/:id/issues/:number/brief',async c=>{
    const number=z.coerce.number().int().positive().max(1000000000).parse(c.req.param('number'));
    return c.json(await github.brief(await getCoCreation(pool,c.get('actor'),c.req.param('id')),number,readToken()));
  });return app;
}
