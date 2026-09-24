// Import-safe acceptance checks for the Cloudflare candidate origins.
// Importing this module performs no network, file or environment access.
// Reports contain whitelisted metadata only: no response bodies, cookies,
// passwords, Access headers, CSRF/OAuth values, member ids or member content.
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { runMessagesMobile, runMessagesPhase, runRegistrationPhase, type MemberRunState } from './verify-cloud-candidate-members.js';
export { guildChannelsRealHistoryGuarded } from './verify-cloud-candidate-members.js';

export const TOOL_VERSION = 'cloud-candidate-acceptance/1';
export type Mode = 'staging' | 'public' | 'local';
export type Target = Readonly<{ name: string; origin: string; mode: Mode; harness: 'cloud_candidate' | 'local_harness' }>;

/** The only origins the CLI can ever address. Old live hosts are deliberately absent. */
export const CANDIDATES: Readonly<Record<string, Target>> = Object.freeze({
  'staging-next': Object.freeze({ name: 'staging-next', origin: 'https://staging-next.freetwai.com', mode: 'staging', harness: 'cloud_candidate' }),
  next: Object.freeze({ name: 'next', origin: 'https://next.freetwai.com', mode: 'public', harness: 'cloud_candidate' }),
});

/** Accepts a candidate name or its exact origin (optionally with one trailing slash); nothing else. */
export function candidateTarget(value: string): Target {
  if (typeof value !== 'string') throw new UsageError('target must be staging-next or next');
  const named = Object.hasOwn(CANDIDATES, value) ? CANDIDATES[value] : undefined;
  if (named) return named;
  const found = Object.values(CANDIDATES).find(target => value === target.origin || value === target.origin + '/');
  if (!found) throw new UsageError('target must be staging-next, next, https://staging-next.freetwai.com or https://next.freetwai.com');
  return found;
}

/**
 * Loopback HTTP target for the isolated local harness only. The CLI never calls
 * this; its reports say local_harness and cloud_proof=false.
 */
export function localHarnessTarget(origin: string): Target {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || origin !== url.origin) throw new UsageError('local harness requires http://127.0.0.1:<port>');
  return Object.freeze({ name: 'local-harness', origin: url.origin, mode: 'local', harness: 'local_harness' });
}

export class UsageError extends Error { override name = 'UsageError'; }
class CheckFailed extends Error { override name = 'CheckFailed'; constructor(readonly check: string) { super(check); } }
class NotRun extends Error { override name = 'NotRun'; constructor(readonly reason: string) { super(reason); } }
/** Thrown before any request leaves for a non-candidate URL. */
export class OriginGuardError extends Error { override name = 'OriginGuardError'; }

export const PHASES = ['preflight', 'health', 'protocol', 'assets', 'anonymous', 'session', 'browser', 'guild-cache', 'github-handoff', 'avatar', 'registration', 'messages', 'messages-mobile', 'load', 'logout'] as const;
export type PhaseId = typeof PHASES[number];
export const READ_ONLY_PHASES: readonly PhaseId[] = ['preflight', 'health', 'protocol', 'assets', 'anonymous'];
/** Later phases run only after every dependency passed. `load` stays independent; `logout` stays last and has none. */
export const PHASE_DEPENDENCIES: Partial<Record<PhaseId, readonly PhaseId[]>> = {
  health: ['preflight'], protocol: ['preflight'], assets: ['preflight'], anonymous: ['preflight'], load: ['preflight'],
  session: ['health'], browser: ['health'], 'guild-cache': ['session'], 'github-handoff': ['session'], avatar: ['session'],
  registration: ['health'], messages: ['registration'], 'messages-mobile': ['messages'],
};
const NEEDS_ACCOUNT: readonly PhaseId[] = ['session', 'browser', 'guild-cache', 'github-handoff', 'avatar', 'logout'];
/** Registration and messaging provision their own members and ignore an account file. */
export function accountFileRequired(phases: readonly PhaseId[]) {
  return phases.some(id => NEEDS_ACCOUNT.includes(id));
}
export const WRITE_DESCRIPTIONS: Partial<Record<PhaseId, string>> = {
  session: 'creates and revokes sessions of the dedicated synthetic account',
  browser: 'creates and revokes one browser session of the dedicated synthetic account',
  'guild-cache': 'joins then leaves one non-primary AI guild of the dedicated synthetic account; leaves a left-state membership row, retained skill-book grants and command receipts',
  'github-handoff': 'creates one unconsumed OAuth state row (expires in 10 minutes); the provider URL is never requested',
  avatar: 'uploads then removes a generated avatar of the dedicated synthetic account',
  registration: 'registers one synthetic cand-reg member, completes positioning and one primary guild, then revokes that member\'s sessions',
  messages: 'registers a second synthetic member, creates one squad containing only those two members, and writes direct and squad messages; guild-channel writes run only when the target is not next',
  'messages-mobile': 'opens one mobile browser session of the synthetic member registered in this run and sends one direct message',
  logout: 'revokes the tool session',
};

/** Full lowercase commit SHA, exactly as the Worker adapter accepts and reports FREEDOM_RELEASE_SHA. */
export const RELEASE_SHA = /^[0-9a-f]{40}$/;
export const WORKER_RUNTIME = 'cloudflare-workers';
/** Exact /api/v1/health keys per harness: the Worker adds runtime and release_sha; the local Node server does not. */
export const HEALTH_FIELDS: Readonly<Record<Target['harness'], readonly string[]>> = Object.freeze({
  cloud_candidate: Object.freeze(['mode', 'money_movement_enabled', 'official', 'release_sha', 'runtime', 'status', 'version']),
  local_harness: Object.freeze(['mode', 'money_movement_enabled', 'official', 'status', 'version']),
});
const validReleaseSha = (value: unknown): value is string => typeof value === 'string' && RELEASE_SHA.test(value);

export const LOAD_LIMITS = Object.freeze({
  requests: { default: 60, min: 1, max: 600 },
  concurrency: { default: 4, min: 1, max: 16 },
  rps: { default: 10, min: 1, max: 30 },
  timeoutMs: { default: 10000, min: 1000, max: 30000 },
});
export type LoadOptions = { requests: number; concurrency: number; rps: number; timeoutMs: number; maxErrorRate: number; maxP95Ms: number };
export const LOAD_PATHS = Object.freeze(['/api/v1/health', '/brand/freedom-workshop.webp', '/art/rpg/workshop-hub.webp']);
export const ASSET_PATHS = Object.freeze(['/brand/freedom-workshop.webp', ...['workshop-hub', 'skill-codex', 'cooperation-forge', 'market-network'].map(name => `/art/rpg/${name}.webp`)]);
export const DEVELOPMENT_GUILDS = Object.freeze(['guild_ai_vibe', 'guild_ai_field']);
const SESSION_COOKIE = 'freedom_local_session';
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function loadOptions(raw: Partial<Record<keyof LoadOptions, number>> = {}): LoadOptions {
  const bounded = (key: keyof typeof LOAD_LIMITS) => {
    const limit = LOAD_LIMITS[key], value = raw[key] ?? limit.default;
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) throw new UsageError(`${key} must be an integer ${limit.min}-${limit.max}`);
    return value;
  };
  const maxErrorRate = raw.maxErrorRate ?? 0.01, maxP95Ms = raw.maxP95Ms ?? 2000;
  if (!(maxErrorRate >= 0 && maxErrorRate <= 0.5)) throw new UsageError('maxErrorRate must be 0-0.5');
  if (!Number.isInteger(maxP95Ms) || maxP95Ms < 50 || maxP95Ms > 30000) throw new UsageError('maxP95Ms must be an integer 50-30000');
  return { requests: bounded('requests'), concurrency: bounded('concurrency'), rps: bounded('rps'), timeoutMs: bounded('timeoutMs'), maxErrorRate, maxP95Ms };
}

