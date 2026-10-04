import type {PlatformRuntime} from '../runtime.js';
import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { authRateLimit } from '../../../../modules/identity-membership/members.js';
import { normalizeSubmission } from '../../../../modules/skill-submissions/payload.js';
import {
  agentCreateSubmission, agentUploadSubmission, createKey, findUploadGrant, findUploadKey, issueSubmission, listKeys, listSubmissions,
  createManualSubmission, reviseManualSubmission, publishSubmission, readOwnIllustration, readSubmission, revokeKey, revokeSubmission, rotateGrant,
  upgradeSubmission,
} from '../../../../modules/skill-submissions/service.js';

export const AGENT_CREATE_MAX_BYTES = 8192;
export const AGENT_UPLOAD_MAX_BYTES = 800 * 1024;
const AGENT_BASE = '/agent-api/v1/skill-submissions';
const UUID_SEGMENT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Exact agent POST routes. The app-level JSON middleware must skip these so the
// bounded stream reader below sees the untouched body.
export function isAgentSkillUploadPath(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  if (path === AGENT_BASE) return true;
  if (!path.startsWith(AGENT_BASE + '/')) return false;
  return UUID_SEGMENT.test(path.slice(AGENT_BASE.length + 1));
}
export function agentSkillBodyLimit(path: string): number {
  return path === AGENT_BASE ? AGENT_CREATE_MAX_BYTES : AGENT_UPLOAD_MAX_BYTES;
}
function agentBodyTooLarge(maxBytes: number) {
  const kb = Math.max(1, Math.round(maxBytes / 1024));
  return `內容超過 ${kb} KB 上限。請縮小 JSON 後再送；不要分段，也不要附上超過上限的示意圖。`;
}
const AGENT_JSON_TYPE = '請用 Content-Type: application/json 傳送一個 JSON 物件。不要用 text/plain、表單或 Markdown。';
const AGENT_INVALID_JSON = 'JSON 格式不正確。請只傳送一個 JSON 物件，不要用 Markdown 程式碼區塊包住，也不要在前後加說明。';
export function checkAgentSkillHeaders(contentType: string | undefined, contentLength: string | undefined, maxBytes: number) {
  requireCondition(contentType?.split(';')[0].trim().toLowerCase() === 'application/json', 415, 'json_required', AGENT_JSON_TYPE);
  // Content-Length is only an early hint; the stream reader enforces the real bound.
  if (contentLength !== undefined) requireCondition(/^\d+$/.test(contentLength) && Number(contentLength) <= maxBytes, 413, 'body_too_large', agentBodyTooLarge(maxBytes));
}
// Reads at most maxBytes from the raw request stream and parses strict UTF-8 JSON.
export async function readAgentSkillSubmissionBody(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  requireCondition(reader, 400, 'invalid_json', AGENT_INVALID_JSON);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Problem(413, 'body_too_large', agentBodyTooLarge(maxBytes));
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)); }
  catch { throw new Problem(400, 'invalid_json', AGENT_INVALID_JSON); }
  try { return JSON.parse(text); } catch { throw new Problem(400, 'invalid_json', AGENT_INVALID_JSON); }
}
function agentFields(error: z.ZodError) {
  return error.issues.slice(0, 8).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

const withEtag = (c: Context, value: { aggregate_version?: string } | undefined) => {
  if (value?.aggregate_version) c.header('ETag', `"${value.aggregate_version}"`);
};

// Mount under /api/v1 after the browser session, Origin/CSRF and onboarding middleware.
export function createSkillSubmissionRoutes(pool: Pool, origin: string, readToken: () => string | undefined = () => undefined,runtime?:Pick<PlatformRuntime,'skillImageAssets'|'skillImageAssetStore'>) {
  const app = new Hono<PlatformEnv>();
  app.get('/me/skill-submissions', async c => c.json({ items: await listSubmissions(pool, c.get('actor')) }));
  app.post('/me/skill-submissions/manual', async c => {
    const result = await createManualSubmission(pool, await moduleCommand(c));
    withEtag(c, result);
    return c.json(result, 201);
  });
  app.post('/me/skill-submissions', async c => {
    const result = await issueSubmission(pool, await moduleCommand(c), origin);
    withEtag(c, result.submission);
    return c.json(result, 201);
  });
  app.get('/me/skill-submissions/:id', async c => {
    const result = await readSubmission(pool, c.get('actor'), c.req.param('id'));
    withEtag(c, result);
    return c.json(result);
  });
  app.post('/me/skill-submissions/:id/manual', async c => {
    const result = await reviseManualSubmission(pool, await moduleCommand(c), c.req.param('id'));
    withEtag(c, result);
    return c.json(result);
  });
  app.get('/me/skill-submissions/:id/illustration', async c => {
    const bytes = await readOwnIllustration(pool, c.get('actor'), c.req.param('id'),runtime?.skillImageAssetStore);
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Cookie');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Content-Length', String(bytes.length));
    return c.body(new Uint8Array(bytes));
  });
  app.post('/me/skill-submissions/:id/grant', async c => {
    const result = await rotateGrant(pool, await moduleCommand(c), c.req.param('id'), origin);
    withEtag(c, result.submission);
    return c.json(result);
  });
  app.post('/me/skill-submissions/:id/revoke', async c => {
    const result = await revokeSubmission(pool, await moduleCommand(c), c.req.param('id'));
    withEtag(c, result);
    return c.json(result);
  });
  app.post('/me/skill-submissions/:id/publish', async c => {
    const result = await publishSubmission(pool, await moduleCommand(c), c.req.param('id'), { token: readToken() });
    withEtag(c, result);
    return c.json(result);
  });
  app.post('/me/skill-submissions/:id/upgrade', async c => {
    const result = await upgradeSubmission(pool, await moduleCommand(c), c.req.param('id'));
    withEtag(c, result.submission);
    return c.json(result.submission, result.created ? 201 : 200);
  });
  app.get('/me/skill-upload-keys', async c => c.json({ items: await listKeys(pool, c.get('actor')) }));
  app.post('/me/skill-upload-keys', async c => c.json(await createKey(pool, await moduleCommand(c)), 201));
  app.post('/me/skill-upload-keys/:id/revoke', async c => c.json(await revokeKey(pool, await moduleCommand(c), c.req.param('id'))));
  return app;
}

