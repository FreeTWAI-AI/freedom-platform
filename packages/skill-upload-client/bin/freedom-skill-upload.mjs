#!/usr/bin/env node
// 自由工坊技能草稿上傳工具。只能建立與上傳「私人草稿」；公開、撤回與金鑰管理
// 必須由會員本人在網站上操作。金鑰只從 stdin 或環境變數讀入，絕不接受命令列參數。
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const VERSION = '0.1.0';
const KEY_PATTERN = /^fpk_[A-Za-z0-9_-]{43}$/;
const GRANT_PATTERN = /^fpg_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYLOAD_MAX_BYTES = 800 * 1024;
const COVER_MAX_BYTES = 512 * 1024;
const RESPONSE_MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const ERROR_CODES = new Set(['validation_failed','invalid_github_url','invalid_external_url','invalid_cover_image','cover_image_too_large',
  'auth_rate_limited','json_required','body_too_large','invalid_json','upload_key_invalid','upload_grant_invalid','idempotency_required',
  'idempotency_conflict','draft_limit','onboarding_required','upload_grant_consumed','submission_not_awaiting_upload','origin_rejected',
  'host_rejected','agent_query_unsupported','internal_error','agent_route_not_found','agent_method_not_allowed']);
const POSIX = process.platform !== 'win32';

class CliError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

const HELP = `freedom-skill-upload ${VERSION} — 上傳私人技能草稿到自由工坊

用法：
  freedom-skill-upload init --origin https://freetwai.com --key-stdin   (從 stdin 讀入上傳金鑰)
  FREEDOM_SKILL_UPLOAD_KEY=… freedom-skill-upload init --origin https://freetwai.com
  freedom-skill-upload config                 顯示網站與是否已設定金鑰（不顯示金鑰）
  freedom-skill-upload reset                  刪除本機保存的金鑰
  freedom-skill-upload submit --file skill.json [--cover cover.png] [--json]
  freedom-skill-upload submit --submission <草稿 ID> --grant-stdin --file skill.json
      (或以 FREEDOM_SKILL_UPLOAD_GRANT 提供網站發出的一次性上傳授權)

說明：
  • 上傳金鑰請到自由工坊網站「技能上傳」建立；金鑰只顯示一次，可隨時在網站撤銷。
  • 金鑰與授權絕不可放在命令列參數、repo、截圖或聊天紀錄。
  • 本工具只建立「私人草稿」。草稿狀態、撤回與公開都由你本人在網站確認：
    <網站>/#skills
  • 在你於網站按下公開之前，請不要對外宣稱作品已發表。
  • 金鑰保存在 ~/.config/freedom-skill-upload/config.json（權限 0600）。`;

function out(line) { process.stdout.write(line + '\n'); }

function parseOrigin(raw) {
  if (typeof raw !== 'string' || !raw || /\s/.test(raw)) throw new CliError('請提供網站位址，例如 --origin https://freetwai.com', 2);
  let url;
  try { url = new URL(raw); } catch { throw new CliError('網站位址格式不正確。', 2); }
  const bare = raw.replace(/\/$/, '') === url.origin;
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !bare || (url.protocol !== 'https:' && !local))
    throw new CliError('網站位址只能是 https://網域（本機測試可用 http://127.0.0.1、localhost 或 [::1]），不可包含帳號、路徑、查詢或片段。', 2);
  return url.origin;
}

// ---------- private config ----------
const configDir = () => join(homedir(), '.config', 'freedom-skill-upload');
const configFile = () => join(configDir(), 'config.json');

