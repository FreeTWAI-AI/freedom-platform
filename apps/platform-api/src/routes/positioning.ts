import { Hono } from 'hono';
import type { Pool } from 'pg';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { positioningView,saveProfile,listTracks,listGuilds,changeGuildMembership } from '../../../../modules/positioning/service.js';

import { assessmentDefinition,onboardingView,saveAssessmentAnswers,evaluateSavedAssessment,completeOnboarding,guildDirectory,guildPreferences,setSecondaryGuilds,setPrimaryGuild,listSkillBooks,createGuildApplication,listGuildApplications } from '../../../../modules/positioning/onboarding.js';

export function createPositioningRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.get('/me/positioning',async c=>c.json(await positioningView(pool,c.get('actor'))));
  app.post('/me/positioning',async c=>{
    const profile=await saveProfile(pool,await moduleCommand(c));
    c.header('ETag',`"${profile.aggregate_version}"`);return c.json(profile,201);
  });
  app.get('/career-tracks',async c=>c.json({items:await listTracks(pool)}));
  app.get('/guilds',async c=>c.json({items:await listGuilds(pool,c.get('actor'))}));
  for(const action of ['join','leave'] as const)app.post(`/guilds/:key/${action}`,async c=>{
    const membership=await changeGuildMembership(pool,await moduleCommand(c),c.req.param('key'),action);
    c.header('ETag',`"${membership.aggregate_version}"`);return c.json(membership);
  });
  app.get('/assessment-definition',c=>c.json(assessmentDefinition()));
  app.get('/me/onboarding',async c=>c.json(await onboardingView(pool,c.get('actor'))));
  for(const [action,fn] of [['answers',saveAssessmentAnswers],['evaluate',evaluateSavedAssessment],['complete',completeOnboarding]] as const)app.post(`/me/onboarding/${action}`,async c=>{
    const result=await fn(pool,await moduleCommand(c));
    if(result.draft)c.header('ETag',`"${result.draft.aggregate_version}"`);return c.json(result);
  });
  app.get('/guilds/directory',async c=>c.json({items:await guildDirectory(pool,c.get('actor'))}));
  app.get('/me/guild-preferences',async c=>c.json(await guildPreferences(pool,c.get('actor'))));
  app.post('/me/guild-preferences/secondary',async c=>{
    const result=await setSecondaryGuilds(pool,await moduleCommand(c));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/guilds/:key/primary',async c=>{
    const result=await setPrimaryGuild(pool,await moduleCommand(c),c.req.param('key'));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.get('/me/skill-books',async c=>c.json({items:await listSkillBooks(pool,c.get('actor'))}));
  app.get('/guild-applications',async c=>c.json({items:await listGuildApplications(pool,c.get('actor'))}));
  app.post('/guild-applications',async c=>c.json(await createGuildApplication(pool,await moduleCommand(c)),201));
  return app;
}
