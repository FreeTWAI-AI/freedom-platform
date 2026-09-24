import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import type {Actor} from '../../../../modules/identity-membership/service.js';
import {GitHubSocial} from '../../../../modules/github-social/service.js';
import {readSocialConfig} from '../../../../modules/github-social/setup.js';

export type GitHubSocialOptions={config?:{clientId:string;clientSecret:string;tokenKey:string;redirectUri:string;appId?:string;appSlug?:string};tokenKey?:string;fetcher?:typeof fetch};
export function socialLoader(pool:Pool,origin:string,options:GitHubSocialOptions={}){
  return async()=>{
    const key=options.tokenKey??process.env.GITHUB_SOCIAL_TOKEN_KEY;
    let config=options.config;
    if(!config&&key){
      const stored=await readSocialConfig(pool,key);
      if(stored)config={...stored,redirectUri:origin+'/github/callback'};
    }
    return new GitHubSocial(pool,config,options.fetcher??fetch);
  };
}
const bookId=(value:string)=>z.string().regex(/^[a-z0-9-]{1,100}$/).parse(value);
export function createGitHubMetricsRoutes(load:ReturnType<typeof socialLoader>){
  const app=new Hono();
  app.get('/github/books/:id/metrics',async c=>c.json(await (await load()).metrics(bookId(c.req.param('id')))));
  return app;
}
export function createGitHubSocialRoutes(load:ReturnType<typeof socialLoader>){
  const app=new Hono<{Variables:{actor:Actor}}>();
  app.get('/me/github',async c=>c.json(await (await load()).session(c.get('actor'))));
  app.post('/me/github/connect',async c=>{
    const body=z.object({return_to:z.string().max(100).default('#community')}).strict().parse(await c.req.json());
    return c.json(await (await load()).start(c.get('actor'),body.return_to));
  });
  app.post('/me/github/complete',async c=>{
    const body=z.object({state:z.string().min(20).max(200),code:z.string().min(1).max(512)}).strict().parse(await c.req.json());
    return c.json(await (await load()).complete(c.get('actor'),body.state,body.code));
  });
  app.post('/me/github/disconnect',async c=>{
    z.object({}).strict().parse(await c.req.json());
    return c.json(await (await load()).disconnect(c.get('actor')));
  });
  app.get('/me/github/books/:id/star',async c=>c.json(await (await load()).starred(c.get('actor'),bookId(c.req.param('id')))));
  app.post('/me/github/books/:id/star',async c=>{
    const body=z.object({starred:z.boolean(),confirmed:z.literal(true)}).strict().parse(await c.req.json());
    return c.json(await (await load()).star(c.get('actor'),bookId(c.req.param('id')),body.starred));
  });
  return app;
}