// ---------------------------------------------------------------- redaction
/** Collects every secret-like value seen during a run; the report is scrubbed against it. */
export class Secrets {
  private values = new Set<string>();
  /** Records the raw, URI-encoded and JSON-string-escaped forms, so quotes, backslashes and control characters cannot hide a value. */
  add(value: unknown) {
    if (typeof value !== 'string' || value.length < 6) return;
    for (const form of [value, encodeURIComponent(value)]) { this.values.add(form); this.values.add(JSON.stringify(form).slice(1, -1)); }
  }
  redact(text: string) {
    let hit = false;
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) if (text.includes(value)) { hit = true; text = text.split(value).join('[REDACTED]'); }
    return { text, hit };
  }
  /** Scrubs every string (keys and values) of a JSON-safe tree, so the result is always valid JSON. */
  scrub<T>(tree: T): { value: T; hit: boolean } {
    let hit = false;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') { const out = this.redact(node); hit ||= out.hit; return out.text; }
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [walk(key), walk(item)]));
      return node;
    };
    return { value: walk(JSON.parse(JSON.stringify(tree))) as T, hit };
  }
}
/** Error metadata only: class name and a short system code; never messages, URLs or stacks. */
export function describeError(error: unknown): string {
  if (error instanceof CheckFailed) return error.check;
  if (error instanceof OriginGuardError) return 'origin_guard';
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code;
  return typeof cause === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause) ? `${name}:${cause}` : name;
}
const safeCode = (value: unknown) => typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unrecognized';

// ---------------------------------------------------------------- cookies
export type SetCookie = { name: string; value: string; secure: boolean; httpOnly: boolean; sameSite: string | null; path: string | null; domain: string | null; maxAge: number | null; expires: string | null };
export function parseSetCookie(line: string): SetCookie | null {
  const [pair, ...attributes] = line.split(';');
  const index = pair.indexOf('=');
  if (index < 1) return null;
  const cookie: SetCookie = { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), secure: false, httpOnly: false, sameSite: null, path: null, domain: null, maxAge: null, expires: null };
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('='), key = rawKey.trim().toLowerCase(), value = rest.join('=').trim();
    if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = value.toLowerCase();
    else if (key === 'path') cookie.path = value;
    else if (key === 'domain') cookie.domain = value;
    else if (key === 'max-age') cookie.maxAge = Number(value);
    else if (key === 'expires') cookie.expires = value;
  }
  return cookie;
}
/** Candidate session cookie policy; metadata only (never the value). */
export function sessionCookieChecks(cookie: SetCookie | null, target: Target) {
  const https = new URL(target.origin).protocol === 'https:';
  return {
    present: Boolean(cookie?.value),
    secure: https ? cookie?.secure === true : true,
    http_only: cookie?.httpOnly === true,
    same_site_strict: cookie?.sameSite === 'strict',
    path_root: cookie?.path === '/',
    host_only: cookie?.domain === null,
  };
}

// ---------------------------------------------------------------- HTTP
export type TransportRequest = { method: string; url: string; headers: Record<string, string>; body?: Uint8Array | string; timeoutMs: number };
export type TransportResponse = { status: number; headers: Headers; body: Uint8Array };
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** Node fetch that never follows redirects and caps the response size. */
export const fetchTransport: Transport = async request => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body as BodyInit | undefined, redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs) });
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw Object.assign(new Error('body limit'), { name: 'BodyTooLarge' }); }
    chunks.push(value);
  }
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
};

export type AccessCredential = { clientId: string; clientSecret: string };
export type Account = { email: string; password: string; label: string };
type RequestOptions = { json?: unknown; bytes?: Uint8Array; contentType?: string; origin?: 'same' | 'none' | string; csrf?: string | null; ifMatch?: string | number; idempotency?: boolean | string; session?: boolean; access?: boolean };
export type Reply = { status: number; headers: Headers; bytes: number; ms: number; json(): any; setCookies(): SetCookie[]; location: string | null };

/** Exact-origin client: one session cookie jar; Access headers only on the exact candidate origin. */
export class CandidateClient {
  private session: string | null = null;
  csrf: string | null = null;
  requests = 0;
  constructor(readonly target: Target, private transport: Transport, private access: AccessCredential | null, private secrets: Secrets, private timeoutMs = 15000) {}
  hasSession() { return this.session !== null; }
  url(path: string) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\s#]/.test(path)) throw new OriginGuardError('path');
    const url = new URL(path, this.target.origin);
    if (url.origin !== this.target.origin || url.username || url.password) throw new OriginGuardError('origin');
    return url.href;
  }
  async request(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    const url = this.url(path), headers: Record<string, string> = { Accept: 'application/json, image/*;q=0.9, */*;q=0.1' };
    if (options.access !== false && this.access) { headers['CF-Access-Client-Id'] = this.access.clientId; headers['CF-Access-Client-Secret'] = this.access.clientSecret; }
    if (options.session !== false && this.session) headers.Cookie = `${SESSION_COOKIE}=${this.session}`;
    const origin = options.origin ?? (method === 'GET' || method === 'HEAD' ? 'none' : 'same');
    if (origin === 'same') headers.Origin = this.target.origin; else if (origin !== 'none') headers.Origin = origin;
    const csrf = options.csrf === undefined ? this.csrf : options.csrf;
    if (method !== 'GET' && method !== 'HEAD' && csrf) headers['X-CSRF-Token'] = csrf;
    if (options.ifMatch !== undefined) headers['If-Match'] = `"${options.ifMatch}"`;
    if (options.idempotency) headers['Idempotency-Key'] = typeof options.idempotency === 'string' ? options.idempotency : randomUUID();
    let body: Uint8Array | string | undefined;
    if (options.bytes) { body = options.bytes; headers['Content-Type'] = options.contentType ?? 'application/octet-stream'; }
    else if (options.json !== undefined) { body = JSON.stringify(options.json); headers['Content-Type'] = 'application/json'; }
    const started = performance.now();
    this.requests++;
    const response = await this.transport({ method, url, headers, body, timeoutMs: this.timeoutMs });
    const ms = performance.now() - started;
    const setCookies = () => response.headers.getSetCookie().map(parseSetCookie).filter((cookie): cookie is SetCookie => cookie !== null);
    for (const cookie of setCookies()) {
      this.secrets.add(cookie.value);
      if (cookie.name !== SESSION_COOKIE) continue; // Only the product session is kept.
      const cleared = !cookie.value || (cookie.maxAge !== null && cookie.maxAge <= 0) || (cookie.expires !== null && Date.parse(cookie.expires) <= Date.now());
      this.session = cleared ? null : cookie.value;
      if (cleared) this.csrf = null;
    }
    let parsed: unknown, parsedOnce = false;
    return {
      status: response.status, headers: response.headers, bytes: response.body.byteLength, ms, setCookies,
      location: response.headers.get('location'),
      json: () => {
        if (!parsedOnce) { parsedOnce = true; try { parsed = JSON.parse(Buffer.from(response.body).toString('utf8')); } catch { parsed = undefined; } }
        return parsed;
      },
    };
  }
  /** A separate cookie jar for the same origin and Access credential. */
  withoutSession() { return new CandidateClient(this.target, this.transport, this.access, this.secrets, this.timeoutMs); }
  /** A second client carrying the same session cookie, used to prove revocation fails closed. */
  withSameSession() { const copy = new CandidateClient(this.target, this.transport, this.access, this.secrets, this.timeoutMs); copy.session = this.session; return copy; }
  /** A client carrying a session cookie taken from elsewhere (the browser jar), used only to revoke it. */
  withSession(value: string) { const copy = this.withoutSession(); this.secrets.add(value); copy.session = value; return copy; }
}

