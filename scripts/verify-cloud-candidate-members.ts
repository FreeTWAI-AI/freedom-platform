// Synthetic-member phases for the cloud candidate verifier.
// Registration, squad/direct messages and the mobile inbox UI provision their
// own accounts over HTTP. Reports keep booleans, states, counts, versions,
// durations, check ids and ErrorClass[:SYSCODE] only. Labels may be recorded
// for root cleanup; emails, passwords, ids, cookies, CSRF and message bodies
// are added to the run's secret list and must not be copied into the report.
import { randomBytes, randomUUID } from 'node:crypto';

const SESSION_PATH = '/api/v1/session';
const BUILTIN_GUILD = /^guild_[a-z_]+$/;
/** Left, unknown or inactive channels all answer with this code (HTTP 404). */
const CHANNEL_NOT_AVAILABLE = 'channel_not_available';

export type MemberReply = {
  status: number;
  headers: { get(name: string): string | null };
  json(): any;
  setCookies(): Array<{ name: string; value: string; secure: boolean; httpOnly: boolean; sameSite: string | null; path: string | null; domain: string | null }>;
};
export type MemberRequest = {
  json?: unknown;
  origin?: 'same' | 'none' | string;
  csrf?: string | null;
  ifMatch?: string | number;
  idempotency?: boolean | string;
  session?: boolean;
};
export interface MemberClient {
  csrf: string | null;
  hasSession(): boolean;
  request(method: string, path: string, options?: MemberRequest): Promise<MemberReply>;
  withoutSession(): MemberClient;
  withSameSession(): MemberClient;
}
export type MemberCleanupState = 'restored' | 'cleanup_required' | 'residual_expected' | 'restore_failed';
export type MemberCtx = {
  check(id: string, condition: boolean, note?: string): void;
  metric(key: string, value: unknown): void;
  skip(reason: string): never;
  cleanup(item: string, state: MemberCleanupState): void;
};
export type SecretBag = { add(value: unknown): void };
export type CookieChecks = { present: boolean; secure: boolean; http_only: boolean; same_site_strict: boolean; path_root: boolean; host_only: boolean };
export type ProvisionedMember = { label: string; email: string; password: string; nickname: string; userId: string; guildKey: string };
export type MemberRunState = { primary: ProvisionedMember | null; peer: ProvisionedMember | null; lastDirectBody: string | null };
export type MemberPhaseDeps = {
  ctx: MemberCtx;
  openClient(): MemberClient;
  target: { name: string; origin: string };
  secrets: SecretBag;
  state: MemberRunState;
  developmentGuilds: readonly string[];
  cookieChecks(cookie: any, target: { origin: string }): CookieChecks;
};

/** `next` restores real community history. Guild channel reads and writes stay off that target. */
export function guildChannelsRealHistoryGuarded(target: { name: string }) {
  return target.name === 'next';
}

type Identity = { label: string; email: string; password: string; nickname: string };

