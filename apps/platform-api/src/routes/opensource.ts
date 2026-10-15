import { Hono } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { readWithMemberSession } from '../../../../packages/db/member-session.js';
import { moduleCommand,type PlatformEnv } from '../module-context.js';
import { listProjects,projectView,importProject,refreshProject,reviseProject,checkProjectEditing,type RepositoryManager,listCampaigns,createCampaign,reviseCampaign,recordShare } from '../../../../modules/opensource-marketing/service.js';
import type {socialLoader} from './github-social.js';
import { prepareProjectSkillSubmission, withdrawProjectPublication } from '../../../../modules/skill-submissions/service.js';
import { projectSkillBookLinks } from '../../../../modules/skill-submissions/project-books.js';

export function createOpenSourceRoutes(pool:Pool, readToken:()=>string|undefined=()=>undefined,loadSocial?:ReturnType<typeof socialLoader>) {
  const manager:RepositoryManager|undefined=loadSocial?async(q,actor,repository,repositoryId)=>(await loadSocial()).repositoryManager(q,actor,repository,repositoryId):undefined;
  const app=new Hono<PlatformEnv>();
  app.get('/opensource/projects',async c=>{
    const actor=c.get('actor');
    const items=await readWithMemberSession(pool,actor,async q=>{
      const projects=await listProjects(q,actor);
      const books=await projectSkillBookLinks(q,actor,projects);
      return projects.map(project=>({...project,skill_book:books.get(project.project_id)??null}));
    });
    return c.json({items});
  });
  app.get('/opensource/projects/:id',async c=>{
    const actor=c.get('actor'),id=z.uuid().parse(c.req.param('id'));
    const result=await readWithMemberSession(pool,actor,async q=>{
      const project=await projectView(q,actor,id);
      const books=await projectSkillBookLinks(q,actor,[project]);
      return {...project,skill_book:books.get(project.project_id)??null};
    });
    c.header('Cache-Control','no-store');
    return c.json(result);
  });
  app.post('/opensource/projects/:id/skill-submission',async c=>{
    const result=await prepareProjectSkillSubmission(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')));
    if(result.submission)c.header('ETag',`"${result.submission.aggregate_version}"`);
    return c.json(result,result.created?201:200);
  });
  app.post('/opensource/projects/:id/withdraw',async c=>{
    const result=await withdrawProjectPublication(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/opensource/projects',async c=>c.json(await importProject(pool,await moduleCommand(c),{token:readToken()}),201));
  app.post('/opensource/projects/:id/edit-access',async c=>c.json(await checkProjectEditing(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')),manager)));
  app.post('/opensource/projects/:id{[0-9a-f-]+:refresh}',async c=>{
    const result=await refreshProject(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id').split(':')[0]),{token:readToken()},manager);
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/opensource/projects/:id{[0-9a-f-]+:revise}',async c=>{
    const result=await reviseProject(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id').split(':')[0]),manager);
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.get('/marketing/campaigns',async c=>{
    const actor=c.get('actor');
    return c.json(await readWithMemberSession(pool,actor,q=>listCampaigns(q,actor,c.req.query())));
  });
  app.post('/marketing/campaigns',async c=>c.json(await createCampaign(pool,await moduleCommand(c)),201));
  app.post('/marketing/campaigns/:id{[0-9a-f-]+:revise}',async c=>{
    const result=await reviseCampaign(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id').split(':')[0]));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/marketing/campaigns/:id/shares',async c=>{
    const result=await recordShare(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result,201);
  });
  return app;
}
