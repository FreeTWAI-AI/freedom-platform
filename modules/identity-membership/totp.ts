import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { digest, journal, transaction, type Command } from '../../packages/db/index.js';
import { assertCurrentSessionClock, lockMemberSession } from '../../packages/db/member-session.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { tokenHash, verifyMemberPassword, type Actor } from './service.js';

interface TotpRow {
  enabled: boolean; secret_ciphertext: string | null; last_counter: string;
  failures: number; generation: string;
}
const enableInput = z.object({password:z.string().min(1).max(200),secret:z.string().length(32).regex(/^[A-Z2-7]{32}$/),code:z.string().length(6).regex(/^\d{6}$/)}).strict();
const disableInput = z.object({password:z.string().min(1).max(200),code:z.string().min(1).max(64)}).strict();

export function totpCode(secret: string, counter: number, digits = 6): string {
  requireCondition(secret.length > 0 && !/[^A-Z2-7]/.test(secret) && Number.isSafeInteger(counter) && counter >= 0 && (digits === 6 || digits === 8),422,'invalid_totp','驗證碼格式不正確。');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes: number[] = [];
  let bits = 0, value = 0;
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1',Buffer.from(bytes)).update(message).digest(), offset = mac[mac.length-1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits,'0');
}

export function matchTotp(secret: string, code: string, nowMilliseconds: number, lastCounter: number): number | null {
  if (code.length !== 6 || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMilliseconds / 30_000);
  for (const counter of [current, current-1, current+1]) {
    if (counter < 0 || counter <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret,counter)),Buffer.from(code))) return counter;
  }
  return null;
}

function keyBytes(value: string | undefined): Buffer {
  const key = Buffer.from(value ?? '', 'base64');
  requireCondition(key.length === 32 && key.toString('base64') === value,503,'totp_unavailable','兩步驟驗證服務尚未設定完成。');
  return key;
}
function encrypt(secret: string, key: Buffer, userId: string): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('freedom.member-totp.v1:'+userId));
  const ciphertext = Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64');
}
function decrypt(ciphertext: string, key: Buffer, userId: string): string {
  try {
    const raw = Buffer.from(ciphertext,'base64'), decipher = createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
    decipher.setAAD(Buffer.from('freedom.member-totp.v1:'+userId)); decipher.setAuthTag(raw.subarray(12,28));
    return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8');
  } catch { throw new Problem(503,'totp_unavailable','兩步驟驗證服務暫時無法讀取。'); }
}

