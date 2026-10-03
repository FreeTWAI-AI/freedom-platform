import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId, ResourceScopeRefSchema } from '../../contracts/common/v1/identity.js';
import { lockMemberScope, type MemberScopeInput, type MemberScopeContext } from '../resource-scopes/index.js';
import { requireCondition } from '../shared/problem.js';
import { runCommandCore } from '../db/command-core.js';
import { digest } from '../db/legacy-digest.js';
import { assertCurrentSessionClock } from '../db/member-session.js';
import { legacyMemberReceiptPorts, type Command } from '../db/member-command.js';

export interface ScopedMemberCommand extends MemberScopeInput {
  operation: string;
  key: string;
  body: unknown;
  target: { kind: string; id: string };
  expected?: string;
}
export interface ScopedJournalInput {
  aggregate_type: string;
  id: string;
  version: string | number;
  operation: string;
  data?: Record<string, unknown>;
  eventType?: string;
}

const ID = /^[a-z][a-z0-9_.-]{0,159}$/;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const activeCommands = new WeakMap<MemberScopeContext, {
  q: PoolClient; operation: string; authorized: boolean;
  journalTarget?: { aggregate_type: 'member_avatar'|'member_service'|'community_event'; id: string };
}>();
function stableId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && ID.test(value) && !/[\r\n]/.test(value);
}
function uuid(value: unknown): value is string { return OpaqueId.safeParse(value).success; }
function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && !/[\r\n]/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}

// This is an explicit local JSON profile, not JCS. Reject lossy JSON values,
// accessors/toJSON, cycles and non-plain objects before hashing or persisting.
// Never interpolate input into errors or automatically journal the request.
function jsonSnapshot(value: unknown, maxBytes: number): { value: unknown; json: string } {
  const active = new WeakSet<object>(); let nodes = 0, estimatedBytes = 0;
  const invalid = () => requireCondition(false, 400, 'invalid_command_json', '操作資料必須是有界的 JSON。');
  const copy = (current: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 24) invalid();
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (/[\u0000\uD800-\uDFFF]/u.test(current)) invalid();
      estimatedBytes += Buffer.byteLength(current);
      if (estimatedBytes > maxBytes) invalid();
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Number.isInteger(current) && !Number.isSafeInteger(current)) invalid();
      return current;
    }
    if (!current || typeof current !== 'object') { invalid(); return null; }
    if (active.has(current)) invalid();
    const array = Array.isArray(current), proto = Object.getPrototypeOf(current);
    if (!array && proto !== Object.prototype && proto !== null) invalid();
    active.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Object.getOwnPropertySymbols(current).length) invalid();
    const keys = Object.keys(descriptors).filter(key => !(array && key === 'length'));
    if (keys.length > 20_000 || array && keys.length !== current.length) invalid();
    const out: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    for (const key of keys.sort()) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor) || array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
      estimatedBytes += Buffer.byteLength(key);
      if (estimatedBytes > maxBytes || /[\u0000\uD800-\uDFFF]/u.test(key)) invalid();
      (out as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    active.delete(current);
    return Object.freeze(out);
  };
  const snapshot = copy(value, 0), json = JSON.stringify(snapshot);
  requireCondition(Buffer.byteLength(json) <= maxBytes, 400, 'invalid_command_json', '操作資料必須是有界的 JSON。');
  // Ordinary JSON prototypes match pg's parsed replay responses. This second
  // bounded copy also prevents callback-owned mutable response aliases.
  const freeze = (item: unknown): unknown => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
    return item;
  };
  return { value: freeze(JSON.parse(json)), json };
}

/** Additive member-session adapter. No machine credentials, HTTP activation,
 * network I/O, target ACL inference or change to historical member receipts. */
