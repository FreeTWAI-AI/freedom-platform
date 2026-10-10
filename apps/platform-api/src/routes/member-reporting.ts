import { Hono } from 'hono';
import type { Pool } from 'pg';
import type {ObjectStore} from '../../../../packages/asset-storage/index.js';
import { z } from 'zod';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { createMemberReport, listMyMemberReports, listAdminMemberReports, transitionMemberReport,readAdminMemberReport,readAdminReportImage } from '../../../../modules/community/member-reporting.js';

// Reporting administrators use the ordinary member session and CSRF boundary.
export function createMemberReportingRoutes(pool: Pool,store?:ObjectStore) {
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.get('/me/reports', async c => c.json(await listMyMemberReports(pool, c.get('actor'),c.req.query())));
  app.post('/me/reports', async c => {
    const input = { ...await moduleCommand(c), operation: 'POST /api/v1/me/reports' };
    const result = await createMemberReport(pool, input);
    c.header('ETag', `"${result.aggregate_version}"`);
    return c.json(result, 201);
  });
  app.get('/admin/reports', async c => c.json(await listAdminMemberReports(pool, c.get('actor'),c.req.query())));
  app.get('/admin/reports/:id',async c=>c.json(await readAdminMemberReport(pool,c.get('actor'),c.req.param('id'))));
  app.get('/admin/reports/:id/image',async c=>{
    const bytes=await readAdminReportImage(pool,c.get('actor'),c.req.param('id'),store);
    c.header('Content-Type','image/webp');c.header('X-Content-Type-Options','nosniff');c.header('Vary','Cookie');
    return c.body(new Uint8Array(bytes));
  });
  app.post('/admin/reports/:id/transition', async c => {
    const id = z.uuid().parse(c.req.param('id')).toLowerCase();
    const input = { ...await moduleCommand(c), operation: `POST /api/v1/admin/reports/${id}/transition` };
    const result = await transitionMemberReport(pool, input, id);
    c.header('ETag', `"${result.aggregate_version}"`);
    return c.json(result);
  });
  return app;
}