export async function lockTotp(q: PoolClient, userId: string): Promise<TotpRow> {
  await q.query('INSERT INTO member_totp(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
  await q.query(`UPDATE member_totp SET failures=0,window_start=clock_timestamp() WHERE user_id=$1 AND window_start<clock_timestamp()-interval '15 minutes'`,[userId]);
  return (await q.query<TotpRow>('SELECT enabled,secret_ciphertext,last_counter,failures,generation FROM member_totp WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
}

export async function consumeTotp(q: PoolClient, userId: string, row: TotpRow, code: string, encryptionKey?: string): Promise<boolean> {
  const key = keyBytes(encryptionKey);
  const clock = (await q.query<{milliseconds:string}>('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS milliseconds')).rows[0];
  const counter = matchTotp(decrypt(row.secret_ciphertext!,key,userId),code,Number(clock.milliseconds),Number(row.last_counter));
  if (counter !== null) {
    await q.query('UPDATE member_totp SET last_counter=$2 WHERE user_id=$1',[userId,counter]);
    return true;
  }
  if (!/^[a-f0-9]{24}$/.test(code)) return false;
  const removed = await q.query('DELETE FROM member_totp_backup_codes WHERE user_id=$1 AND code_hash=$2 RETURNING code_hash',[userId,tokenHash(code)]);
  return removed.rowCount === 1;
}

export async function totpStatus(pool: Pool, actor: Actor) {
  return transaction(pool,async q => {
    await lockMemberSession(q,actor);
    const result = await q.query(`SELECT enabled,(SELECT count(*)::int FROM member_totp_backup_codes b WHERE b.user_id=t.user_id) AS backup_codes_remaining FROM member_totp t WHERE user_id=$1`,[actor.user_id]);
    await assertCurrentSessionClock(q,actor);
    return result.rows[0] ?? {enabled:false,backup_codes_remaining:0};
  });
}

function transitionDigest(operation: string, generation: string) {
  // Passwords, TOTP secrets/codes and backup codes must not become offline
  // guessing material, even through a deterministic receipt hash.
  return digest({body:{transition:operation,generation},expected:null});
}

async function priorTransition(q: PoolClient, input: Command, operation: string, row: TotpRow): Promise<boolean> {
  const receipt = (await q.query('SELECT request_sha256,response FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3',[input.actor.user_id,operation,input.key])).rows[0];
  await assertCurrentSessionClock(q,input.actor);
  if (!receipt) return false;
  requireCondition(receipt.request_sha256 === transitionDigest(operation,row.generation)
    && receipt.response?.generation === row.generation
    && receipt.response?.enabled === row.enabled,409,'totp_state_changed','兩步驟驗證狀態已改變，請重新操作。');
  return true;
}

async function recordTransition(q: PoolClient, input: Command, operation: string, generation: string, enabled: boolean) {
  // Only the resulting state/generation is retained; the public reply is unchanged.
  await q.query('INSERT INTO command_receipts(user_id,operation,idempotency_key,request_sha256,response) VALUES($1,$2,$3,$4,$5)',[input.actor.user_id,operation,input.key,transitionDigest(operation,generation),JSON.stringify({enabled,generation})]);
  await assertCurrentSessionClock(q,input.actor);
}

async function checkTransitionPassword(q: PoolClient, input: Command, row: TotpRow, password: string): Promise<{blocked:true}|{invalid:true}|undefined> {
  if (row.failures >= 10) { await assertCurrentSessionClock(q,input.actor); return {blocked:true}; }
  const valid = await verifyMemberPassword(q,input.actor.user_id,password);
  if (!valid) await q.query('UPDATE member_totp SET failures=failures+1 WHERE user_id=$1',[input.actor.user_id]);
  await assertCurrentSessionClock(q,input.actor);
  if (!valid) return {invalid:true};
}

export async function enableTotp(pool: Pool, input: Command, encryptionKey?: string) {
  const body = enableInput.parse(input.body), key = keyBytes(encryptionKey);
  requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
  const result = await transaction(pool,async q => {
    await lockMemberSession(q,input.actor,true);
    const row = await lockTotp(q,input.actor.user_id);
    const passwordFailure = await checkTransitionPassword(q,input,row,body.password);
    if (passwordFailure) return passwordFailure;
    const prior = await priorTransition(q,input,'member.totp.enable',row);
    requireCondition(!prior,409,'totp_backup_codes_already_delivered','啟用已完成；備援碼只顯示一次。請重新讀取狀態。');
    requireCondition(!row.enabled,409,'totp_already_enabled','兩步驟驗證已啟用；備援碼只顯示一次。');
    const clock = (await q.query('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS milliseconds')).rows[0];
    const counter = matchTotp(body.secret,body.code,Number(clock.milliseconds),-1);
    await assertCurrentSessionClock(q,input.actor);
    if (counter === null) {
      await q.query('UPDATE member_totp SET failures=failures+1 WHERE user_id=$1',[input.actor.user_id]);
      await assertCurrentSessionClock(q,input.actor);
      return {invalid:true} as const;
    }
    const codes = Array.from({length:10},() => randomBytes(12).toString('hex'));
    await q.query('UPDATE member_totp SET enabled=true,secret_ciphertext=$2,last_counter=$3,failures=0,generation=generation+1 WHERE user_id=$1',[input.actor.user_id,encrypt(body.secret,key,input.actor.user_id),counter]);
    for (const code of codes) await q.query('INSERT INTO member_totp_backup_codes(user_id,code_hash) VALUES($1,$2)',[input.actor.user_id,tokenHash(code)]);
    await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL',[input.actor.user_id,input.actor.session_hash]);
    await journal(q,input.actor,'member_totp',input.actor.user_id,(BigInt(row.generation)+1n).toString(),'member.totp.enable',{});
    await recordTransition(q,input,'member.totp.enable',(BigInt(row.generation)+1n).toString(),true);
    return {enabled:true as const,backup_codes:codes};
  });
  if ('blocked' in result) throw new Problem(429,'totp_rate_limited','驗證嘗試過多，請稍後再試。');
  if ('invalid' in result) throw new Problem(401,'invalid_totp','密碼或驗證碼不正確。');
  return result;
}

export async function disableTotp(pool: Pool, input: Command, encryptionKey?: string) {
  const body = disableInput.parse(input.body);
  requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
  const result = await transaction(pool,async q => {
    await lockMemberSession(q,input.actor,true);
    const row = await lockTotp(q,input.actor.user_id);
    const passwordFailure = await checkTransitionPassword(q,input,row,body.password);
    if (passwordFailure) return passwordFailure;
    if (await priorTransition(q,input,'member.totp.disable',row)) {
      requireCondition(!row.enabled,409,'totp_state_changed','兩步驟驗證狀態已改變，請重新操作。');
      return {enabled:false as const};
    }
    requireCondition(row.enabled,409,'totp_not_enabled','兩步驟驗證尚未啟用。');
    const validCode = await consumeTotp(q,input.actor.user_id,row,body.code,encryptionKey);
    await assertCurrentSessionClock(q,input.actor);
    if (!validCode) {
      await q.query('UPDATE member_totp SET failures=failures+1 WHERE user_id=$1',[input.actor.user_id]);
      await assertCurrentSessionClock(q,input.actor);
      return {invalid:true} as const;
    }
    await q.query('DELETE FROM member_totp_backup_codes WHERE user_id=$1',[input.actor.user_id]);
    await q.query('UPDATE member_totp SET enabled=false,secret_ciphertext=NULL,last_counter=-1,failures=0,generation=generation+1 WHERE user_id=$1',[input.actor.user_id]);
    await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL',[input.actor.user_id,input.actor.session_hash]);
    await journal(q,input.actor,'member_totp',input.actor.user_id,(BigInt(row.generation)+1n).toString(),'member.totp.disable',{});
    await recordTransition(q,input,'member.totp.disable',(BigInt(row.generation)+1n).toString(),false);
    return {enabled:false as const};
  });
  if ('blocked' in result) throw new Problem(429,'totp_rate_limited','驗證嘗試過多，請稍後再試。');
  if ('invalid' in result) throw new Problem(401,'invalid_totp','密碼或驗證碼不正確。');
  return result;
}