export async function scopedMemberCommand<T>(pool: Pool, input: ScopedMemberCommand,
  authorize: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>,
  run: (q: PoolClient, context: MemberScopeContext) => Promise<T>,
  revalidate?: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>): Promise<T> {
  // This server-owned port is outside the request/digest. Time-bounded domain
  // authority must survive the actual receipt read/write wait on this client.
  requireCondition(revalidate === undefined || typeof revalidate === 'function',
    400, 'invalid_scoped_command', '操作資料無效。');
  requireCondition(input && typeof input === 'object' && Object.keys(input).every(key =>
    ['actor', 'scope', 'operation', 'key', 'body', 'target', 'expected', 'lockUser'].includes(key)),
  400, 'invalid_scoped_command', '操作資料無效。');
  requireCondition(typeof input.key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(input.key)
    && !/[\r\n]/.test(input.key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  requireCondition(stableId(input.operation), 400, 'invalid_operation', '操作識別碼無效。');
  requireCondition(input.target && Object.keys(input.target).length === 2 && stableId(input.target.kind) && uuid(input.target.id),
    400, 'invalid_target', '目標識別碼無效。');
  requireCondition(input.expected === undefined || validVersion(input.expected), 400, 'invalid_expected_version', '版本無效。');
  requireCondition(input.lockUser === undefined || typeof input.lockUser === 'boolean', 400, 'invalid_scoped_command', '操作資料無效。');
  requireCondition(input.actor && uuid(input.actor.user_id) && uuid(input.actor.community_id)
    && typeof input.actor.session_hash === 'string' && input.actor.session_hash.length > 0 && input.actor.session_hash.length <= 256,
  401, 'session_expired', '請重新登入。');
  const actor = Object.freeze({ ...input.actor });
  const scope = typeof input.scope === 'string' ? input.scope : Object.freeze(ResourceScopeRefSchema.parse(input.scope));
  requireCondition(scope === 'personal' || scope === 'community' || typeof scope === 'object' && scope.kind !== 'site',
    403, 'scope_kind_unavailable', '這種資源範圍尚未開放。');
  const operation = input.operation, key = input.key, target = Object.freeze({ ...input.target }), expected = input.expected ?? null;
  const body = jsonSnapshot(input.body, MAX_JSON_BYTES).value, lockUser = input.lockUser;
  let context: MemberScopeContext;
  const namespace = () => [context.subject_principal.principal_id, context.authn_kind, context.scope.scope_id, operation, key];
  try {
    return await runCommandCore(pool, {
      async authenticateAndLock(q) {
        context = await lockMemberScope(q, { actor, scope, lockUser });
        await assertCurrentSessionClock(q, actor);
        activeCommands.set(context, { q, operation, authorized: false });
      },
      async lockReceipt(q) {
        await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [JSON.stringify(['freedom.scoped-member-command/v1', ...namespace()])]);
      },
      requestDigest: () => digest({ profile: 'freedom.scoped-member-command/v1', scope: context.scope, target, expected, body }),
      async readReceipt(q) {
        const prior = (await q.query(`SELECT request_sha256,response FROM scoped_command_receipts
          WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation=$4 AND idempotency_key=$5`, namespace())).rows[0];
        // Receipt storage can block after domain authorization (e.g. DDL or a
        // sink trigger). Never disclose a replay after that wait expires login.
        await assertCurrentSessionClock(q, actor);
        if (revalidate) { await revalidate(q, context); await assertCurrentSessionClock(q, actor); }
        return prior ? { request_sha256: prior.request_sha256, response: jsonSnapshot(prior.response, MAX_JSON_BYTES).value as T } : null;
      },
      async writeReceipt(q, hash, response) {
        const encoded = jsonSnapshot(response, MAX_JSON_BYTES);
        await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,
          principal_kind,scope_kind,target_kind,target_id,request_sha256,response)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [...namespace(), context.subject_principal.kind, context.scope.kind, target.kind, target.id, hash, encoded.json]);
        // Keep the response and every domain/fact write in the same rollback
        // when a receipt sink wait crosses session expiry. This is a decision
        // clock check, not a guarantee about COMMIT/network delivery time.
        await assertCurrentSessionClock(q, actor);
        if (revalidate) { await revalidate(q, context); await assertCurrentSessionClock(q, actor); }
      },
    }, async q => {
      await authorize(q, context);
      await assertCurrentSessionClock(q, actor);
      activeCommands.get(context)!.authorized = true;
    }, async q => jsonSnapshot(await run(q, context), MAX_JSON_BYTES).value as T);
  } finally { if (context!) activeCommands.delete(context); }
}