// ---------------------------------------------------------------- report
export type Status = 'pass' | 'fail' | 'not_run' | 'blocked';
export type Overall = Status | 'incomplete';
export type Check = { id: string; status: 'pass' | 'fail'; note?: string };
export type PhaseReport = { id: PhaseId; status: Status; reason?: string; writes?: string; checks: Check[]; metrics?: Record<string, unknown>; duration_ms?: number };
export type CleanupItem = { phase: PhaseId; item: string; state: 'restored' | 'cleanup_required' | 'residual_expected' | 'restore_failed' };
export type Report = {
  tool: string; report_kind: 'cloud_candidate_acceptance'; run: 'plan' | 'execute'; harness: Target['harness']; cloud_proof: boolean;
  statement: string; target: { name: string; origin: string; expected_mode: Mode }; expected_version: string | null; expected_release_sha: string | null;
  account_label: string | null; access_credential: 'provided' | 'absent' | 'not_read'; started_at: string; finished_at: string;
  overall: Overall; phases_selected: PhaseId[]; phases: PhaseReport[]; cleanup: { required: boolean; items: CleanupItem[] }; load_thresholds?: LoadOptions; redaction_applied: boolean;
};

function statement(target: Target, run: 'plan' | 'execute') {
  if (target.harness === 'local_harness') return 'Local harness run against an isolated loopback server. Tests the tool only; it is not evidence of any cloud deployment.';
  if (run === 'plan') return 'Plan only: no network request was made. Every remote phase is not_run until an operator executes it against a provisioned candidate.';
  return 'Executed against the candidate origin. Only phases marked pass were observed; not_run and blocked phases prove nothing.';
}

export type RunOptions = {
  target: Target; run: 'plan' | 'execute'; phases: PhaseId[]; expectedVersion: string | null; contract: unknown;
  /** Required for cloud_candidate health: the Worker's release_sha must equal it. Unused by the local Node harness. */
  expectedReleaseSha?: string | null;
  account?: Account | null; access?: AccessCredential | null; transport?: Transport; load?: LoadOptions; developmentBook?: string; developmentGuild?: string;
  browser?: BrowserLike | null; now?: () => Date; log?: (line: string) => void;
  /** Bound on waiting for in-flight browser route handlers at teardown (default 15000 ms). */
  browserDrainMs?: number;
};
export type BrowserLike = { newContext(options?: Record<string, unknown>): Promise<any> };

export function selectPhases(requested: readonly string[] | null): PhaseId[] {
  const list = requested ?? READ_ONLY_PHASES;
  // Fixed text: an argv value pasted by mistake (possibly a secret) is never echoed.
  for (const id of list) if (!(PHASES as readonly string[]).includes(id)) throw new UsageError('unknown phase');
  const selected = new Set<PhaseId>(['preflight', ...(list as PhaseId[])]);
  // Every network run first verifies the Worker identity and release in health.
  if ([...selected].some(id => id !== 'preflight')) selected.add('health');
  // API phases share one tool session: select its login and its logout with them.
  if ((['session', 'guild-cache', 'github-handoff', 'avatar', 'logout'] as PhaseId[]).some(id => selected.has(id))) { selected.add('session'); selected.add('logout'); }
  return PHASES.filter(id => selected.has(id));
}

export function planReport(options: Omit<RunOptions, 'run'>): Report {
  const started = (options.now ?? (() => new Date()))().toISOString();
  const shaMissing = options.target.harness === 'cloud_candidate' && !validReleaseSha(options.expectedReleaseSha);
  const reason = (id: PhaseId) => id === 'preflight' ? 'plan_only' : !options.phases.includes(id) ? 'not_selected' : id === 'health' && shaMissing ? 'plan_only_execute_requires_expected_release_sha' : 'plan_only';
  const phases: PhaseReport[] = PHASES.map(id => ({ id, status: 'not_run', reason: reason(id), ...(WRITE_DESCRIPTIONS[id] ? { writes: WRITE_DESCRIPTIONS[id] } : {}), checks: [] }));
  return finish(options.target, 'plan', options, phases, [], started, new Secrets(), options.now);
}

function finish(target: Target, run: 'plan' | 'execute', options: Omit<RunOptions, 'run'>, phases: PhaseReport[], cleanup: CleanupItem[], started: string, secrets: Secrets, now?: () => Date): Report {
  const selected = phases.filter(phase => options.phases.includes(phase.id));
  const overall: Overall = run === 'plan' ? 'not_run' : selected.some(p => p.status === 'fail') ? 'fail' : selected.some(p => p.status === 'blocked') ? 'blocked'
    : selected.every(p => p.status === 'pass') ? 'pass' : selected.some(p => p.status === 'pass') ? 'incomplete' : 'not_run';
  const report: Report = {
    tool: TOOL_VERSION, report_kind: 'cloud_candidate_acceptance', run, harness: target.harness,
    // Preflight is offline; only a passed health (Worker runtime and expected release_sha) ties the run to a deployment.
    cloud_proof: run === 'execute' && target.harness === 'cloud_candidate' && overall === 'pass' && validReleaseSha(options.expectedReleaseSha) && selected.some(p => p.id === 'health' && p.status === 'pass'),
    statement: statement(target, run), target: { name: target.name, origin: target.origin, expected_mode: target.mode },
    expected_version: options.expectedVersion, expected_release_sha: options.expectedReleaseSha ?? null, account_label: options.account?.label ?? null, access_credential: run === 'plan' ? 'not_read' : options.access ? 'provided' : 'absent',
    started_at: started, finished_at: (now ?? (() => new Date()))().toISOString(), overall, phases_selected: [...options.phases], phases,
    cleanup: { required: cleanup.some(item => item.state === 'cleanup_required' || item.state === 'restore_failed'), items: cleanup },
    ...(options.phases.includes('load') ? { load_thresholds: options.load ?? loadOptions() } : {}),
    redaction_applied: false,
  };
  const { value: clean, hit } = secrets.scrub(report);
  clean.redaction_applied = hit;
  return clean;
}

// ---------------------------------------------------------------- load metrics
export type LoadSample = { status: number | null; error: string | null; ms: number };
export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] * 10) / 10;
}
/** Reports what actually ran; with no samples every rate and percentile is null, never zero. */
export function summarizeLoad(samples: LoadSample[], durationMs: number) {
  const statuses: Record<string, number> = {}, errors: Record<string, number> = {};
  for (const sample of samples) {
    if (sample.status === null) errors[sample.error ?? 'Error'] = (errors[sample.error ?? 'Error'] ?? 0) + 1;
    else statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
  }
  const failed = samples.filter(sample => sample.status === null || sample.status >= 400 || (sample.status >= 300 && sample.status < 400)).length;
  const latencies = samples.filter(sample => sample.status !== null).map(sample => sample.ms).sort((a, b) => a - b);
  return {
    requests: samples.length, status_counts: statuses, network_errors: errors, failed,
    error_rate: samples.length ? Math.round((failed / samples.length) * 10000) / 10000 : null,
    p50_ms: percentile(latencies, 50), p95_ms: percentile(latencies, 95), p99_ms: percentile(latencies, 99),
    duration_ms: Math.round(durationMs), achieved_rps: samples.length && durationMs > 0 ? Math.round((samples.length / (durationMs / 1000)) * 100) / 100 : null,
  };
}

export async function runLoad(client: CandidateClient, options: LoadOptions) {
  const samples: LoadSample[] = [], interval = 1000 / options.rps, started = performance.now();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= options.requests) return;
      const wait = started + index * interval - performance.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      const began = performance.now();
      try {
        const reply = await client.request('GET', LOAD_PATHS[index % LOAD_PATHS.length], { session: false });
        samples.push({ status: reply.status, error: null, ms: reply.ms });
      } catch (error) {
        if (error instanceof OriginGuardError) throw error;
        samples.push({ status: null, error: describeError(error), ms: performance.now() - began });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.requests) }, worker));
  return summarizeLoad(samples, performance.now() - started);
}

