import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { createMemberReport, listMyMemberReports, listAdminMemberReports, transitionMemberReport } from '../../../../modules/community/member-reporting.js';

// Reporting administrators use the ordinary member session and CSRF boundary.
export function createMemberReportingRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.get('/me/reports', async c => c.json(await listMyMemberReports(pool, c.get('actor'))));
  app.post('/me/reports', async c => {
    const input = { ...await moduleCommand(c), operation: 'POST /api/v1/me/reports' };
    const result = await createMemberReport(pool, input);
    c.header('ETag', `"${result.aggregate_version}"`);
    return c.json(result, 201);
  });
  app.get('/admin/reports', async c => c.json(await listAdminMemberReports(pool, c.get('actor'))));
  app.post('/admin/reports/:id/transition', async c => {
    const id = z.uuid().parse(c.req.param('id')).toLowerCase();
    const input = { ...await moduleCommand(c), operation: `POST /api/v1/admin/reports/${id}/transition` };
    const result = await transitionMemberReport(pool, input, id);
    c.header('ETag', `"${result.aggregate_version}"`);
    return c.json(result);
  });
  return app;
}
