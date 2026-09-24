import {Hono,type Context} from 'hono';
import type {Pool} from 'pg';
import {DevelopmentAccess} from '../../../../modules/development-access/service.js';
import {authRateLimit} from '../../../../modules/identity-membership/members.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import type {socialLoader} from './github-social.js';
import {checkAgentSkillHeaders,readAgentSkillSubmissionBody} from './skill-submissions.js';

export const isAgentDevelopmentPath=(method:string,path:string)=>method==='POST'&&path==='/development-agent/v1/proposals';
export function createDevelopmentAccessRoutes(pool:Pool,load:ReturnType<typeof socialLoader>){
  const app=new Hono<PlatformEnv>();
  app.get('/me/development/:kind/:target',async c=>c.json(await new DevelopmentAccess(pool,await load()).status(c.get('actor'),c.req.param('kind'),c.req.param('target'))));
  for(const action of ['consent','activate','keys','revoke','proposals'] as const){
    app.post(`/me/development/:kind/:target/${action}`,async c=>{
      await authRateLimit(pool,'development-member',c.get('actor').user_id,60,3600);
      const service=new DevelopmentAccess(pool,await load()),input=await moduleCommand(c),kind=c.req.param('kind'),target=c.req.param('target');
      return c.json(await (action==='keys'?service.issueKey(input,kind,target):action==='proposals'?service.saveProposal(input,kind,target):service[action](input,kind,target)));
    });
  }
  return app;
}
export function createDevelopmentAgentRoutes(pool:Pool,load:ReturnType<typeof socialLoader>,network:(c:Context)=>string){
  const app=new Hono();
  app.post('/proposals',async c=>{
    requireCondition(!Object.keys(c.req.query()).length,422,'agent_query_unsupported','不接受查詢參數。');
    await authRateLimit(pool,'development-agent-network',network(c),60,3600);
    checkAgentSkillHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'),32768);
    const body=await readAgentSkillSubmissionBody(c.req.raw,32768);
    return c.json(await new DevelopmentAccess(pool,await load()).agent(c.req.header('Authorization'),body,c.req.header('Idempotency-Key')??''));
  });
  return app;
}