/** Closed member-avatar replacement compatibility adapter. Current personal
 * authority precedes the ORIGINAL POST receipt lookup. New domain/pointer
 * facts and that same receipt commit on one client; no external I/O here.
 * For an early replay-only probe, a trusted caller may throw its own private
 * sentinel from run on a miss: transaction rollback leaves no success receipt.
 * This does not enable arbitrary legacy/scoped receipt-profile selection. */
export async function avatarMemberCommand<T>(pool: Pool, input: Command,
  authorize: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>,
  run: (q: PoolClient, context: MemberScopeContext) => Promise<T>): Promise<T> {
  requireCondition(input && typeof input === 'object' && Object.keys(input).every(key =>
    ['actor', 'operation', 'key', 'body', 'expected', 'lockUser'].includes(key))
    && input.operation === 'POST /api/v1/me/avatar', 400, 'invalid_avatar_command', '頭像操作資料無效。');
  requireCondition(typeof input.key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(input.key)
    && !/[\r\n]/.test(input.key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  requireCondition(input.expected === undefined || validVersion(input.expected), 400, 'invalid_expected_version', '版本無效。');
  requireCondition(input.lockUser === undefined || typeof input.lockUser === 'boolean', 400, 'invalid_avatar_command', '頭像操作資料無效。');
  requireCondition(input.actor && uuid(input.actor.user_id) && uuid(input.actor.community_id)
    && typeof input.actor.session_hash === 'string' && input.actor.session_hash.length > 0 && input.actor.session_hash.length <= 256,
  401, 'session_expired', '請重新登入。');
  const body = jsonSnapshot(input.body, MAX_JSON_BYTES).value as Record<string, unknown>;
  requireCondition(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 2
    && ['image/jpeg', 'image/png', 'image/webp'].includes(body.content_type as string)
    && typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256) && body.sha256.length === 64,
  400, 'invalid_avatar_command', '頭像操作資料無效。');
  const actor = Object.freeze({ ...input.actor });
  const snapshot: Command = Object.freeze({ actor, operation: 'POST /api/v1/me/avatar', key: input.key,
    body, expected: input.expected, lockUser: input.lockUser });
  const receipts = legacyMemberReceiptPorts<T>(snapshot);
  let context: MemberScopeContext;
  try {
    return await runCommandCore(pool, {
      ...receipts,
      async authenticateAndLock(q) {
        context = await lockMemberScope(q, { actor, scope: 'personal', lockUser: snapshot.lockUser });
        await assertCurrentSessionClock(q, actor);
        activeCommands.set(context, { q, operation: 'member.avatar.replace', authorized: false,
          journalTarget: { aggregate_type: 'member_avatar', id: actor.user_id } });
      },
      async readReceipt(q) {
        const prior = await receipts.readReceipt(q);
        return prior ? { ...prior, response: jsonSnapshot(prior.response, MAX_JSON_BYTES).value as T } : null;
      },
    }, async q => {
      await authorize(q, context);
      await assertCurrentSessionClock(q, actor);
      activeCommands.get(context)!.authorized = true;
    }, async q => jsonSnapshot(await run(q, context), MAX_JSON_BYTES).value as T);
  } finally { if (context!) activeCommands.delete(context); }
}

/** Closed existing service-cover PUT receipt adapter; current scope precedes replay. */
export async function serviceCoverMemberCommand<T>(pool: Pool, input: Command,
  authorize: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>,
  run: (q: PoolClient, context: MemberScopeContext) => Promise<T>): Promise<T> {
  requireCondition(input && typeof input === 'object' && Object.keys(input).every(key =>
    ['actor', 'operation', 'key', 'body', 'expected', 'lockUser'].includes(key))
    && typeof input.operation==='string' && /^PUT \/api\/v1\/member-services\/[0-9a-f-]{36}\/cover$/.test(input.operation) && uuid(input.operation.split('/')[4]), 400, 'invalid_service_cover_command', '頭像操作資料無效。');
  requireCondition(typeof input.key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(input.key)
    && !/[\r\n]/.test(input.key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  requireCondition(input.expected === undefined || validVersion(input.expected), 400, 'invalid_expected_version', '版本無效。');
  requireCondition(input.lockUser === undefined || typeof input.lockUser === 'boolean', 400, 'invalid_service_cover_command', '頭像操作資料無效。');
  requireCondition(input.actor && uuid(input.actor.user_id) && uuid(input.actor.community_id)
    && typeof input.actor.session_hash === 'string' && input.actor.session_hash.length > 0 && input.actor.session_hash.length <= 256,
  401, 'session_expired', '請重新登入。');
  const body = jsonSnapshot(input.body, MAX_JSON_BYTES).value as Record<string, unknown>;
  requireCondition(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && Object.hasOwn(body,'sha256')
    && typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256) && body.sha256.length === 64,
  400, 'invalid_service_cover_command', '頭像操作資料無效。');
  const actor = Object.freeze({ ...input.actor });
  const snapshot: Command = Object.freeze({ actor, operation: input.operation, key: input.key,
    body, expected: input.expected, lockUser: input.lockUser });
  const receipts = legacyMemberReceiptPorts<T>(snapshot);
  let context: MemberScopeContext;
  try {
    return await runCommandCore(pool, {
      ...receipts,
      async authenticateAndLock(q) {
        context = await lockMemberScope(q, { actor, scope: 'personal', lockUser: snapshot.lockUser });
        await assertCurrentSessionClock(q, actor);
        activeCommands.set(context, { q, operation: 'member.service.cover.replace', authorized: false,
          journalTarget: { aggregate_type: 'member_service', id: input.operation.split('/')[4] } });
      },
      async readReceipt(q) {
        const prior = await receipts.readReceipt(q);
        return prior ? { ...prior, response: jsonSnapshot(prior.response, MAX_JSON_BYTES).value as T } : null;
      },
    }, async q => {
      await authorize(q, context);
      await assertCurrentSessionClock(q, actor);
      activeCommands.get(context)!.authorized = true;
    }, async q => jsonSnapshot(await run(q, context), MAX_JSON_BYTES).value as T);
  } finally { if (context!) activeCommands.delete(context); }
}

export async function eventBannerMemberCommand<T>(pool: Pool, input: Command,
  authorize: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>,
  run: (q: PoolClient, context: MemberScopeContext) => Promise<T>): Promise<T> {
  requireCondition(input && typeof input === 'object' && Object.keys(input).every(key =>
    ['actor', 'operation', 'key', 'body', 'expected', 'lockUser'].includes(key))
    && typeof input.operation==='string' && /^POST \/api\/v1\/events\/[0-9a-f-]{36}\/banner$/.test(input.operation) && uuid(input.operation.split('/')[4]), 400, 'invalid_event_banner_command', '活動海報操作資料無效。');
  requireCondition(typeof input.key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(input.key)
    && !/[\r\n]/.test(input.key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  requireCondition(input.expected === undefined || validVersion(input.expected), 400, 'invalid_expected_version', '版本無效。');
  requireCondition(input.lockUser === undefined || typeof input.lockUser === 'boolean', 400, 'invalid_event_banner_command', '活動海報操作資料無效。');
  requireCondition(input.actor && uuid(input.actor.user_id) && uuid(input.actor.community_id)
    && typeof input.actor.session_hash === 'string' && input.actor.session_hash.length > 0 && input.actor.session_hash.length <= 256,
  401, 'session_expired', '請重新登入。');
  const body = jsonSnapshot(input.body, MAX_JSON_BYTES).value as Record<string, unknown>;
  requireCondition(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 3 && ['mime','orientation','sha256'].every(key=>Object.hasOwn(body,key)) && ['image/jpeg','image/png','image/webp'].includes(body.mime as string) && ['landscape','portrait'].includes(body.orientation as string)
    && typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256) && body.sha256.length === 64,
  400, 'invalid_event_banner_command', '活動海報操作資料無效。');
  const actor = Object.freeze({ ...input.actor });
  const snapshot: Command = Object.freeze({ actor, operation: input.operation, key: input.key,
    body, expected: input.expected, lockUser: true });
  const receipts = legacyMemberReceiptPorts<T>(snapshot);
  let context: MemberScopeContext;
  try {
    return await runCommandCore(pool, {
      ...receipts,
      async authenticateAndLock(q) {
        context = await lockMemberScope(q, { actor, scope: 'community', lockUser: snapshot.lockUser });
        await assertCurrentSessionClock(q, actor);
        activeCommands.set(context, { q, operation: 'community.event.banner.replace', authorized: false,
          journalTarget: { aggregate_type: 'community_event', id: input.operation.split('/')[4] } });
      },
      async readReceipt(q) {
        const prior = await receipts.readReceipt(q);
        return prior ? { ...prior, response: jsonSnapshot(prior.response, MAX_JSON_BYTES).value as T } : null;
      },
    }, async q => {
      await authorize(q, context);
      await assertCurrentSessionClock(q, actor);
      activeCommands.get(context)!.authorized = true;
    }, async q => jsonSnapshot(await run(q, context), MAX_JSON_BYTES).value as T);
  } finally { if (context!) activeCommands.delete(context); }
}

export async function eventVideoMemberCommand<T>(pool: Pool, input: Command,
  authorize: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>,
  run: (q: PoolClient, context: MemberScopeContext) => Promise<T>): Promise<T> {
  requireCondition(input && typeof input === 'object' && Object.keys(input).every(key =>
    ['actor', 'operation', 'key', 'body', 'expected', 'lockUser'].includes(key))
    && typeof input.operation==='string' && /^POST \/api\/v1\/events\/[0-9a-f-]{36}\/video$/.test(input.operation) && uuid(input.operation.split('/')[4]), 400, 'invalid_event_video_command', '活動影片操作資料無效。');
  requireCondition(typeof input.key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(input.key)
    && !/[\r\n]/.test(input.key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  requireCondition(input.expected === undefined || validVersion(input.expected), 400, 'invalid_expected_version', '版本無效。');
  requireCondition(input.lockUser === undefined || typeof input.lockUser === 'boolean', 400, 'invalid_event_video_command', '活動影片操作資料無效。');
  requireCondition(input.actor && uuid(input.actor.user_id) && uuid(input.actor.community_id)
    && typeof input.actor.session_hash === 'string' && input.actor.session_hash.length > 0 && input.actor.session_hash.length <= 256,
  401, 'session_expired', '請重新登入。');
  const body = jsonSnapshot(input.body, MAX_JSON_BYTES).value as Record<string, unknown>;
  requireCondition(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 2 && ['mime','sha256'].every(key=>Object.hasOwn(body,key)) && ['video/mp4','video/webm'].includes(body.mime as string)
    && typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256) && body.sha256.length === 64,
  400, 'invalid_event_video_command', '活動影片操作資料無效。');
  const actor = Object.freeze({ ...input.actor });
  const snapshot: Command = Object.freeze({ actor, operation: input.operation, key: input.key,
    body, expected: input.expected, lockUser: true });
  const receipts = legacyMemberReceiptPorts<T>(snapshot);
  let context: MemberScopeContext;
  try {
    return await runCommandCore(pool, {
      ...receipts,
      async authenticateAndLock(q) {
        context = await lockMemberScope(q, { actor, scope: 'community', lockUser: snapshot.lockUser });
        await assertCurrentSessionClock(q, actor);
        activeCommands.set(context, { q, operation: 'community.event.video.replace', authorized: false,
          journalTarget: { aggregate_type: 'community_event', id: input.operation.split('/')[4] } });
      },
      async readReceipt(q) {
        const prior = await receipts.readReceipt(q);
        return prior ? { ...prior, response: jsonSnapshot(prior.response, MAX_JSON_BYTES).value as T } : null;
      },
    }, async q => {
      await authorize(q, context);
      await assertCurrentSessionClock(q, actor);
      activeCommands.get(context)!.authorized = true;
    }, async q => jsonSnapshot(await run(q, context), MAX_JSON_BYTES).value as T);
  } finally { if (context!) activeCommands.delete(context); }
}

/** Explicit server-selected metadata only. The context must be from the run
 * callback of the current scoped command on the same client. This is not a
 * serialized authorization token and it never writes the community outbox. */
export async function scopedJournal(q: PoolClient, context: MemberScopeContext, input: ScopedJournalInput): Promise<void> {
  const active = activeCommands.get(context);
  requireCondition(active?.q === q && active.authorized, 403, 'scoped_context_required', '需要目前交易的操作範圍。');
  requireCondition(input && typeof input === 'object' && Object.keys(input).every(key =>
    ['aggregate_type', 'id', 'version', 'operation', 'data', 'eventType'].includes(key))
    && stableId(input.aggregate_type) && uuid(input.id) && stableId(input.operation),
  400, 'invalid_scoped_journal', '操作紀錄無效。');
  requireCondition(input.operation === active.operation, 400, 'journal_operation_mismatch', '操作紀錄與目前操作不符。');
  requireCondition(!active.journalTarget || input.aggregate_type === active.journalTarget.aggregate_type
    && input.id === active.journalTarget.id, 400, 'journal_target_mismatch', '操作紀錄與目前目標不符。');
  const version = typeof input.version === 'number' && Number.isSafeInteger(input.version) ? String(input.version) : input.version;
  requireCondition(validVersion(version), 400, 'invalid_scoped_journal', '操作紀錄無效。');
  requireCondition(input.eventType === undefined || stableId(input.eventType), 400, 'invalid_scoped_journal', '操作紀錄無效。');
  const metadata = jsonSnapshot(input.data ?? {}, MAX_METADATA_BYTES);
  requireCondition(metadata.value !== null && typeof metadata.value === 'object' && !Array.isArray(metadata.value),
    400, 'invalid_scoped_journal', '操作紀錄只能包含明選的中繼資料。');
  const aggregateType = input.aggregate_type, id = input.id, operation = input.operation, eventType = input.eventType;
  const transition = randomUUID();
  await q.query(`INSERT INTO scoped_transition_journal(transition_id,scope_id,scope_kind,principal_id,principal_kind,
    authn_kind,aggregate_type,aggregate_id,aggregate_version,operation,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [transition, context.scope.scope_id, context.scope.kind, context.subject_principal.principal_id, context.subject_principal.kind,
    context.authn_kind, aggregateType, id, version, operation, metadata.json]);
  if (eventType) {
    const payload = jsonSnapshot({ subject_principal: context.subject_principal, authn_kind: context.authn_kind,
      scope: context.scope, aggregate_type: aggregateType, aggregate_id: id, aggregate_version: version, data: metadata.value }, MAX_JSON_BYTES);
    await q.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
      VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), transition, context.scope.scope_id, context.scope.kind, eventType, payload.json]);
  }
}