function identity(): Identity {
  const label = `cand-reg-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('base64url');
  return { label, email: `${label}@example.invalid`, password, nickname: label };
}
function sentence(prefix: string) {
  return `${prefix} ${randomBytes(4).toString('hex')}`;
}
const noStore = (reply: MemberReply) => /(^|,)\s*no-store\s*(,|$)/i.test(reply.headers.get('cache-control') ?? '');
/** JSONB does not preserve object key order; equality is on the stored values. */
function sameJson(left: unknown, right: unknown) {
  const stable = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(stable);
    if (node && typeof node === 'object') return Object.fromEntries(Object.keys(node).sort().map(key => [key, stable((node as Record<string, unknown>)[key])]));
    return node;
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}
function codeOf(value: unknown) {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unrecognized';
}
function problem(reply: MemberReply) {
  return `status ${reply.status} ${codeOf(reply.json()?.code)}`;
}
/** Records uuids, addresses, message bodies and CSRF values. Labels are not secrets. */
function seal(secrets: SecretBag, value: unknown): void {
  const walk = (node: unknown, key?: string) => {
    if (typeof node === 'string') {
      if (key === 'body' || key === 'csrf_token' || key === 'password' || key === 'email' || node.includes('@')) secrets.add(node);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node)) secrets.add(node);
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node && typeof node === 'object') for (const [child, item] of Object.entries(node)) walk(item, child);
  };
  walk(value);
}
function payload(secrets: SecretBag, reply: MemberReply): any {
  const body = reply.json();
  seal(secrets, body);
  return body;
}
async function revokeSession(client: MemberClient): Promise<'restored' | 'restore_failed'> {
  try {
    if (!client.hasSession()) return 'restored';
    const reply = await client.request('POST', '/api/v1/auth/logout', { json: {} });
    return reply.status === 200 && !client.hasSession() ? 'restored' : 'restore_failed';
  } catch { return 'restore_failed'; }
}
function rememberSession(secrets: SecretBag, client: MemberClient, reply: MemberReply) {
  const body = payload(secrets, reply);
  secrets.add(body?.user?.email);
  secrets.add(body?.csrf_token);
  if (typeof body?.csrf_token === 'string') client.csrf = body.csrf_token;
  return body;
}
function builtinGuild(key: unknown, developmentGuilds: readonly string[], skip: readonly string[] = []): key is string {
  return typeof key === 'string' && BUILTIN_GUILD.test(key) && !key.startsWith('guild_custom_') && !developmentGuilds.includes(key) && !skip.includes(key);
}
function firstGuild(items: unknown, developmentGuilds: readonly string[], skip: readonly string[] = []) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const key = item?.guild_key;
    if (builtinGuild(key, developmentGuilds, skip)) return key;
  }
  return null;
}
function answersFrom(definition: any) {
  const questions = definition?.questions;
  if (!Array.isArray(questions) || !questions.length) return null;
  if (typeof definition.assessment_version !== 'string' || typeof definition.assessment_sha256 !== 'string') return null;
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const option = question?.options?.[0]?.id;
    if (typeof question?.id !== 'string' || typeof option !== 'string') return null;
    answers[question.id] = option;
  }
  return {
    assessment_version: definition.assessment_version, assessment_sha256: definition.assessment_sha256, answers,
    occupation: '合成驗收', founding_interest: false, capabilities: [] as string[], equipment: [] as string[],
  };
}

/** Happy-path positioning and primary guild. `guildKey` null picks the first eligible built-in guild. */
async function establishMember(deps: MemberPhaseDeps, client: MemberClient, guildKey: string | null, ids: { definition: string; draft: string; positioning: string; guild: string; primary: string }) {
  const { ctx, secrets, developmentGuilds } = deps;
  const definition = await client.request('GET', '/api/v1/assessment-definition');
  const answers = definition.status === 200 ? answersFrom(payload(secrets, definition)) : null;
  ctx.check(ids.definition, definition.status === 200 && !!answers, problem(definition));
  const saved = await client.request('POST', '/api/v1/me/onboarding/answers', { json: answers, idempotency: true });
  const draftVersion = payload(secrets, saved)?.draft?.aggregate_version;
  ctx.check(ids.draft, saved.status === 200 && (typeof draftVersion === 'number' || typeof draftVersion === 'string'), problem(saved));
  const evaluated = await client.request('POST', '/api/v1/me/onboarding/evaluate', { json: {}, ifMatch: draftVersion, idempotency: true });
  const evaluatedBody = payload(secrets, evaluated);
  const positioned = evaluated.status === 200 && evaluatedBody?.state === 'evaluated' && evaluatedBody?.completed === false && Array.isArray(evaluatedBody?.result?.recommendations) && evaluatedBody.result.recommendations.length > 0;
  ctx.check(ids.positioning, positioned, problem(evaluated));
  const version = evaluatedBody?.draft?.aggregate_version;
  let key = guildKey;
  if (!key) {
    const directory = await client.request('GET', '/api/v1/guilds/directory');
    seal(secrets, directory.status === 200 ? directory.json() : undefined);
    key = directory.status === 200 ? firstGuild(directory.json()?.items, developmentGuilds) : null;
    ctx.check(ids.guild, directory.status === 200 && !!key, problem(directory));
  }
  const completeBody = { guild_keys: [key], primary_guild_key: key, confirmed: true };
  const completeKey = randomUUID();
  const completed = await client.request('POST', '/api/v1/me/onboarding/complete', { json: completeBody, ifMatch: version, idempotency: completeKey });
  const completedBody = payload(secrets, completed);
  const preferences = await client.request('GET', '/api/v1/me/guild-preferences');
  const preferenceBody = payload(secrets, preferences);
  const primarySet = completed.status === 200 && completedBody?.completed === true && completedBody?.state === 'completed' && completedBody?.primary_guild_key === key
    && preferences.status === 200 && preferenceBody?.primary_guild_key === key;
  ctx.check(ids.primary, primarySet, problem(completed.status === 200 ? preferences : completed));
  return { guildKey: key!, completeBody, completeKey, completeVersion: version, completedBody, preferenceVersion: preferenceBody?.aggregate_version };
}

const PRIMARY_STEPS = { definition: 'assessment_definition', draft: 'positioning_draft_saved', positioning: 'positioning_completed', guild: 'eligible_builtin_guild', primary: 'primary_guild_set' };
const PEER_STEPS = { definition: 'peer_assessment_definition', draft: 'peer_positioning_draft_saved', positioning: 'peer_positioning_completed', guild: 'peer_guild_known', primary: 'peer_primary_guild_set' };

export async function runRegistrationPhase(deps: MemberPhaseDeps) {
  const { ctx, secrets, state } = deps;
  const who = identity();
  secrets.add(who.email); secrets.add(who.password);
  const client = deps.openClient();
  let created = false, uncaptured = false;
  try {
    for (const [id, origin] of [['register_missing_origin_rejected', 'none'], ['register_foreign_origin_rejected', 'https://attacker.invalid']] as const) {
      const rejected = await deps.openClient().request('POST', '/api/v1/auth/register', { json: { email: who.email, password: who.password, nickname: who.nickname }, origin, csrf: null, session: false });
      seal(secrets, rejected.json());
      ctx.check(id, rejected.status === 403 && rejected.json()?.code === 'origin_rejected', problem(rejected));
    }
    // A rejected origin must not have created the account: login still fails closed.
    const absent = await deps.openClient().request('POST', '/api/v1/auth/login', { json: { email: who.email, password: who.password }, csrf: null, session: false });
    seal(secrets, absent.json());
    ctx.check('register_origin_rejection_creates_no_account', absent.status === 401 && absent.json()?.code === 'invalid_credentials' && !absent.setCookies().some(cookie => cookie.name === 'freedom_local_session' && cookie.value), problem(absent));

    const registered = await client.request('POST', '/api/v1/auth/register', { json: { email: who.email, password: who.password, nickname: who.nickname }, csrf: null });
    created = registered.status === 201;
    const body = rememberSession(secrets, client, registered);
    const cookie = registered.setCookies().find(value => value.name === 'freedom_local_session') ?? null;
    const flags = deps.cookieChecks(cookie, deps.target);
    const cookieOk = flags.present && flags.secure && flags.http_only && flags.same_site_strict && flags.path_root && flags.host_only;
    uncaptured = created && !client.hasSession();
    ctx.check('register_created', created && cookieOk && noStore(registered) && client.hasSession() && body?.user?.email === who.email && body?.user?.display_name === who.nickname && typeof body?.csrf_token === 'string', problem(registered));

    const duplicate = await deps.openClient().request('POST', '/api/v1/auth/register', { json: { email: who.email, password: who.password, nickname: who.nickname }, csrf: null, session: false });
    seal(secrets, duplicate.json());
    ctx.check('register_duplicate_rejected', duplicate.status === 409 && duplicate.json()?.code === 'account_unavailable' && !duplicate.setCookies().some(item => item.name === 'freedom_local_session' && item.value), problem(duplicate));

    const first = await client.request('GET', SESSION_PATH), second = await client.request('GET', SESSION_PATH);
    const id1 = payload(secrets, first)?.user?.user_id, id2 = payload(secrets, second)?.user?.user_id;
    ctx.check('session_reads_same_account', first.status === 200 && second.status === 200 && noStore(first) && noStore(second) && typeof id1 === 'string' && id1 === id2, problem(first.status === 200 ? second : first));

    const initial = await client.request('GET', '/api/v1/me/onboarding');
    const initialBody = payload(secrets, initial);
    ctx.check('onboarding_positioning_required', initial.status === 200 && initialBody?.completed === false && initialBody?.state === 'new' && initialBody?.required === true, problem(initial));

    const established = await establishMember(deps, client, null, PRIMARY_STEPS);
    const replay = await client.request('POST', '/api/v1/me/onboarding/complete', { json: established.completeBody, ifMatch: established.completeVersion, idempotency: established.completeKey });
    const replayBody = payload(secrets, replay);
    const preferences = await client.request('GET', '/api/v1/me/guild-preferences');
    const preferenceBody = payload(secrets, preferences);
    const onboarding = await client.request('GET', '/api/v1/me/onboarding');
    const onboardingBody = payload(secrets, onboarding);
    const sameReceipt = replay.status === 200 && sameJson(replayBody, established.completedBody);
    const unchanged = preferenceBody?.primary_guild_key === established.guildKey && preferenceBody?.aggregate_version === established.preferenceVersion
      && onboardingBody?.completed === true && onboardingBody?.draft?.aggregate_version === established.completedBody?.draft?.aggregate_version;
    ctx.check('primary_guild_replay_idempotent', sameReceipt && unchanged, sameReceipt ? 'state_changed' : 'stored_response_differs');

    const stale = await client.request('POST', '/api/v1/me/onboarding/complete', { json: established.completeBody, ifMatch: established.completeVersion, idempotency: randomUUID() });
    seal(secrets, stale.json());
    const afterStale = await client.request('GET', '/api/v1/me/onboarding');
    const afterBody = payload(secrets, afterStale);
    ctx.check('stale_if_match_rejected', stale.status === 412 && stale.json()?.code === 'version_conflict' && afterBody?.completed === true && afterBody?.draft?.aggregate_version === onboardingBody?.draft?.aggregate_version, problem(stale));

    const userId = String(id1);
    const staleSession = client.withSameSession();
    const loggedOut = await client.request('POST', '/api/v1/auth/logout', { json: {} });
    const cleared = !client.hasSession();
    const replayed = await staleSession.request('GET', SESSION_PATH);
    seal(secrets, replayed.json());
    const again = await client.request('POST', '/api/v1/auth/login', { json: { email: who.email, password: who.password }, csrf: null });
    const againBody = rememberSession(secrets, client, again);
    const still = await client.request('GET', '/api/v1/me/onboarding');
    const stillBody = payload(secrets, still);
    const reloginOk = loggedOut.status === 200 && noStore(loggedOut) && cleared && replayed.status === 401 && replayed.json()?.code === 'session_expired'
      && again.status === 200 && againBody?.user?.user_id === userId && still.status === 200 && stillBody?.completed === true;
    const reloginFailed = loggedOut.status !== 200 || !noStore(loggedOut) ? loggedOut : !cleared ? loggedOut : replayed.status !== 401 ? replayed : again.status !== 200 ? again : still;
    ctx.check('relogin_same_account', reloginOk, !cleared && loggedOut.status === 200 ? 'cookie_not_cleared' : problem(reloginFailed));

    const directory = await client.request('GET', '/api/v1/guilds/directory');
    const directoryBody = payload(secrets, directory);
    const guild = Array.isArray(directoryBody?.items) ? directoryBody.items.find((item: any) => item?.guild_key === established.guildKey) : undefined;
    const github = await client.request('GET', '/api/v1/me/github');
    const githubBody = payload(secrets, github);
    const githubState = github.status === 200 ? (githubBody?.connected === true ? 'done' : githubBody?.configured === true ? 'incomplete' : 'unavailable')
      : github.status === 503 || githubBody?.code === 'github_setup_unavailable' ? 'unavailable' : 'error';
    const positioning = stillBody?.completed === true ? 'done' : 'incomplete';
    const primary = guild?.membership?.state === 'active' && guild?.is_primary === true ? 'done' : 'incomplete';
    ctx.metric('member_todos', { positioning, primary_guild: primary, github: githubState });
    ctx.check('member_todos_state', positioning === 'done' && primary === 'done' && (githubState === 'unavailable' || githubState === 'incomplete'), githubState === 'error' ? problem(github) : githubState === 'done' ? 'github_done' : problem(directory));
    ctx.metric('member_label', who.label);
    ctx.metric('onboarding_completed', true);
    state.primary = { ...who, userId, guildKey: established.guildKey };
  } finally {
    if (created) {
      const revoked = uncaptured ? 'restore_failed' : await revokeSession(client);
      ctx.cleanup(`revoked sessions of synthetic member ${who.label}`, revoked);
      ctx.cleanup(`synthetic member ${who.label}: root deactivates this cand-reg member in the candidate database`, 'cleanup_required');
      ctx.cleanup('member row, command receipts, positioning assessment and guild membership of the synthetic member', 'residual_expected');
    }
  }
}

const listItems = (body: any) => Array.isArray(body?.items) ? body.items as any[] : [];
const channelDenied = (reply: MemberReply) => reply.status === 404 && reply.json()?.code === CHANNEL_NOT_AVAILABLE;

async function loginMember(secrets: SecretBag, client: MemberClient, who: { email: string; password: string }) {
  const reply = await client.request('POST', '/api/v1/auth/login', { json: { email: who.email, password: who.password }, csrf: null });
  return { reply, body: rememberSession(secrets, client, reply) };
}
async function registerPeer(deps: MemberPhaseDeps, guildKey: string) {
  const { ctx, secrets } = deps;
  const who = identity();
  secrets.add(who.email); secrets.add(who.password);
  const client = deps.openClient();
  const registered = await client.request('POST', '/api/v1/auth/register', { json: { email: who.email, password: who.password, nickname: who.nickname }, csrf: null });
  const body = rememberSession(secrets, client, registered);
  ctx.check('peer_register_created', registered.status === 201 && client.hasSession() && typeof body?.user?.user_id === 'string' && body?.user?.display_name === who.nickname, problem(registered));
  const established = await establishMember(deps, client, guildKey, PEER_STEPS);
  ctx.check('peer_primary_matches', established.guildKey === guildKey);
  return { client, member: { ...who, userId: String(body.user.user_id), guildKey } as ProvisionedMember };
}
async function directCount(secrets: SecretBag, client: MemberClient, peerId: string) {
  const reply = await client.request('GET', `/api/v1/me/conversations/${peerId}/messages?limit=20&offset=0`);
  const body = payload(secrets, reply);
  return { reply, body, count: reply.status === 200 ? listItems(body).length : -1 };
}
async function joinGuild(secrets: SecretBag, client: MemberClient, key: string) {
  const directory = await client.request('GET', '/api/v1/guilds/directory');
  const item = listItems(payload(secrets, directory)).find(entry => entry?.guild_key === key);
  const version = item?.membership?.aggregate_version;
  const reply = await client.request('POST', `/api/v1/guilds/${key}/join`, { json: {}, idempotency: true, ...(version === undefined || version === null ? {} : { ifMatch: version }) });
  payload(secrets, reply);
  return reply;
}
async function leaveGuild(secrets: SecretBag, client: MemberClient, key: string) {
  const directory = await client.request('GET', '/api/v1/guilds/directory');
  const item = listItems(payload(secrets, directory)).find(entry => entry?.guild_key === key);
  if (item?.membership?.state !== 'active') return { status: item?.membership?.state === 'left' || item?.membership == null ? 'absent' : 'unknown' as const, reply: null };
  const reply = await client.request('POST', `/api/v1/guilds/${key}/leave`, { json: {}, ifMatch: item.membership.aggregate_version, idempotency: true });
  payload(secrets, reply);
  return { status: reply.status === 200 && reply.json()?.state === 'left' ? 'left' as const : 'failed' as const, reply };
}

async function guildChannels(deps: MemberPhaseDeps, a: MemberClient, b: MemberClient, guildKey: string, hold: { current: { key: string; leaveA: boolean; leaveB: boolean } | null }) {
  const { ctx, secrets, developmentGuilds } = deps;
  const text = sentence('合成驗收公會訊息，請勿回覆。');
  secrets.add(text);
  const sent = await a.request('POST', `/api/v1/me/channels/guild/${guildKey}/messages`, { json: { body: text }, idempotency: true });
  const sentBody = payload(secrets, sent);
  ctx.check('guild_channel_sent', sent.status === 201 && typeof sentBody?.message_id === 'string', problem(sent));
  const listed = await b.request('GET', '/api/v1/me/channels?kind=guild&limit=50&offset=0');
  const listedBody = payload(secrets, listed);
  const room = listItems(listedBody).find(item => item?.channel_key === guildKey);
  ctx.check('guild_channel_unread', listed.status === 200 && !!room && room.unread_count >= 1 && listedBody?.unread_count >= 1, problem(listed));
  const read = await b.request('GET', `/api/v1/me/channels/guild/${guildKey}/messages?limit=20&offset=0`);
  const readBody = payload(secrets, read);
  const mine = listItems(readBody).find(item => item?.body === text);
  ctx.check('guild_channel_read', read.status === 200 && !!mine, problem(read));
  const marked = await b.request('POST', `/api/v1/me/channels/guild/${guildKey}/read`, { json: { through_message_id: mine?.message_id }, idempotency: true });
  payload(secrets, marked);
  const after = await b.request('GET', '/api/v1/me/channels?kind=guild&limit=50&offset=0');
  const afterBody = payload(secrets, after);
  const afterRoom = listItems(afterBody).find(item => item?.channel_key === guildKey);
  ctx.check('guild_channel_marked_read', marked.status === 200 && after.status === 200 && afterRoom?.unread_count === 0, problem(marked.status === 200 ? after : marked));

  const directory = await a.request('GET', '/api/v1/guilds/directory');
  const secondary = firstGuild(payload(secrets, directory)?.items, developmentGuilds, [guildKey]);
  if (!secondary) {
    ctx.metric('secondary_guild', 'not_run');
    ctx.metric('secondary_guild_reason', 'secondary_guild_join_unavailable');
    return null;
  }
  const joinedA = await joinGuild(secrets, a, secondary);
  if (joinedA.status >= 500) ctx.check('secondary_guild_join', false, problem(joinedA));
  if (!(joinedA.status === 200 && joinedA.json()?.state === 'active')) {
    ctx.metric('secondary_guild', 'not_run');
    ctx.metric('secondary_guild_reason', 'secondary_guild_join_unavailable');
    return;
  }
  hold.current = { key: secondary, leaveA: true, leaveB: false };
  const joinedB = await joinGuild(secrets, b, secondary);
  if (!(joinedB.status === 200 && joinedB.json()?.state === 'active')) {
    ctx.metric('secondary_guild', 'not_run');
    ctx.metric('secondary_guild_reason', 'secondary_guild_join_unavailable');
    return;
  }
  hold.current.leaveB = true;
  const extra = sentence('合成驗收次要公會訊息，請勿回覆。');
  secrets.add(extra);
  const extraSent = await a.request('POST', `/api/v1/me/channels/guild/${secondary}/messages`, { json: { body: extra }, idempotency: true });
  payload(secrets, extraSent);
  ctx.check('secondary_guild_sent', extraSent.status === 201, problem(extraSent));
  const extraRead = await b.request('GET', `/api/v1/me/channels/guild/${secondary}/messages?limit=20&offset=0`);
  const extraBody = payload(secrets, extraRead);
  ctx.check('secondary_guild_read', extraRead.status === 200 && listItems(extraBody).some(item => item?.body === extra), problem(extraRead));
  const left = await leaveGuild(secrets, b, secondary);
  ctx.check('secondary_guild_left', left.status === 'left', left.reply ? problem(left.reply) : 'membership_not_active');
  hold.current.leaveB = left.status !== 'left';
  const denied = await b.request('GET', `/api/v1/me/channels/guild/${secondary}/messages?limit=1&offset=0`);
  seal(secrets, denied.json());
  ctx.check('secondary_guild_read_revoked', channelDenied(denied), problem(denied));
  const owner = await a.request('GET', `/api/v1/me/channels/guild/${secondary}/messages?limit=20&offset=0`);
  ctx.check('secondary_guild_owner_still_reads', owner.status === 200 && listItems(payload(secrets, owner)).some(item => item?.body === extra), problem(owner));
  ctx.metric('secondary_guild', 'pass');
}

export async function runMessagesPhase(deps: MemberPhaseDeps) {
  const { ctx, secrets, state } = deps;
  ctx.check('registered_member_available', state.primary !== null);
  const primary = state.primary;
  if (!primary) return;
  const a = deps.openClient();
  let aLive = false, bLive = false, bLabel: string | null = null, bClient: MemberClient | null = null;
  const secondary = { current: null as { key: string; leaveA: boolean; leaveB: boolean } | null };
  try {
    const loggedIn = await loginMember(secrets, a, primary);
    aLive = a.hasSession();
    ctx.check('member_a_login', loggedIn.reply.status === 200 && loggedIn.body?.user?.user_id === primary.userId && aLive, problem(loggedIn.reply));
    const peer = await registerPeer(deps, primary.guildKey);
    bClient = peer.client; bLive = bClient.hasSession(); bLabel = peer.member.label;
    state.peer = peer.member;

    const direct = sentence('合成驗收訊息，請勿回覆。');
    secrets.add(direct);
    const sendKey = randomUUID();
    const sent = await a.request('POST', `/api/v1/me/conversations/${peer.member.userId}/messages`, { json: { body: direct }, idempotency: sendKey });
    const sentBody = payload(secrets, sent);
    ctx.check('dm_sent', sent.status === 201 && typeof sentBody?.message_id === 'string' && sentBody?.body === direct, problem(sent));
    const incoming = await bClient.request('GET', '/api/v1/me/conversations?limit=20&offset=0');
    const incomingBody = payload(secrets, incoming);
    const fromA = listItems(incomingBody).find(item => item?.participant?.user_id === primary.userId);
    ctx.check('dm_unread_one', incoming.status === 200 && fromA?.unread_count === 1 && incomingBody?.unread_count === 1, problem(incoming));
    const thread = await directCount(secrets, bClient, primary.userId);
    ctx.check('dm_body_matches', thread.reply.status === 200 && thread.body?.unread_count === 1 && listItems(thread.body).some(item => item?.message_id === sentBody?.message_id && item?.body === direct), problem(thread.reply));
    const marked = await bClient.request('POST', `/api/v1/me/conversations/${primary.userId}/read`, { json: {}, idempotency: true });
    payload(secrets, marked);
    const cleared = await bClient.request('GET', '/api/v1/me/conversations?limit=20&offset=0');
    const clearedBody = payload(secrets, cleared);
    const clearedItem = listItems(clearedBody).find(item => item?.participant?.user_id === primary.userId);
    ctx.check('dm_marked_read', marked.status === 200 && cleared.status === 200 && clearedBody?.unread_count === 0 && clearedItem?.unread_count === 0, problem(marked.status === 200 ? cleared : marked));
    const own = await a.request('GET', '/api/v1/me/conversations?limit=20&offset=0');
    const ownBody = payload(secrets, own);
    const ownItem = listItems(ownBody).find(item => item?.participant?.user_id === peer.member.userId);
    ctx.check('dm_sender_unread_excludes_own', own.status === 200 && ownBody?.unread_count === 0 && ownItem?.unread_count === 0, problem(own));
    const replay = await a.request('POST', `/api/v1/me/conversations/${peer.member.userId}/messages`, { json: { body: direct }, idempotency: sendKey });
    const replayBody = payload(secrets, replay);
    const afterReplay = await directCount(secrets, bClient, primary.userId);
    ctx.check('dm_replay_idempotent', replay.status === 201 && replayBody?.message_id === sentBody?.message_id && afterReplay.count === 1, problem(replay.status === 201 ? afterReplay.reply : replay));
    const foreignBody = sentence('合成驗收外來來源，請勿回覆。');
    secrets.add(foreignBody);
    const foreign = await a.request('POST', `/api/v1/me/conversations/${peer.member.userId}/messages`, { json: { body: foreignBody }, idempotency: true, origin: 'https://attacker.invalid' });
    seal(secrets, foreign.json());
    const afterForeign = await directCount(secrets, a, peer.member.userId);
    ctx.check('dm_foreign_origin_rejected', foreign.status === 403 && foreign.json()?.code === 'origin_rejected' && afterForeign.count === 1, problem(foreign.status === 403 ? afterForeign.reply : foreign));
    state.lastDirectBody = direct;

    const squad = await a.request('POST', '/api/v1/squads', { json: { name: '合成驗收小隊', kind: 'project', purpose: '合成驗收用的小隊，只包含這次建立的兩位會員。' }, idempotency: true });
    const squadBody = payload(secrets, squad);
    const squadId = squadBody?.squad_id;
    ctx.check('squad_created', squad.status === 201 && typeof squadId === 'string', problem(squad));
    const invite = await a.request('POST', `/api/v1/squads/${squadId}/invitations`, { json: { recipient_ref: peer.member.userId }, idempotency: true });
    const inviteBody = payload(secrets, invite);
    ctx.check('squad_invited', invite.status === 200 && inviteBody?.state === 'pending' && typeof inviteBody?.invitation_id === 'string', problem(invite));
    const received = await bClient.request('GET', '/api/v1/me/squad-invitations?state=pending&limit=20&offset=0');
    const receivedBody = payload(secrets, received);
    ctx.check('squad_invitation_visible', received.status === 200 && listItems(receivedBody).some(item => item?.invitation_id === inviteBody?.invitation_id && item?.squad_id === squadId && item?.state === 'pending'), problem(received));
    const notes = await bClient.request('GET', '/api/v1/me/notifications?limit=20&offset=0');
    const noteBody = payload(secrets, notes);
    const notice = listItems(noteBody).find(item => item?.kind === 'squad_invitation' && item?.read_at === null && item?.action?.resource_id === squadId);
    ctx.check('squad_invitation_notified', notes.status === 200 && typeof noteBody?.unread_count === 'number' && noteBody.unread_count >= 1 && !!notice, problem(notes));
    const accepted = await bClient.request('POST', `/api/v1/squad-invitations/${inviteBody.invitation_id}/accept`, { json: {}, ifMatch: inviteBody.aggregate_version, idempotency: true });
    const acceptedBody = payload(secrets, accepted);
    ctx.check('squad_invitation_accepted', accepted.status === 200 && acceptedBody?.state === 'accepted', problem(accepted));
    const bChannels = await bClient.request('GET', '/api/v1/me/channels?kind=squad&limit=50&offset=0');
    const aChannels = await a.request('GET', '/api/v1/me/channels?kind=squad&limit=50&offset=0');
    const bListed = listItems(payload(secrets, bChannels)).some(item => item?.channel_key === squadId);
    const aListed = listItems(payload(secrets, aChannels)).some(item => item?.channel_key === squadId);
    ctx.check('squad_channel_listed', bChannels.status === 200 && aChannels.status === 200 && bListed && aListed, problem(bChannels.status === 200 ? aChannels : bChannels));

    const firstText = sentence('合成驗收頻道訊息，請勿回覆。');
    const secondText = sentence('合成驗收頻道訊息第二則，請勿回覆。');
    secrets.add(firstText); secrets.add(secondText);
    const firstSent = await a.request('POST', `/api/v1/me/channels/squad/${squadId}/messages`, { json: { body: firstText }, idempotency: true });
    payload(secrets, firstSent);
    ctx.check('squad_message_sent', firstSent.status === 201, problem(firstSent));
    const unread = await bClient.request('GET', '/api/v1/me/channels?kind=squad&limit=50&offset=0');
    const unreadBody = payload(secrets, unread);
    const unreadRoom = listItems(unreadBody).find(item => item?.channel_key === squadId);
    ctx.check('squad_unread_one', unread.status === 200 && unreadRoom?.unread_count === 1, problem(unread));
    const secondSent = await a.request('POST', `/api/v1/me/channels/squad/${squadId}/messages`, { json: { body: secondText }, idempotency: true });
    payload(secrets, secondSent);
    ctx.check('squad_second_message_sent', secondSent.status === 201, problem(secondSent));
    const pageOne = await bClient.request('GET', `/api/v1/me/channels/squad/${squadId}/messages?limit=1&offset=0`);
    const pageTwo = await bClient.request('GET', `/api/v1/me/channels/squad/${squadId}/messages?limit=1&offset=1`);
    const pageOneItems = listItems(payload(secrets, pageOne)), pageTwoItems = listItems(payload(secrets, pageTwo));
    const ids = [...pageOneItems, ...pageTwoItems].map(item => item?.message_id).filter((id): id is string => typeof id === 'string');
    const bodies = new Set([...pageOneItems, ...pageTwoItems].map(item => item?.body));
    ctx.check('squad_message_ids_unique', pageOne.status === 200 && pageTwo.status === 200 && ids.length === 2 && new Set(ids).size === 2 && bodies.has(firstText) && bodies.has(secondText), problem(pageOne.status === 200 ? pageTwo : pageOne));
    const newest = pageOneItems[0]?.message_id;
    const readSquad = await bClient.request('POST', `/api/v1/me/channels/squad/${squadId}/read`, { json: { through_message_id: newest }, idempotency: true });
    payload(secrets, readSquad);
    const squadAfter = await bClient.request('GET', `/api/v1/me/channels/squad/${squadId}/messages?limit=1&offset=0`);
    ctx.check('squad_marked_read', readSquad.status === 200 && squadAfter.status === 200 && payload(secrets, squadAfter)?.unread_count === 0, problem(readSquad.status === 200 ? squadAfter : readSquad));

    const detail = await bClient.request('GET', `/api/v1/squads/${squadId}`);
    const detailBody = payload(secrets, detail);
    const membership = Array.isArray(detailBody?.members) ? detailBody.members.find((item: any) => item?.user_id === peer.member.userId) : undefined;
    ctx.check('squad_membership_visible', detail.status === 200 && (typeof membership?.aggregate_version === 'number' || typeof membership?.aggregate_version === 'string'), problem(detail));
    const left = await bClient.request('POST', `/api/v1/squads/${squadId}/leave`, { json: {}, ifMatch: membership?.aggregate_version, idempotency: true });
    payload(secrets, left);
    ctx.check('squad_left', left.status === 200 && left.json()?.state === 'left', problem(left));
    const deniedRead = await bClient.request('GET', `/api/v1/me/channels/squad/${squadId}/messages?limit=1&offset=0`);
    seal(secrets, deniedRead.json());
    const rejectedText = sentence('合成驗收不應送出。');
    secrets.add(rejectedText);
    const deniedSend = await bClient.request('POST', `/api/v1/me/channels/squad/${squadId}/messages`, { json: { body: rejectedText }, idempotency: true });
    seal(secrets, deniedSend.json());
    ctx.check('squad_left_read_denied', channelDenied(deniedRead), problem(deniedRead));
    ctx.check('squad_left_send_denied', channelDenied(deniedSend), problem(deniedSend));
    const ownerReads = await a.request('GET', `/api/v1/me/channels/squad/${squadId}/messages?limit=20&offset=0`);
    ctx.check('squad_owner_still_reads', ownerReads.status === 200 && listItems(payload(secrets, ownerReads)).some(item => item?.body === firstText), problem(ownerReads));
    const removed = await bClient.request('GET', '/api/v1/me/channels?kind=squad&limit=50&offset=0');
    ctx.check('squad_channel_removed', removed.status === 200 && !listItems(payload(secrets, removed)).some(item => item?.channel_key === squadId), problem(removed));

    const beforeUnread = noteBody.unread_count as number;
    const markedNotice = await bClient.request('POST', `/api/v1/me/notifications/${notice.notification_id}/read`, { json: {}, idempotency: true });
    payload(secrets, markedNotice);
    const afterNotes = await bClient.request('GET', '/api/v1/me/notifications?limit=1&offset=0');
    const afterNotesBody = payload(secrets, afterNotes);
    ctx.check('notification_mark_read_decreases', markedNotice.status === 200 && afterNotes.status === 200 && afterNotesBody?.unread_count === beforeUnread - 1, problem(markedNotice.status === 200 ? afterNotes : markedNotice));
    const senderNotes = await a.request('GET', '/api/v1/me/notifications?limit=20&offset=0');
    for (const item of listItems(payload(secrets, senderNotes)).filter(entry => entry?.read_at === null).slice(0, 5)) {
      const done = await a.request('POST', `/api/v1/me/notifications/${item.notification_id}/read`, { json: {}, idempotency: true });
      payload(secrets, done);
      ctx.check('sender_notification_mark_read', done.status === 200, problem(done));
    }
    const senderLeft = await a.request('GET', '/api/v1/me/notifications?limit=1&offset=0');
    ctx.check('sender_notifications_clear', payload(secrets, senderLeft)?.unread_count === 0, problem(senderLeft));

    if (guildChannelsRealHistoryGuarded(deps.target)) {
      ctx.metric('guild_channel', 'not_run');
      ctx.metric('guild_channel_reason', 'real_history_guarded');
    } else {
      await guildChannels(deps, a, bClient, primary.guildKey, secondary);
      ctx.metric('guild_channel', 'pass');
    }
    ctx.metric('rate_limit', 'not_covered');
    ctx.metric('member_labels', [primary.label, peer.member.label]);
  } finally {
    const tracked = secondary.current;
    if (tracked && bClient) {
      if (tracked.leaveB) {
        const left = await leaveGuild(secrets, bClient, tracked.key).catch(() => null);
        ctx.cleanup(`secondary guild membership ${tracked.key} of synthetic member ${bLabel ?? 'peer'}`, left?.status === 'left' || left?.status === 'absent' ? 'restored' : 'restore_failed');
      }
      if (tracked.leaveA) {
        const left = await leaveGuild(secrets, a, tracked.key).catch(() => null);
        ctx.cleanup(`secondary guild membership ${tracked.key} of synthetic member ${primary.label}`, left?.status === 'left' || left?.status === 'absent' ? 'restored' : 'restore_failed');
      }
    }
    if (aLive || a.hasSession()) ctx.cleanup(`revoked sessions of synthetic member ${primary.label}`, await revokeSession(a));
    if (bClient && (bLive || bClient.hasSession())) ctx.cleanup(`revoked sessions of synthetic member ${bLabel ?? 'peer'}`, await revokeSession(bClient));
    if (aLive || bLive) {
      const labels = [primary.label, bLabel].filter((label): label is string => !!label).join(' and ');
      ctx.cleanup(`synthetic members ${labels}: root deactivates these cand-reg members in the candidate database`, 'cleanup_required');
      ctx.cleanup('member rows, command receipts, and any squad, membership, message or notification rows this phase created', 'residual_expected');
    }
  }
}

/** Mobile viewport UI for the direct-message thread. Returns whether UI logout completed. */
export async function runMessagesMobile(page: any, context: any, ctx: MemberCtx, state: MemberRunState, secrets: SecretBag, origin: string): Promise<boolean> {
  const primary = state.primary, peer = state.peer, last = state.lastDirectBody;
  ctx.check('messages_context_available', !!primary && !!peer && typeof last === 'string' && last.length > 0);
  if (!primary || !peer || !last) return false;
  secrets.add(last);
  const uiBody = sentence('合成驗收介面訊息。');
  secrets.add(uiBody);
  const landing = await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  ctx.check('landing_200', landing?.status() === 200, `status ${landing?.status() ?? 'none'}`);
  await page.getByLabel('電子郵件', { exact: true }).fill(primary.email);
  await page.getByLabel('密碼', { exact: true }).fill(primary.password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByRole('button', { name: '登出', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  ctx.check('mobile_login', true);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('menuitem', { name: '我的訊息', exact: true }).click();
  await page.waitForURL(/#messages$/, { timeout: 20000 });
  const direct = page.getByRole('tab', { name: /私人訊息/ });
  await direct.click();
  const row = page.getByRole('list', { name: '對話列表' }).getByRole('button', { name: new RegExp(peer.nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await row.waitFor({ state: 'visible', timeout: 20000 });
  const rowText = String(await row.innerText());
  ctx.check('conversation_visible', true);
  ctx.check('last_message_visible', rowText.includes(last));
  const rowUnread = rowText.includes('則未讀');
  await row.click();
  const panel = page.getByRole('tabpanel', { name: /私人訊息/ });
  await panel.getByRole('heading', { name: `與 ${peer.nickname} 的對話` }).waitFor({ state: 'visible', timeout: 20000 });
  await panel.locator('.messages-bubbles .messages-body', { hasText: last }).waitFor({ state: 'visible', timeout: 20000 });
  await panel.getByLabel(`寫給 ${peer.nickname} 的訊息`).fill(uiBody);
  await panel.getByRole('button', { name: '送出', exact: true }).click();
  await panel.locator('.messages-bubbles .messages-body', { hasText: uiBody }).waitFor({ state: 'visible', timeout: 20000 });
  await row.filter({ hasText: uiBody }).waitFor({ state: 'visible', timeout: 20000 });
  ctx.check('ui_message_visible', true);
  let tabClear = false;
  try { await direct.filter({ hasText: '沒有未讀' }).waitFor({ timeout: 20000 }); tabClear = true; } catch { tabClear = false; }
  const rowAfter = String(await row.innerText());
  const dot = await page.locator('.settings-dot').count();
  ctx.check('unread_consistent', !rowUnread && tabClear && !rowAfter.includes('則未讀') && dot === 0);
  ctx.check('no_horizontal_overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) === true);
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await page.getByRole('button', { name: '登入', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  const cookies = await context.cookies(origin);
  ctx.check('ui_logout_clears_cookie', !cookies.some((cookie: { name?: string; value?: string }) => cookie.name === 'freedom_local_session' && cookie.value));
  return true;
}