// Mount at /agent-api/v1 outside cookie/CSRF middleware. Cookies are never read:
// only a Bearer upload key (create) or a one-time grant (upload) authenticates.
export function createAgentSkillSubmissionRoutes(pool: Pool, origin: string, network: (c: Context) => string = () => 'shared-server',runtime?:Pick<PlatformRuntime,'skillImageAssets'>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    requireCondition(c.req.method === 'POST', 405, 'agent_method_not_allowed', 'Agent 只能建立與上傳私人技能草稿；查看、公開與撤回請到自由工坊網站。');
    requireCondition(Object.keys(c.req.query()).length === 0, 422, 'agent_query_unsupported', '這個端點不接受查詢參數。');
    // Throttle by network before any credential lookup, body read or decoding.
    await authRateLimit(pool, 'skill-agent-network', network(c), 120, 3600);
    await next();
  });
  app.post('/skill-submissions', async c => {
    checkAgentSkillHeaders(c.req.header('Content-Type'), c.req.header('Content-Length'), AGENT_CREATE_MAX_BYTES);
    const key = await findUploadKey(pool, c.req.header('Authorization'));
    await authRateLimit(pool, 'skill-agent-owner', key.user_id, 60, 3600);
    try { z.object({}).strict().parse(await readAgentSkillSubmissionBody(c.req.raw, AGENT_CREATE_MAX_BYTES)); }
    catch (error) {
      if (error instanceof z.ZodError) throw new Problem(422, 'validation_failed', `建立草稿只接受空的 JSON 物件 {}。請修正後用同一個 Idempotency-Key 再試。${agentFields(error)}`);
      throw error;
    }
    return c.json(await agentCreateSubmission(pool, key, c.req.header('Idempotency-Key'), origin), 201);
  });
  app.post('/skill-submissions/:id', async c => {
    checkAgentSkillHeaders(c.req.header('Content-Type'), c.req.header('Content-Length'), AGENT_UPLOAD_MAX_BYTES);
    const grant = await findUploadGrant(pool, c.req.header('Authorization'), c.req.param('id'));
    await authRateLimit(pool, 'skill-agent-owner', grant.user_id, 60, 3600);
    const raw = await readAgentSkillSubmissionBody(c.req.raw, AGENT_UPLOAD_MAX_BYTES);
    // Validation and image re-encoding run outside the transaction; the grant,
    // key and member are rechecked under lock before anything is stored.
    let normalized;
    try { normalized = await normalizeSubmission(raw); }
    catch (error) {
      if (error instanceof z.ZodError) throw new Problem(422, 'validation_failed', `請修正 JSON 後，用同一個授權再上傳一次（授權尚未被消耗）。${agentFields(error)}`);
      throw error;
    }
    return c.json(await agentUploadSubmission(pool, grant, normalized, origin,runtime?.skillImageAssets));
  });
  app.all('*', c => c.json({ type: 'about:blank', title: 'Not found', status: 404, code: 'agent_route_not_found', detail: 'Agent 只能建立與上傳私人技能草稿。' }, 404));
  return app;
}