/** Minimal valid 320x240 PNG generated in memory for the avatar phase. */
export function syntheticPng(width = 320, height = 240) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([0x30, 0x44, 0xff], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- executor
type PhaseContext = { check(id: string, condition: boolean, note?: string): void; metric(key: string, value: unknown): void; skip(reason: string): never; cleanup(item: string, state: CleanupItem['state']): void };

const noStore = (reply: Reply) => /(^|,)\s*no-store\s*(,|$)/i.test(reply.headers.get('cache-control') ?? '');
const isJson = (reply: Reply) => (reply.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
/** Remote metadata is kept whole (so the final scrub sees every secret) or omitted; never truncated or case-folded. */
const bounded = (value: unknown, max: number) => typeof value !== 'string' ? null : value.length <= max ? value : 'omitted_too_long';
const edge = (reply: Reply) => ({ cf_cache_status: /^[A-Z]{3,12}$/.test(reply.headers.get('cf-cache-status') ?? '') ? reply.headers.get('cf-cache-status') : null, cf_ray_present: reply.headers.has('cf-ray') });
function accessChallenge(reply: Reply) {
  if (reply.status < 300 || reply.status >= 400 || !reply.location) return false;
  try { return new URL(reply.location, 'https://invalid.invalid').hostname.endsWith('.cloudflareaccess.com'); } catch { return false; }
}

export async function runCandidate(options: RunOptions): Promise<Report> {
  if (options.run === 'plan') return planReport(options);
  const { target } = options, now = options.now ?? (() => new Date()), log = options.log ?? (() => {});
  const started = now().toISOString(), secrets = new Secrets(), cleanup: CleanupItem[] = [];
  const load = options.load ?? loadOptions();
  const account = options.account ?? null, access = options.access ?? null;
  if (account) { secrets.add(account.password); secrets.add(account.email); }
  if (access) { secrets.add(access.clientId); secrets.add(access.clientSecret); }
  const transport = options.transport ?? fetchTransport;
  const client = new CandidateClient(target, transport, access, secrets);
  const results = new Map<PhaseId, PhaseReport>();

  const login = async (session: CandidateClient) => {
    if (!account) throw new CheckFailed('account_required');
    const reply = await session.request('POST', '/api/v1/auth/login', { json: { email: account.email, password: account.password }, csrf: null });
    if (reply.status !== 200) throw new CheckFailed(`login_status_${reply.status}`);
    const body = reply.json();
    secrets.add(body?.csrf_token); secrets.add(body?.user?.user_id);
    if (typeof body?.csrf_token !== 'string' || !session.hasSession()) throw new CheckFailed('login_session_missing');
    if (String(body?.user?.email ?? '').toLowerCase() !== account.email.toLowerCase()) throw new CheckFailed('login_account_mismatch');
    session.csrf = body.csrf_token;
    return { reply, userId: String(body.user.user_id) };
  };
  let userId: string | null = null;
  const members: MemberRunState = { primary: null, peer: null, lastDirectBody: null };

  const phases: Record<PhaseId, (ctx: PhaseContext) => Promise<void>> = {
    async preflight(ctx) {
      ctx.check('target_allowlisted', target.harness === 'local_harness' || Object.values(CANDIDATES).some(c => c.origin === target.origin && c.mode === target.mode));
      ctx.check('expected_version_set', typeof options.expectedVersion === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(options.expectedVersion));
      // Checked before any request: a cloud health run without the expected release cannot prove provenance.
      const sha = options.expectedReleaseSha ?? null;
      ctx.check('expected_release_sha_set', target.harness === 'local_harness' || !options.phases.includes('health') ? sha === null || validReleaseSha(sha) : validReleaseSha(sha), 'execute requires a full lowercase 40-hex expected release SHA');
      ctx.check('local_contract_loaded', !!options.contract && typeof (options.contract as { protocol?: unknown }).protocol === 'string');
      const needsAccount = accountFileRequired(options.phases);
      ctx.check('account_available_when_needed', !needsAccount || !!account, needsAccount ? 'selected phases need a dedicated synthetic account' : undefined);
      ctx.metric('network_requests', 0);
    },
    async health(ctx) {
      const reply = await client.request('GET', '/api/v1/health', { session: false });
      ctx.metric('edge', edge(reply)); ctx.metric('ms', Math.round(reply.ms));
      ctx.check('no_redirect', reply.status < 300 || reply.status >= 400, accessChallenge(reply) ? 'access_challenge' : undefined);
      ctx.check('status_200', reply.status === 200, `status ${reply.status}`);
      ctx.check('json', isJson(reply)); ctx.check('no_store', noStore(reply));
      const body = reply.json() ?? {};
      ctx.check('exact_fields', isDeepStrictEqual(Object.keys(body).sort(), HEALTH_FIELDS[target.harness]), target.harness === 'cloud_candidate' ? 'expected Worker health shape' : 'expected local Node health shape');
      ctx.metric('mode', bounded(body.mode, 16));
      ctx.metric('version', bounded(body.version, 64));
      ctx.check('status_ok', body.status === 'ok');
      ctx.check('mode_matches_target', body.mode === target.mode, `expected ${target.mode}`);
      ctx.check('version_matches_expected', body.version === options.expectedVersion);
      ctx.check('money_movement_disabled', body.money_movement_enabled === false);
      ctx.check('not_official', body.official === false);
      if (target.harness === 'local_harness') { ctx.metric('provenance', 'not_asserted_local_node'); return; }
      ctx.check('runtime_cloudflare_workers', body.runtime === WORKER_RUNTIME);
      ctx.check('release_sha_matches_expected', validReleaseSha(body.release_sha) && body.release_sha === options.expectedReleaseSha);
      // Reported only after validation, so it is always the known expected value.
      ctx.metric('provenance', { runtime: WORKER_RUNTIME, release_sha: options.expectedReleaseSha });
    },
    async protocol(ctx) {
      const reply = await client.request('GET', '/api/v1/protocol', { session: false });
      ctx.check('status_200', reply.status === 200, `status ${reply.status}`);
      ctx.check('matches_local_contract', isDeepStrictEqual(reply.json(), options.contract));
      const contract = options.contract as { protocol?: string; revision?: string };
      ctx.metric('protocol', contract.protocol ?? null); ctx.metric('revision', contract.revision ?? null);
    },
    async assets(ctx) {
      const assets: Record<string, unknown>[] = [];
      for (const path of ASSET_PATHS) {
        const reply = await client.request('GET', path, { session: false });
        const type = (reply.headers.get('content-type') ?? '').toLowerCase();
        assets.push({ path, status: reply.status, bytes: reply.bytes, content_type: bounded(reply.headers.get('content-type') ?? '', 40), cache_control: bounded(reply.headers.get('cache-control') ?? '', 80), ...edge(reply) });
        ctx.metric('assets', assets);
        ctx.check(`${path}:status_200`, reply.status === 200, `status ${reply.status}`);
        ctx.check(`${path}:image_webp`, type.startsWith('image/webp'));
        ctx.check(`${path}:non_empty`, reply.bytes > 1000);
      }
    },
    async anonymous(ctx) {
      if (access) {
        const gate = await client.request('GET', '/', { session: false, access: false });
        ctx.check('access_gate_challenges_unauthenticated', accessChallenge(gate) || gate.status === 401 || gate.status === 403, `status ${gate.status}`);
      } else ctx.metric('access_gate', target.mode === 'staging' ? 'not_checked_without_access_credential' : 'not_applicable');
      for (const path of ['/api/v1/session', '/api/v1/me/guild-preferences', '/api/v1/me/development/skill/' + (options.developmentBook ?? 'video-autopilot')]) {
        const reply = await client.request('GET', path, { session: false });
        ctx.check(`${path}:401`, reply.status === 401, `status ${reply.status}`);
        ctx.check(`${path}:login_required`, reply.json()?.code === 'login_required');
        ctx.check(`${path}:no_store`, noStore(reply));
        ctx.check(`${path}:no_cookie_set`, !reply.setCookies().some(cookie => cookie.name === SESSION_COOKIE && cookie.value));
      }
      // Origin enforcement is checked on login before any credential is sent.
      for (const [label, origin] of [['missing_origin', 'none'], ['foreign_origin', 'https://attacker.invalid'], ['old_live_origin', 'https://freetwai.com']] as const) {
        if (origin === target.origin) continue;
        const reply = await client.request('POST', '/api/v1/auth/login', { json: {}, origin, session: false, csrf: null });
        ctx.check(`login_${label}_rejected`, reply.status === 403 && reply.json()?.code === 'origin_rejected', `status ${reply.status} ${safeCode(reply.json()?.code)}`);
      }
    },
    async session(ctx) {
      const { reply } = await login(client).catch(error => { throw error instanceof CheckFailed ? error : new CheckFailed(`login_${describeError(error)}`); });
      const cookie = reply.setCookies().find(value => value.name === SESSION_COOKIE) ?? null;
      for (const [id, ok] of Object.entries(sessionCookieChecks(cookie, target))) ctx.check(`cookie_${id}`, ok);
      ctx.check('login_no_store', noStore(reply));
      const first = await client.request('GET', '/api/v1/session'), second = await client.request('GET', '/api/v1/session');
      userId = first.json()?.user?.user_id ?? null; secrets.add(userId);
      ctx.check('session_read_200', first.status === 200 && second.status === 200);
      ctx.check('session_reload_same_account', !!userId && second.json()?.user?.user_id === userId);
      ctx.check('session_no_store', noStore(first) && noStore(second));
      const wrong = randomBytes(32).toString('base64url');
      for (const [label, csrf] of [['missing', null], ['wrong', wrong]] as const) {
        const rejected = await client.request('POST', '/api/v1/auth/logout', { json: {}, csrf });
        ctx.check(`csrf_${label}_rejected`, rejected.status === 403 && rejected.json()?.code === 'csrf_rejected', `status ${rejected.status}`);
      }
      const foreign = await client.request('POST', '/api/v1/auth/logout', { json: {}, origin: 'https://attacker.invalid' });
      ctx.check('foreign_origin_with_csrf_rejected', foreign.status === 403 && foreign.json()?.code === 'origin_rejected', `status ${foreign.status}`);
      const still = await client.request('GET', '/api/v1/session');
      ctx.check('session_survives_rejected_writes', still.status === 200);
    },
    async browser(ctx) { await browserPhase(ctx, options, target, access, account, secrets, client); },
    async 'guild-cache'(ctx) { await guildPhase(ctx, client, options, login, log); },
    async 'github-handoff'(ctx) {
      const status = await client.request('GET', '/api/v1/me/github');
      ctx.check('github_status_200', status.status === 200, `status ${status.status}`);
      const github = status.json() ?? {};
      ctx.metric('configured', github.configured === true); ctx.metric('connected', github.connected === true);
      if (github.configured !== true) ctx.skip('github_oauth_not_configured_on_candidate');
      if (github.connected === true) ctx.skip('synthetic_account_already_connected; not disturbing provider link');
      const reply = await client.request('POST', '/api/v1/me/github/connect', { json: { return_to: '#guilds' } });
      ctx.check('connect_200', reply.status === 200, `status ${reply.status} ${safeCode(reply.json()?.code)}`);
      const raw = reply.json()?.authorization_url;
      secrets.add(raw);
      let url: URL | null = null;
      try { url = new URL(String(raw)); } catch { url = null; }
      for (const key of ['state', 'code_challenge', 'client_id']) secrets.add(url?.searchParams.get(key) ?? '');
      ctx.check('provider_origin_github', url?.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize');
      ctx.check('callback_is_candidate_origin', url?.searchParams.get('redirect_uri') === target.origin + '/github/callback');
      ctx.check('state_present', /^[A-Za-z0-9_-]{43}$/.test(url?.searchParams.get('state') ?? ''));
      ctx.check('pkce_s256', url?.searchParams.get('code_challenge_method') === 'S256' && !!url?.searchParams.get('code_challenge'));
      ctx.check('client_id_present', !!url?.searchParams.get('client_id'));
      ctx.metric('provider_url_requested', false); ctx.metric('consent_submitted', false);
      ctx.cleanup('unconsumed OAuth state row (expires after 10 minutes)', 'residual_expected');
    },
    async registration(ctx) {
      await runRegistrationPhase({ ctx, openClient: () => client.withoutSession(), target, secrets, state: members, developmentGuilds: DEVELOPMENT_GUILDS, cookieChecks: sessionCookieChecks });
    },
    async messages(ctx) {
      await runMessagesPhase({ ctx, openClient: () => client.withoutSession(), target, secrets, state: members, developmentGuilds: DEVELOPMENT_GUILDS, cookieChecks: sessionCookieChecks });
    },
    async 'messages-mobile'(ctx) { await messagesMobilePhase(ctx, options, target, access, secrets, client, members); },
    async avatar(ctx) {
      const before = await client.request('GET', '/api/v1/me/avatar');
      ctx.check('avatar_status_200', before.status === 200, `status ${before.status}`);
      if (before.json()?.avatar_url !== null) ctx.skip('synthetic_account_already_has_avatar; not overwriting');
      let version = before.json()?.aggregate_version, uploaded = false;
      try {
        const upload = await client.request('POST', '/api/v1/me/avatar', { bytes: syntheticPng(), contentType: 'image/png', ifMatch: version, idempotency: true });
        ctx.check('upload_200', upload.status === 200, `status ${upload.status} ${safeCode(upload.json()?.code)}`);
        uploaded = true; version = upload.json()?.aggregate_version;
        const avatarUrl = upload.json()?.avatar_url;
        secrets.add(avatarUrl);
        ctx.check('avatar_url_same_origin_path', typeof avatarUrl === 'string' && /^\/api\/v1\/members\/[0-9a-f-]{36}\/avatar\?v=[1-9][0-9]*$/.test(avatarUrl));
        const image = await client.request('GET', avatarUrl);
        ctx.check('image_200', image.status === 200); ctx.check('image_webp', (image.headers.get('content-type') ?? '').startsWith('image/webp'));
        ctx.check('image_non_empty', image.bytes > 100); ctx.check('image_private_no_store', /private/.test(image.headers.get('cache-control') ?? '') && noStore(image));
        ctx.metric('image_bytes', image.bytes);
        const anonymous = await client.request('GET', avatarUrl, { session: false });
        ctx.check('image_anonymous_401', anonymous.status === 401);
        const removed = await client.request('POST', '/api/v1/me/avatar/remove', { json: {}, ifMatch: version, idempotency: true });
        ctx.check('remove_200', removed.status === 200); uploaded = removed.status !== 200;
        ctx.check('old_url_404', (await client.request('GET', avatarUrl)).status === 404);
      } finally {
        if (uploaded) {
          const current = await client.request('GET', '/api/v1/me/avatar').catch(() => null);
          const retry = current ? await client.request('POST', '/api/v1/me/avatar/remove', { json: {}, ifMatch: current.json()?.aggregate_version, idempotency: true }).catch(() => null) : null;
          ctx.cleanup('generated avatar', retry?.status === 200 ? 'restored' : 'restore_failed');
        } else ctx.cleanup('generated avatar', 'restored');
      }
    },
    async load(ctx) {
      const summary = await runLoad(new CandidateClient(target, transport, access, secrets, load.timeoutMs), load);
      for (const [key, value] of Object.entries(summary)) ctx.metric(key, value);
      ctx.check('requests_completed', summary.requests === load.requests);
      ctx.check('error_rate_within_threshold', summary.error_rate !== null && summary.error_rate <= load.maxErrorRate, `threshold ${load.maxErrorRate}`);
      ctx.check('p95_within_threshold', summary.p95_ms !== null && summary.p95_ms <= load.maxP95Ms, `threshold ${load.maxP95Ms} ms`);
    },
    async logout(ctx) {
      if (!client.hasSession()) ctx.skip('no_tool_session');
      const stale = client.withSameSession();
      const reply = await client.request('POST', '/api/v1/auth/logout', { json: {} });
      ctx.check('logout_200', reply.status === 200, `status ${reply.status}`);
      ctx.check('cookie_cleared', !client.hasSession());
      ctx.check('logout_no_store', noStore(reply));
      // Replaying the revoked cookie must fail closed.
      const replay = await stale.request('GET', '/api/v1/session');
      ctx.check('revoked_cookie_rejected', replay.status === 401 && replay.json()?.code === 'session_expired', `status ${replay.status}`);
    },
  };

  for (const id of PHASES) {
    const writes = WRITE_DESCRIPTIONS[id] ? { writes: WRITE_DESCRIPTIONS[id] } : {};
    if (!options.phases.includes(id)) { results.set(id, { id, status: 'not_run', reason: 'not_selected', ...writes, checks: [] }); continue; }
    const missing = (PHASE_DEPENDENCIES[id] ?? []).find(dep => results.get(dep)?.status !== 'pass');
    if (missing) { results.set(id, { id, status: 'blocked', reason: `requires ${missing} pass`, ...writes, checks: [] }); continue; }
    const report: PhaseReport = { id, status: 'pass', ...writes, checks: [] }, began = performance.now();
    const ctx: PhaseContext = {
      check(check, condition, note) { report.checks.push({ id: check, status: condition ? 'pass' : 'fail', ...(note && !condition ? { note } : {}) }); if (!condition) throw new CheckFailed(check); },
      metric(key, value) { (report.metrics ??= {})[key] = value; },
      skip(reason) { throw new NotRun(reason); },
      cleanup(item, state) { cleanup.push({ phase: id, item, state }); },
    };
    log(`${id}: running`);
    try {
      await phases[id](ctx);
    } catch (error) {
      if (error instanceof NotRun) { report.status = 'not_run'; report.reason = error.reason; }
      else { report.status = 'fail'; report.reason = describeError(error); }
    }
    report.duration_ms = Math.round(performance.now() - began);
    results.set(id, report);
    log(`${id}: ${report.status}${report.reason ? ` (${secrets.redact(report.reason).text})` : ''}`);
  }
  if (userId || NEEDS_ACCOUNT.some(id => options.phases.includes(id) && results.get(id)?.status !== 'not_run')) {
    cleanup.push({ phase: 'session', item: 'dedicated synthetic account and its sessions/receipts: root removes or deactivates it in the candidate database after acceptance', state: 'cleanup_required' });
  }
  return finish(target, 'execute', options, PHASES.map(id => results.get(id)!), cleanup, started, secrets, now);
}

// ---------------------------------------------------------------- guild grant/revoke
/** Exactly `"N"` (strong) or `W/"N"` (weak) for the body version N; lists, wildcards, whitespace and `w/` are invalid. */
function versionEtagKind(etag: string | null, version: number): 'strong' | 'weak' | 'invalid' {
  if (etag === `"${version}"`) return 'strong';
  return etag === `W/"${version}"` ? 'weak' : 'invalid';
}
async function guildPhase(ctx: PhaseContext, client: CandidateClient, options: RunOptions, login: (c: CandidateClient) => Promise<unknown>, log: (line: string) => void) {
  const book = options.developmentBook ?? 'video-autopilot', guild = options.developmentGuild ?? 'guild_ai_vibe';
  if (!/^[a-z0-9-]{1,100}$/.test(book) || !DEVELOPMENT_GUILDS.includes(guild)) throw new CheckFailed('invalid_development_target');
  const statusPath = `/api/v1/me/development/skill/${book}`;
  const readStatus = async (session: CandidateClient) => {
    const reply = await session.request('GET', statusPath);
    ctx.check('status_read_200', reply.status === 200, `status ${reply.status} ${safeCode(reply.json()?.code)}`);
    ctx.check('status_no_store', noStore(reply));
    const body = reply.json() ?? {};
    return { eligible: body.eligible, enabled: body.enabled, consent: body.consent, states: Object.fromEntries((Array.isArray(body.guilds) ? body.guilds : []).map((g: any) => [String(g?.guild_key), g?.state ?? null])) as Record<string, string | null>, keys: Array.isArray(body.keys) ? body.keys.length : null, grant: body.grant ? (body.grant.revoked_at ? 'revoked' : 'present') : 'none', appConfigured: body.app?.configured === true };
  };
  type Membership = { state: string; aggregate_version: number } | null;
  const membership = async () => {
    const reply = await client.request('GET', '/api/v1/guilds/directory');
    ctx.check('directory_200', reply.status === 200);
    const item = (reply.json()?.items ?? []).find((value: any) => value?.guild_key === guild);
    ctx.check('guild_in_directory', !!item);
    return item.membership as Membership;
  };
  // Cleanup lookup records no checks and never throws. A failed or unreadable
  // lookup is 'unknown', which is distinct from a successfully read absent membership.
  const cleanupLookup = async (): Promise<{ known: true; membership: Membership } | { known: false }> => {
    try {
      const reply = await client.request('GET', '/api/v1/guilds/directory');
      const items = reply.status === 200 ? reply.json()?.items : undefined;
      const item = Array.isArray(items) ? items.find((value: any) => value?.guild_key === guild) : undefined;
      if (!item || typeof item !== 'object' || !('membership' in item)) return { known: false };
      const value = item.membership;
      if (value === null) return { known: true, membership: null };
      if (typeof value?.state !== 'string') return { known: false };
      return { known: true, membership: value as Membership };
    } catch { return { known: false }; }
  };
  const books = async () => { const reply = await client.request('GET', '/api/v1/me/skill-books'); ctx.check('skill_books_200', reply.status === 200); return (reply.json()?.items ?? []).length as number; };

  // Baseline: only proceed from a clean, recorded, non-eligible state.
  const preferences = await client.request('GET', '/api/v1/me/guild-preferences');
  ctx.check('preferences_200', preferences.status === 200);
  const primary = preferences.json()?.primary_guild_key;
  if (DEVELOPMENT_GUILDS.includes(primary)) ctx.skip('synthetic_account_primary_guild_is_a_development_guild');
  const baseline = await readStatus(client), baselineMembership = await membership(), baselineBooks = await books();
  ctx.metric('baseline', { eligible: baseline.eligible, enabled: baseline.enabled, test_guild_state: baselineMembership?.state ?? null, grant: baseline.grant, key_count: baseline.keys, app_configured: baseline.appConfigured, skill_book_count: baselineBooks });
  if (baseline.eligible !== false || Object.values(baseline.states).includes('active')) ctx.skip('synthetic_account_already_eligible; tool will not leave pre-existing memberships');
  const repeat = await readStatus(client);
  ctx.check('baseline_repeat_fresh', repeat.eligible === false);

  // Set before the join request: once a write may have reached the candidate,
  // cleanup must read current state instead of assuming nothing changed.
  let joinAttempted = false;
  const joinKey = randomUUID(), joinOptions = { json: {}, idempotency: joinKey, ...(baselineMembership ? { ifMatch: baselineMembership.aggregate_version } : {}) };
  try {
    joinAttempted = true;
    const join = await client.request('POST', `/api/v1/guilds/${guild}/join`, joinOptions);
    ctx.check('join_200', join.status === 200, `status ${join.status} ${safeCode(join.json()?.code)}`);
    // The body version is authoritative: a positive JSON safe integer (never a string).
    // A compressing edge may weaken the response ETag, so W/"N" for the same N is
    // accepted; requests still send a strong If-Match built from the body version.
    const version = join.json()?.aggregate_version, versioned = typeof version === 'number' && Number.isSafeInteger(version) && version > 0;
    const etagKind = versioned ? versionEtagKind(join.headers.get('etag'), version) : 'invalid';
    ctx.metric('join_etag', etagKind);
    ctx.check('join_active_versioned', join.json()?.state === 'active' && versioned && etagKind !== 'invalid', `etag ${etagKind}`);
    // The first read after the commit must already be current; a later fresh read
    // does not excuse a stale first one (no polling past a cache TTL).
    const granted = await readStatus(client);
    ctx.check('join_first_read_eligible', granted.eligible === true);
    const again = await readStatus(client);
    ctx.check('join_second_read_eligible', again.eligible === true);
    // Guild membership alone is eligibility, never a GitHub App grant or key.
    ctx.check('eligible_is_not_enabled', granted.enabled === false && granted.grant !== 'present', 'enabled requires GitHub identity, consent, App installation and a verified grant');
    ctx.metric('after_join', { eligible: granted.eligible, enabled: granted.enabled, consent: granted.consent, grant: granted.grant, key_count: granted.keys });
    const booksAfterJoin = await books();
    ctx.metric('skill_books_after_join', booksAfterJoin);

    const stale = await client.request('POST', `/api/v1/guilds/${guild}/leave`, { json: {}, idempotency: true, ifMatch: (BigInt(version) + 1n).toString() });
    ctx.check('stale_version_rejected_412', stale.status === 412 && stale.json()?.code === 'version_conflict', `status ${stale.status}`);

    const leave = await client.request('POST', `/api/v1/guilds/${guild}/leave`, { json: {}, idempotency: true, ifMatch: version });
    ctx.check('leave_200', leave.status === 200, `status ${leave.status} ${safeCode(leave.json()?.code)}`);
    const revoked = await readStatus(client);
    ctx.check('leave_first_read_revoked', revoked.eligible === false && revoked.enabled === false);
    const revokedAgain = await readStatus(client);
    ctx.check('leave_second_read_revoked', revokedAgain.eligible === false && revokedAgain.enabled === false);
    ctx.check('leave_state_left', revoked.states[guild] === 'left');
    const booksAfterLeave = await books();
    ctx.check('skill_book_grants_persist_after_leave', booksAfterLeave === booksAfterJoin);

    // Replaying the retained join receipt returns its stored response but cannot restore authority.
    const replay = await client.request('POST', `/api/v1/guilds/${guild}/join`, joinOptions);
    ctx.check('join_receipt_replayed', replay.status === 200, `status ${replay.status} ${safeCode(replay.json()?.code)}`);
    const after = await readStatus(client), afterMembership = await membership();
    ctx.check('retained_receipt_does_not_restore_authority', after.eligible === false && afterMembership?.state === 'left');

    // A brand-new session and an anonymous caller see only current state.
    const fresh = client.withoutSession();
    await login(fresh);
    const freshStatus = await readStatus(fresh);
    ctx.check('new_session_sees_revocation', freshStatus.eligible === false);
    const freshLogout = await fresh.request('POST', '/api/v1/auth/logout', { json: {} });
    ctx.check('new_session_logout_200', freshLogout.status === 200);
    const anonymous = await client.request('GET', statusPath, { session: false });
    ctx.check('anonymous_status_401', anonymous.status === 401 && anonymous.json()?.code === 'login_required');
    ctx.check('anonymous_no_store', noStore(anonymous));
    ctx.metric('after_leave', { eligible: after.eligible, enabled: after.enabled, test_guild_state: after.states[guild] ?? null, skill_book_count: booksAfterLeave });
  } finally {
    if (joinAttempted) {
      log('guild-cache: restoring baseline membership');
      const current = await cleanupLookup();
      let state: CleanupItem['state'] = 'restore_failed';
      if (current.known && current.membership?.state !== 'active') state = 'restored';
      else if (current.known) {
        const restore = await client.request('POST', `/api/v1/guilds/${guild}/leave`, { json: {}, idempotency: true, ifMatch: current.membership!.aggregate_version }).catch(() => null);
        if (restore?.status === 200 && restore.json()?.state === 'left') state = 'restored';
      }
      ctx.cleanup(`test guild membership ${guild}`, state);
    } else ctx.cleanup(`test guild membership ${guild}`, 'restored');
    ctx.cleanup('left-state membership row, retained guild skill-book grants and command receipts on the synthetic account', 'residual_expected');
  }
}

// ---------------------------------------------------------------- browser
/** Member inbox APIs (and every descendant) that the browser phase must never forward. */
export const INBOX_PATHS = Object.freeze(['/api/v1/me/notifications', '/api/v1/me/conversations', '/api/v1/me/channels']);
/** Over-inclusive on purpose: decoded, lowercased, repeated slashes collapsed; undecodable paths count as inbox. */
export function isInboxPath(pathname: string) {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return true; }
  path = path.toLowerCase().replace(/\/{2,}/g, '/');
  return INBOX_PATHS.some(prefix => path === prefix || path.startsWith(prefix + '/'));
}

/** Revokes a session cookie taken from the browser jar through the exact-origin API client; never throws. */
async function revokeBrowserSession(client: CandidateClient, value: string, secrets: Secrets): Promise<CleanupItem['state']> {
  try {
    const session = client.withSession(value);
    const current = await session.request('GET', '/api/v1/session');
    if (current.status === 401 && current.json()?.code === 'session_expired') return 'restored';
    const csrf = current.json()?.csrf_token;
    secrets.add(csrf);
    if (current.status !== 200 || typeof csrf !== 'string') return 'restore_failed';
    session.csrf = csrf;
    const reply = await session.request('POST', '/api/v1/auth/logout', { json: {} });
    return reply.status === 200 && !session.hasSession() ? 'restored' : 'restore_failed';
  } catch { return 'restore_failed'; }
}

async function browserPhase(ctx: PhaseContext, options: RunOptions, target: Target, access: AccessCredential | null, account: Account | null, secrets: Secrets, client: CandidateClient, members: MemberRunState | null = null) {
  const synthetic = members !== null;
  if (!options.browser) ctx.skip('no_browser_supplied');
  if (!synthetic && !account) throw new CheckFailed('account_required');
  // messages-mobile uses a phone viewport. The account browser phase stays at the desktop size.
  const context = await options.browser!.newContext(synthetic
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 } });
  let blocked = 0, inboxBlocked = 0, inboxResponses = 0, pageErrors = 0, closing = false, loggedOut = false;
  let sessionCookie: string | null = null;
  // Route failures are kept as `stage:ErrorClass` counts only: never messages, URLs, headers or bodies.
  const routing: Record<string, number> = {}, routingAtTeardown: Record<string, number> = {};
  // During teardown only a TargetClosedError (the close cancelling a route) and the
  // secondary abort after a failed fetch/fulfill are expected; any other primary
  // failure is counted here and fails browser_teardown_clean.
  let unexpectedAtTeardown = 0;
  const failed = (stage: string, error: unknown, secondary = false) => {
    const kind = describeError(error), into = closing ? routingAtTeardown : routing, key = `${stage}:${kind}`;
    into[key] = (into[key] ?? 0) + 1;
    if (closing && !secondary && kind !== 'TargetClosedError') unexpectedAtTeardown++;
  };
  const settle = async (stage: string, action: () => Promise<unknown>, secondary = false) => { try { await action(); return true; } catch (error) { failed(stage, error, secondary); return false; } };
  // Every request is fetched by Playwright without following redirects; only the
  // exact candidate origin is allowed and only it ever receives Access headers.
  // The account browser phase aborts inbox previews (they include a last message
  // body) before any fetch. messages-mobile allows them: that session is only
  // the synthetic member this run registered. Nothing is answered with fake data.
  // A handler never rejects: Playwright re-raises a rejected handler as an
  // unhandled rejection. Playwright marks a route handled before fulfill reaches
  // the browser, so the abort after a failed fulfill can itself throw.
  const handle = async (route: any) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') { await settle('continue', () => route.continue()); return; }
    if (url.origin !== target.origin) { blocked++; await settle('abort_blocked', () => route.abort('blockedbyclient')); return; }
    if (!synthetic && isInboxPath(url.pathname)) { inboxBlocked++; await settle('abort_blocked', () => route.abort('blockedbyclient')); return; }
    // Once teardown starts nothing new leaves the browser.
    if (closing) { await settle('abort_closing', () => route.abort('failed')); return; }
    const headers = { ...route.request().headers(), ...(access ? { 'CF-Access-Client-Id': access.clientId, 'CF-Access-Client-Secret': access.clientSecret } : {}) };
    let response: unknown;
    try { response = await route.fetch({ headers, maxRedirects: 0 }); } catch (error) { failed('fetch', error); await settle('abort_after_fetch', () => route.abort('failed'), true); return; }
    if (!await settle('fulfill', () => route.fulfill({ response }))) await settle('abort_after_fulfill', () => route.abort('failed'), true);
  };
  const pending = new Set<Promise<void>>();
  const track = (route: any) => {
    const run: Promise<void> = handle(route).catch(error => failed('handler', error)).finally(() => pending.delete(run));
    pending.add(run);
    return run;
  };
  /** Waits up to `ms` for in-flight handlers; returns how many are still pending. */
  const drain = async (ms: number) => {
    const deadline = performance.now() + ms;
    while (pending.size && performance.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { timer = setTimeout(resolve, deadline - performance.now()); })]);
      clearTimeout(timer);
    }
    return pending.size;
  };
  let failure: { error: unknown } | null = null;
  try {
    await context.route('**/*', track);
    const page = await context.newPage();
    page.on('pageerror', () => { pageErrors++; });
    // The account browser phase fails if an inbox response reaches the page.
    // messages-mobile allows those responses and only counts them.
    context.on('response', (response: any) => { try { if (isInboxPath(new URL(response.url()).pathname)) inboxResponses++; } catch { inboxResponses++; } });
    if (synthetic) {
      ctx.metric('viewport', { width: 390, height: 844, device_scale_factor: 3, mobile: true, touch: true });
      loggedOut = await runMessagesMobile(page, context, ctx, members, secrets, target.origin);
    } else {
      const landing = await page.goto(target.origin + '/', { waitUntil: 'domcontentloaded' });
      ctx.check('landing_200', landing?.status() === 200, `status ${landing?.status() ?? 'none'}`);
      await page.getByLabel('電子郵件', { exact: true }).fill(account!.email);
      await page.getByLabel('密碼', { exact: true }).fill(account!.password);
      await page.getByRole('button', { name: '登入', exact: true }).click();
      const logoutButton = page.getByRole('button', { name: '登出', exact: true });
      await logoutButton.waitFor({ state: 'visible', timeout: 20000 });
      const cookie = (await context.cookies(target.origin)).find((value: any) => value.name === SESSION_COOKIE);
      secrets.add(cookie?.value);
      const https = target.origin.startsWith('https:');
      ctx.check('browser_cookie_secure', https ? cookie?.secure === true : !!cookie);
      ctx.check('browser_cookie_http_only', cookie?.httpOnly === true);
      ctx.check('browser_cookie_same_site_strict', cookie?.sameSite === 'Strict');
      ctx.check('browser_cookie_script_invisible', !(await page.evaluate(() => document.cookie)).includes(SESSION_COOKIE));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await logoutButton.waitFor({ state: 'visible', timeout: 20000 });
      ctx.check('reload_keeps_session', true);
      await logoutButton.click();
      await page.getByRole('button', { name: '登入', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
      ctx.check('logout_returns_to_login', true);
      const cleared = !(await context.cookies(target.origin)).some((value: any) => value.name === SESSION_COOKIE && value.value);
      ctx.check('browser_cookie_cleared', cleared);
      loggedOut = true;
    }
    ctx.metric('cross_origin_requests_blocked', blocked);
    ctx.metric('inbox_requests_blocked', inboxBlocked);
    if (synthetic) ctx.metric('member_inbox', 'synthetic_member');
    else {
      ctx.metric('member_inbox', 'not_covered');
      ctx.check('no_inbox_response_received', inboxResponses === 0, `${inboxResponses} inbox responses`);
    }
    ctx.check('no_page_errors', pageErrors === 0, `${pageErrors} page errors`);
    ctx.check('no_routing_failures', Object.keys(routing).length === 0, 'see metrics.routing_failures');
  } catch (error) { failure = { error }; }

  // Teardown never throws: pages close first so no new request starts, in-flight
  // handlers are drained (bounded), then the context closes with the route still
  // installed, so no request is ever sent unguarded.
  closing = true;
  const teardown: Record<string, unknown> = {};
  if (!loggedOut) {
    try { sessionCookie = (await context.cookies(target.origin)).find((value: any) => value.name === SESSION_COOKIE && value.value)?.value ?? null; secrets.add(sessionCookie); }
    catch (error) { teardown.cookie_read = describeError(error); }
  }
  let pages: any[] = [];
  try { pages = context.pages(); } catch (error) { teardown.page_close = describeError(error); }
  for (const page of pages) await page.close().catch((error: unknown) => { teardown.page_close = describeError(error); });
  teardown.routes_pending_at_close = await drain(options.browserDrainMs ?? 15000);
  try { await context.close(); teardown.context_close = 'ok'; } catch (error) { teardown.context_close = describeError(error); }
  teardown.routes_pending_after_close = await drain(Math.min(options.browserDrainMs ?? 15000, 5000));
  teardown.unexpected_routing_failures = unexpectedAtTeardown;
  ctx.metric('routing_failures', routing);
  ctx.metric('routing_failures_during_teardown', routingAtTeardown);
  ctx.metric('teardown', teardown);
  // The browser session is revoked even when the UI flow did not finish.
  const revoked = loggedOut ? 'restored' : teardown.cookie_read ? 'restore_failed' : sessionCookie ? await revokeBrowserSession(client, sessionCookie, secrets) : 'restored';
  ctx.cleanup(synthetic ? 'mobile browser session of the synthetic member' : 'browser session of the synthetic account', revoked);

  if (failure) {
    // Recorded without replacing the original failure reason.
    const routingCheckFailed = failure.error instanceof CheckFailed && failure.error.check === 'no_routing_failures';
    if ((Object.keys(routing).length || unexpectedAtTeardown) && !routingCheckFailed) try { ctx.check('no_routing_failures', false, 'see metrics.routing_failures'); } catch { /* recorded */ }
    throw failure.error;
  }
  ctx.check('browser_teardown_clean', teardown.context_close === 'ok' && teardown.routes_pending_after_close === 0 && unexpectedAtTeardown === 0 && !teardown.page_close, 'see metrics.teardown');
}

async function messagesMobilePhase(ctx: PhaseContext, options: RunOptions, target: Target, access: AccessCredential | null, secrets: Secrets, client: CandidateClient, members: MemberRunState) {
  await browserPhase(ctx, options, target, access, null, secrets, client, members);
}
