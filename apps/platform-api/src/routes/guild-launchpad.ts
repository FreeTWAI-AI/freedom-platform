import {Hono} from 'hono';
import type {Pool} from 'pg';
import {Problem} from '../../../../packages/shared/problem.js';
import {ConfigValidationError} from '../../../../contracts/guild-launchpad/v1/config.js';
import {moduleCommand, type PlatformEnv} from '../module-context.js';
import {createDraft, grantDelegation, previewLaunchpad, publishLaunchpad, revertLaunchpad, revokeDelegation} from '../../../../modules/guild-workspace/launchpad-config.js';
import {leaderLaunchpadConfig, memberLaunchpad, publicLaunchpad} from '../../../../modules/guild-workspace/launchpad-view.js';

const NOT_FOUND = {type: 'about:blank', title: 'Not found', status: 404, code: 'not_found', detail: '此版本尚未提供這個 API。'};

function validation(error: ConfigValidationError) {
  return {type: 'about:blank', title: 'Validation failed', status: 422, code: 'validation_failed', detail: '內容不符合啟動台配置規則。', errors: error.errors};
}
async function readCommand(c: Parameters<typeof moduleCommand>[0]) {
  try { return await moduleCommand(c); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Problem(400, 'invalid_json', '請提供有效的 JSON。');
    throw error;
  }
}
function privateHeaders(c: {header: (name: string, value: string) => void}) {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex');
}

/** Answers the new paths with the shared not-found problem when the feature flag is off. */
export function createGuildLaunchpadUnavailableRoutes() {
  const app = new Hono();
  const missing = (c: {json: (body: unknown, status: 404) => Response}) => c.json(NOT_FOUND, 404);
  app.all('/api/v1/public/guilds/:guild_key/launchpad', missing);
  app.all('/api/v1/guilds/:guild_key/launchpad', missing);
  app.all('/api/v1/guilds/:guild_key/launchpad-config', missing);
  app.all('/api/v1/guilds/:guild_key/launchpad-config/*', missing);
  app.all('/api/v1/guilds/:guild_key/launchpad-delegations', missing);
  app.all('/api/v1/guilds/:guild_key/launchpad-delegations/*', missing);
  return app;
}

export function createPublicGuildLaunchpadRoutes(pool: Pool) {
  const app = new Hono();
  app.get('/api/v1/public/guilds/:guild_key/launchpad', async c => {
    try {
      c.header('Cache-Control', 'public, max-age=60');
      return c.json(await publicLaunchpad(pool, c.req.param('guild_key')));
    } catch (error) {
      if (error instanceof ConfigValidationError) return c.json(validation(error), 422);
      throw error;
    }
  });
  return app;
}

export function createGuildLaunchpadRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.get('/guilds/:guild_key/launchpad', async c => {
    privateHeaders(c);
    try { return c.json(await memberLaunchpad(pool, c.get('actor'), c.req.param('guild_key'))); }
    catch (error) { if (error instanceof ConfigValidationError) return c.json(validation(error), 422); throw error; }
  });
  app.get('/guilds/:guild_key/launchpad-config', async c => {
    privateHeaders(c);
    const revision = c.req.query('revision');
    try { return c.json(await leaderLaunchpadConfig(pool, c.get('actor'), c.req.param('guild_key'), revision === undefined ? undefined : revision)); }
    catch (error) { if (error instanceof ConfigValidationError) return c.json(validation(error), 422); throw error; }
  });
  app.post('/guilds/:guild_key/launchpad-config/drafts', async c => {
    privateHeaders(c);
    try { return c.json(await createDraft(pool, await readCommand(c), c.req.param('guild_key')), 201); }
    catch (error) { if (error instanceof ConfigValidationError) return c.json(validation(error), 422); throw error; }
  });
  app.post('/guilds/:guild_key/launchpad-config/preview', async c => {
    privateHeaders(c);
    try { return c.json(await previewLaunchpad(pool, c.get('actor'), c.req.param('guild_key'), await c.req.json())); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Problem(400, 'invalid_json', '請提供有效的 JSON。');
      if (error instanceof ConfigValidationError) return c.json(validation(error), 422);
      throw error;
    }
  });
  app.post('/guilds/:guild_key/launchpad-config/:config_id/publish', async c => {
    privateHeaders(c);
    try { return c.json(await publishLaunchpad(pool, await readCommand(c), c.req.param('guild_key'), c.req.param('config_id'))); }
    catch (error) { if (error instanceof ConfigValidationError) return c.json(validation(error), 422); throw error; }
  });
  app.post('/guilds/:guild_key/launchpad-config/revert', async c => {
    privateHeaders(c);
    try { return c.json(await revertLaunchpad(pool, await readCommand(c), c.req.param('guild_key'))); }
    catch (error) { if (error instanceof ConfigValidationError) return c.json(validation(error), 422); throw error; }
  });
  app.post('/guilds/:guild_key/launchpad-delegations', async c => {
    privateHeaders(c);
    try { return c.json(await grantDelegation(pool, await readCommand(c), c.req.param('guild_key')), 201); }
    catch (error) { if (error instanceof ConfigValidationError) return c.json(validation(error), 422); throw error; }
  });
  app.post('/guilds/:guild_key/launchpad-delegations/:delegation_id/revoke', async c => {
    privateHeaders(c);
    try { return c.json(await revokeDelegation(pool, await readCommand(c), c.req.param('guild_key'), c.req.param('delegation_id'))); }
    catch (error) { if (error instanceof ConfigValidationError) return c.json(validation(error), 422); throw error; }
  });
  return app;
}
