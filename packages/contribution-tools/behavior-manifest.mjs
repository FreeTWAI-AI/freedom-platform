// HOST installation data, never a candidate descriptor/test selector.
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
export const MEMBER_BEHAVIOR = freeze({
  profile: 'platform-member-routes.behavior/v1', suite_id: 'behavior.platform-member-routes',
  fixture_profile: 'platform-member-routes.fixture/v1', fixture_revision: '1',
  origin: 'http://127.0.0.1:4310',
  title: 'HOST_BEHAVIOR_SYNTHETIC_PRIVATE_TITLE', objective: 'HOST_BEHAVIOR_SYNTHETIC_PRIVATE_OBJECTIVE',
  routes: [
    { operation: 'member.avatar.metadata', method: 'GET', path: '/api/v1/me/avatar' },
    { operation: 'member.avatar.replace', method: 'POST', path: '/api/v1/me/avatar' },
    { operation: 'member.avatar.remove', method: 'POST', path: '/api/v1/me/avatar/remove' },
    { operation: 'member.avatar.read', method: 'GET', path: '/api/v1/members/:owner/avatar?v=1' },
    { operation: 'work.private.list', method: 'GET', path: '/api/v1/me/private-work' },
    { operation: 'work.private.read', method: 'GET', path: '/api/v1/me/private-work/:work' },
  ],
  limits: { response_bytes: 262144, total_response_bytes: 2097152, response_header_bytes: 16384, response_header_count: 128,
    request_timeout_ms: 2000, run_timeout_ms: 60000 },
});
const cases = [];
for (const actor of ['anonymous', 'revoked']) for (const route of MEMBER_BEHAVIOR.routes)
  cases.push({ id: `${actor}.${route.operation}`, operation: route.operation, actor, method: route.method, path: route.path, status: 401, shape: 'problem', ...(route.method === 'POST' ? { omit: 'version' } : {}) });
cases.push(
  { id: 'owner.avatar.metadata', operation: 'member.avatar.metadata', actor: 'owner', method: 'GET', path: '/api/v1/me/avatar', status: 200, shape: 'metadata' },
  { id: 'owner.avatar.read', operation: 'member.avatar.read', actor: 'owner', method: 'GET', path: '/api/v1/members/:owner/avatar?v=1', status: 200, shape: 'avatar' },
  { id: 'outsider.avatar.read', operation: 'member.avatar.read', actor: 'outsider', method: 'GET', path: '/api/v1/members/:owner/avatar?v=1', status: 404, shape: 'problem' },
  { id: 'owner.work.list', operation: 'work.private.list', actor: 'owner', method: 'GET', path: '/api/v1/me/private-work', status: 200, shape: 'list' },
  { id: 'outsider.work.list', operation: 'work.private.list', actor: 'outsider', method: 'GET', path: '/api/v1/me/private-work', status: 200, shape: 'empty-list' },
);
for (const actor of ['owner', 'outsider']) for (const method of ['GET', 'HEAD'])
  cases.push({ id: `${actor}.work.${method.toLowerCase()}.conditional`, operation: 'work.private.read', actor, method,
    path: '/api/v1/me/private-work/:work', status: actor === 'owner' ? 200 : 404, shape: method === 'HEAD' ? 'head' : actor === 'owner' ? 'work' : 'problem', conditional: true });
for (const [operation, path] of [['member.avatar.replace', '/api/v1/me/avatar'], ['member.avatar.remove', '/api/v1/me/avatar/remove']])
  for (const [omit, status] of [['csrf', 403], ['version', 428], ['key', 400]])
    cases.push({ id: `${operation}.missing-${omit}`, operation, actor: 'owner', method: 'POST', path, status, shape: 'problem', omit });
export const MEMBER_BEHAVIOR_CASES = freeze(cases);