async function statOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function checkConfigParents() {
  for (const path of [join(homedir(), '.config'), configDir()]) {
    const info = await statOrNull(path);
    if (info && (info.isSymbolicLink() || !info.isDirectory() || (POSIX && info.uid !== process.getuid())))
      throw new CliError('設定資料夾不是目前使用者的一般資料夾，為安全起見停止。');
  }
}
async function ensurePrivateDir() {
  const dir = configDir();
  await checkConfigParents();
  await mkdir(join(homedir(), '.config'), { recursive: true, mode: 0o700 });
  let info = await statOrNull(dir);
  if (!info) { await mkdir(dir, { mode: 0o700 }); info = await lstat(dir); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new CliError('設定資料夾不是一般資料夾（可能是符號連結），為安全起見停止。');
  if (POSIX) {
    if (info.uid !== process.getuid()) throw new CliError('設定資料夾不屬於目前使用者，為安全起見停止。');
    if (info.mode & 0o077) await chmod(dir, 0o700);
  }
  return dir;
}
async function readConfig() {
  const file = configFile();
  await checkConfigParents();
  const dirInfo = await statOrNull(configDir());
  if (!dirInfo) return null;
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new CliError('設定資料夾不是一般資料夾（可能是符號連結），為安全起見停止。');
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new CliError('設定檔是符號連結，為安全起見停止。請執行 reset 後重新 init。');
    throw new CliError('無法讀取設定檔。');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) throw new CliError('設定檔格式不正確，請執行 reset 後重新 init。');
    if (POSIX && (info.uid !== process.getuid() || (info.mode & 0o077))) throw new CliError('設定檔權限過寬或不屬於目前使用者（需為 0600）。請執行 reset 後重新 init。');
    let saved;
    try { saved = JSON.parse(await handle.readFile('utf8')); } catch { throw new CliError('設定檔格式不正確，請執行 reset 後重新 init。'); }
    if (!saved || typeof saved !== 'object' || !KEY_PATTERN.test(saved.key ?? '')) throw new CliError('設定檔格式不正確，請執行 reset 後重新 init。');
    return { origin: parseOrigin(saved.origin), key: saved.key };
  } finally { await handle.close(); }
}
async function writeConfig(config) {
  const dir = await ensurePrivateDir(), file = configFile();
  const existing = await statOrNull(file);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new CliError('設定檔是符號連結或非一般檔案，為安全起見停止。');
  const temp = join(dir, `.config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  let moved = false;
  try {
    await handle.writeFile(JSON.stringify({ origin: config.origin, key: config.key }) + '\n');
    await handle.sync();
    await handle.close();
    await rename(temp, file);
    moved = true;
  } finally {
    if (!moved) { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }
}

// ---------- input ----------
async function readStdin(maxBytes) {
  if (process.stdin.isTTY) throw new CliError('請以 stdin 傳入內容（例如使用管線或重新導向）。', 2);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new CliError('輸入內容過長。', 2);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readSecretFromStdin(pattern, label) {
  const value = (await readStdin(1024)).trim();
  if (!pattern.test(value)) throw new CliError(`stdin 內容不是有效的${label}。`, 2);
  return value;
}
async function readBoundedFile(path, maxBytes, label) {
  const handle = await open(path, constants.O_RDONLY).catch(() => { throw new CliError(`無法開啟${label}。`, 2); });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new CliError(`${label}不是一般檔案。`, 2);
    if (info.size > maxBytes) throw new CliError(`${label}過大。`, 2);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new CliError(`${label}過大。`, 2);
    return bytes;
  } finally { await handle.close(); }
}
function coverMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new CliError('示意圖只接受靜態 PNG、JPEG 或 WebP。', 2);
}
async function loadPayload(values, stdinAvailable) {
  let text;
  if (values.file) text = (await readBoundedFile(values.file, PAYLOAD_MAX_BYTES, '技能內容檔')).toString('utf8');
  else if (stdinAvailable) text = await readStdin(PAYLOAD_MAX_BYTES);
  else throw new CliError('請以 --file 指定技能內容 JSON。', 2);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new CliError('技能內容不是有效的 JSON。', 2); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new CliError('技能內容必須是 JSON 物件。', 2);
  if (values.cover) {
    const bytes = await readBoundedFile(values.cover, COVER_MAX_BYTES, '示意圖');
    payload = { ...payload, cover_image: { mime_type: coverMime(bytes), data_base64: bytes.toString('base64') } };
  }
  return payload;
}

// ---------- network ----------
async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_MAX_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
async function postJson(origin, path, credential, body, idempotencyKey) {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new CliError('拒絕傳送到其他網站。');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${credential}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new CliError(`無法連線到 ${origin}（逾時、轉址或網路錯誤）。`); }
  const data = await readResponse(response);
  if (!response.ok) {
    const code = ERROR_CODES.has(data?.code) ? ` ${data.code}` : '';
    // Server-controlled detail may reflect the Authorization header. Report
    // only bounded protocol codes and locally authored guidance.
    const hint = data?.code === 'validation_failed' ? '：請核對技能欄位與剛好 100 則不同的分享介紹。' : '';
    throw new CliError(`網站拒絕這次操作（HTTP ${response.status}${code}）${hint}`);
  }
  if (!data || typeof data !== 'object') throw new CliError('網站回應格式不正確。');
  return data;
}

// ---------- commands ----------
async function commandInit(values) {
  const origin = parseOrigin(values.origin);
  let key;
  if (values['key-stdin']) key = await readSecretFromStdin(KEY_PATTERN, '上傳金鑰（fpk_…）');
  else if (process.env.FREEDOM_SKILL_UPLOAD_KEY) {
    key = process.env.FREEDOM_SKILL_UPLOAD_KEY.trim();
    if (!KEY_PATTERN.test(key)) throw new CliError('FREEDOM_SKILL_UPLOAD_KEY 不是有效的上傳金鑰。', 2);
  } else throw new CliError('請以 --key-stdin 從 stdin 提供金鑰，或設定 FREEDOM_SKILL_UPLOAD_KEY；不要把金鑰寫在命令列。', 2);
  await writeConfig({ origin, key });
  out(`已保存上傳設定：${origin}`);
  out(`設定檔：${configFile()}（權限 0600）`);
  out(`可隨時到 ${origin}/#skills 撤銷這把金鑰。`);
}
async function commandConfig() {
  const config = await readConfig();
  out(JSON.stringify({ origin: config?.origin ?? null, keyConfigured: Boolean(config?.key) }));
}
async function commandReset() {
  await checkConfigParents();
  const file = configFile(), info = await statOrNull(file);
  if (info) await unlink(file);
  out(info ? '已刪除本機保存的上傳金鑰。若金鑰可能外流，請同時到網站撤銷。' : '本機沒有保存的上傳金鑰。');
}
async function commandSubmit(values) {
  const config = await readConfig();
  const origin = values.origin ? parseOrigin(values.origin) : config?.origin;
  if (!origin) throw new CliError('尚未設定網站；請先執行 init，或加上 --origin。', 2);
  if (config && values.origin && config.origin !== origin && !values.submission)
    throw new CliError('--origin 與已保存的網站不同；金鑰只會送到保存時的網站。', 2);
  let submissionId, grant;
  if (values.submission) {
    if (!UUID_PATTERN.test(values.submission)) throw new CliError('--submission 必須是草稿 ID（UUID）。', 2);
    if (values['grant-stdin'] && !values.file) throw new CliError('使用 --grant-stdin 時，技能內容請以 --file 提供。', 2);
    grant = values['grant-stdin'] ? await readSecretFromStdin(GRANT_PATTERN, '上傳授權（fpg_…）') : process.env.FREEDOM_SKILL_UPLOAD_GRANT?.trim();
    if (!grant || !GRANT_PATTERN.test(grant)) throw new CliError('請以 --grant-stdin 或 FREEDOM_SKILL_UPLOAD_GRANT 提供網站發出的一次性上傳授權。', 2);
    submissionId = values.submission.toLowerCase();
  }
  const payload = await loadPayload(values, !values['grant-stdin']);
  if (Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_MAX_BYTES) throw new CliError('技能內容與示意圖合計過大。', 2);
  if (!submissionId) {
    const envKey = process.env.FREEDOM_SKILL_UPLOAD_KEY?.trim();
    const key = config?.key ?? envKey;
    if (!key || !KEY_PATTERN.test(key)) throw new CliError('尚未設定上傳金鑰；請先執行 init。', 2);
    const created = await postJson(origin, '/agent-api/v1/skill-submissions', key, {}, randomUUID());
    submissionId = created?.submission?.submission_id;
    grant = created?.upload_grant?.token;
    if (!UUID_PATTERN.test(submissionId ?? '') || !GRANT_PATTERN.test(grant ?? '')) throw new CliError('網站沒有回傳可用的上傳授權；請到網站查看草稿狀態。');
    if (created.upload_grant.submit_url && new URL(created.upload_grant.submit_url).origin !== origin) throw new CliError('網站回傳的上傳位址不屬於同一網站，已停止。');
  }
  let result;
  try {
    result = await postJson(origin, `/agent-api/v1/skill-submissions/${submissionId}`, grant, payload);
  } catch (error) {
    if (error instanceof CliError) error.message += `\n草稿 ID：${submissionId}。可到 ${origin}/#skills 查看或重新發出上傳授權。`;
    throw error;
  }
  if (result.submission_id !== submissionId || !['ready_for_review', 'published'].includes(result.status))
    throw new CliError('網站回傳的上傳確認格式不正確；請到網站查看草稿狀態。');
  const summary = { submission_id: submissionId, status: result.status, review_url: `${origin}/#skills` };
  if (values.json) out(JSON.stringify(summary));
  else {
    out(`submission_id: ${summary.submission_id}`);
    out(`status: ${summary.status}`);
    out(`review_url: ${summary.review_url}`);
    out(summary.status === 'published' ? '網站確認這份投稿已由會員公開；可到網站查看。' : '這是私人草稿；請到網站確認內容並由你本人決定是否公開。');
  }
}

async function main(argv) {
  // Credentials never belong in argv (visible to other processes and shell history).
  if (argv.some(arg => /fp[kg]_[A-Za-z0-9_-]{20,}/.test(arg)))
    throw new CliError('偵測到命令列參數中含有金鑰或授權。已停止且未使用它；請到網站撤銷這把金鑰，改用 --key-stdin 或環境變數。', 2);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      origin: { type: 'string' }, 'key-stdin': { type: 'boolean' }, file: { type: 'string' }, cover: { type: 'string' },
      submission: { type: 'string' }, 'grant-stdin': { type: 'boolean' }, json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    } });
  } catch { throw new CliError('不認得的參數；請執行 freedom-skill-upload help。', 2); }
  const { values, positionals } = parsed;
  const command = positionals[0] ?? 'help';
  if (values.version) return out(VERSION);
  if (values.help || command === 'help') return out(HELP);
  if (positionals.length > 1) throw new CliError('多餘的參數；請執行 freedom-skill-upload help。', 2);
  if (command === 'init') return commandInit(values);
  if (command === 'config') return commandConfig();
  if (command === 'reset') return commandReset();
  if (command === 'submit') return commandSubmit(values);
  throw new CliError('不認得的指令；請執行 freedom-skill-upload help。', 2);
}

main(process.argv.slice(2)).catch(error => {
  // Only our own messages are printed; raw errors could echo paths or bodies.
  process.stderr.write((error instanceof CliError ? error.message : '執行失敗，請確認設定後重試。') + '\n');
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
