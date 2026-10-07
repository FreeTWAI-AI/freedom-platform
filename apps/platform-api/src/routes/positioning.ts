import { Hono } from 'hono';
import type { Pool } from 'pg';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { positioningView,saveProfile,listTracks,listGuilds,changeGuildMembership,leaveGuildV2 } from '../../../../modules/positioning/service.js';
import {quickStartOnboarding} from '../../../../modules/positioning/onboarding.js';
import { communitySwitched, getPreferenceView, setCategoryPreference } from '../../../../modules/positioning/guild-categories.js';

import { assessmentDefinition,onboardingView,saveAssessmentAnswers,evaluateSavedAssessment,completeOnboarding,guildDirectory,guildPreferences,setSecondaryGuilds,setPrimaryGuild,listSkillBooks,createGuildApplication,listGuildApplications,listGuildAnswers,saveGuildAnswers } from '../../../../modules/positioning/onboarding.js';

export function createPositioningRoutes(pool:Pool,options:{guildLaunchpadEnabled?:boolean}={}) {
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
  app.post('/me/onboarding/quick-start',async c=>c.json(await quickStartOnboarding(pool,await moduleCommand(c))));
  app.get('/me/guild-answers',async c=>c.json(await listGuildAnswers(pool,c.get('actor'))));
  app.post('/me/guild-answers/:guild_key',async c=>{
    const item=await saveGuildAnswers(pool,await moduleCommand(c),c.req.param('guild_key'));
    c.header('ETag',`"${item.aggregate_version}"`);return c.json(item);
  });
  for(const [action,fn] of [['answers',saveAssessmentAnswers],['evaluate',evaluateSavedAssessment],['complete',completeOnboarding]] as const)app.post(`/me/onboarding/${action}`,async c=>{
    const result=await fn(pool,await moduleCommand(c));
    if(result.draft)c.header('ETag',`"${result.draft.aggregate_version}"`);return c.json(result);
  });
  app.get('/guilds/directory',async c=>c.json({items:await guildDirectory(pool,c.get('actor'))}));
  app.get('/me/guild-preferences',async c=>{
    const prefs=await guildPreferences(pool,c.get('actor'));
    if(options.guildLaunchpadEnabled&&await communitySwitched(pool,c.get('actor').community_id))return c.json({...prefs,compatibility:'legacy_projection' as const});
    return c.json(prefs);
  });
  if(options.guildLaunchpadEnabled){
    app.get('/me/guild-preferences/v2',async c=>{
      const view=await getPreferenceView(pool,c.get('actor'));
      c.header('ETag',`"${view.aggregate_version}"`);c.header('Cache-Control','private, no-store');return c.json(view);
    });
    app.post('/me/guild-preferences/v2/set',async c=>{
      const view=await setCategoryPreference(pool,await moduleCommand(c));
      c.header('ETag',`"${view.aggregate_version}"`);c.header('Cache-Control','private, no-store');return c.json(view);
    });
    app.post('/guilds/:key/leave-v2',async c=>{
      const result=await leaveGuildV2(pool,await moduleCommand(c),c.req.param('key'),c.req.header('X-Preference-Version'));
      c.header('ETag',`"${result.membership.aggregate_version}"`);c.header('Cache-Control','private, no-store');return c.json(result);
    });
  }
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
