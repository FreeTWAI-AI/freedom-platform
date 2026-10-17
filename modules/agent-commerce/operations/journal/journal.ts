import type { Pool } from 'pg';
import { CONTROL_EVENT_KINDS } from '../control-events.js';
export type JournalEnvironment = 'local' | 'staging' | 'public';
export type EffectDetail = Partial<{
  account_ref: string;
  merchant_trade_no: string;
  amount_minor: number;
  currency: string;
  attempt_id: string;
  order_id: string;
  service_key: string;
  purpose: string;
  profile: string;
  from_state: string;
  to_state: string;
  credential_version: number;
  module_release_ref: string;
  settings_version: number;
  methods: 'none' | 'bank_transfer' | 'cash_on_meetup' | 'bank_transfer,cash_on_meetup';
}>;
export interface EffectRecord {
  environment: JournalEnvironment;
  kind: string;
  id: string;
  occurred_at: string;
  tenant_id: string;
  instance_id: string | null;
  detail: EffectDetail;
}
/** The host fixes the namespace once; callers cannot accidentally journal another environment. */
export interface EffectJournalPort {
  readonly environment: JournalEnvironment;
  append(record: EffectRecord): Promise<void>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const detailKeys = ['service_key', 'account_ref', 'merchant_trade_no', 'amount_minor', 'currency', 'attempt_id', 'order_id', 'purpose', 'profile', 'from_state', 'to_state', 'credential_version', 'module_release_ref', 'settings_version', 'methods'];
const recordKeys = ['environment', 'kind', 'id', 'occurred_at', 'tenant_id', 'instance_id', 'detail'];
function sorted(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])); }
/** A deliberately small wire format. Unknown fields fail before reaching storage. */
export function encodeEffectRecord(record: EffectRecord, environment: JournalEnvironment): {
  key: string;
  body: string;
} {
  try {
    if (!record || Object.keys(record).some(key => !recordKeys.includes(key)) || record.environment !== environment
      || !['local', 'staging', 'public'].includes(environment) || !uuid.test(record.id) || !uuid.test(record.tenant_id)
      || record.instance_id !== null && !uuid.test(record.instance_id) || !['payment_handoff', 'email_send', ...CONTROL_EVENT_KINDS.map(k => 'control.' + k)].includes(record.kind)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.occurred_at)
      || new Date(record.occurred_at).toISOString() !== record.occurred_at || !record.detail || Array.isArray(record.detail))
      throw Error();
    for (const [key, value] of Object.entries(record.detail)) {
      if (!detailKeys.includes(key))
        throw Error();
      if (key === 'amount_minor' || key === 'credential_version' || key === 'settings_version') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'amount_minor' ? 0 : 1))
          throw Error();
      }
      else if (key === 'methods') {
        if (typeof value !== 'string' || !['none', 'bank_transfer', 'cash_on_meetup', 'bank_transfer,cash_on_meetup'].includes(value))
          throw Error();
      }
      else if (typeof value !== 'string' || value.length < 1 || value.length > 200 || !/^[A-Za-z0-9_.:@/-]+$/.test(value))
        throw Error();
      if ((key === 'attempt_id' || key === 'order_id') && !uuid.test(String(value)))
        throw Error();
      if (key === 'account_ref' && !/^[0-9a-hjkmnp-tv-z]{26}$/.test(String(value)))
        throw Error();
      if (key === 'merchant_trade_no' && !/^F[0-9A-HJKMNP-TV-Z]{19}$/.test(String(value)))
        throw Error();
      if (key === 'currency' && value !== 'TWD')
        throw Error();
    }
    const [year, month, day] = record.occurred_at.slice(0, 10).split('-');
    const body = JSON.stringify(sorted({ ...record, detail: sorted(record.detail) }));
    if (new TextEncoder().encode(body).byteLength > 2048)
      throw Error();
    return { key: `${environment}/${year}/${month}/${day}/${record.kind}/${record.id}`, body };
  }
  catch {
    throw Error('journal_unavailable');
  }
}
/** No transaction spans the append. Stable source timestamps make concurrent retries byte-identical. */
export async function flushControlEvents(pool: Pool, journal: EffectJournalPort, options: {
  eventIds?: readonly string[];
  limit: number;
}): Promise<{ written: number; failed: number }> {
  try {
    return await flush(pool, journal, options);
  }
  catch (error) {
    throw Error(error instanceof Error && error.message === 'journal_conflict' ? 'journal_conflict' : 'journal_unavailable');
  }
}
async function flush(pool: Pool, journal: EffectJournalPort, options: {
  eventIds?: readonly string[];
  limit: number;
}): Promise<{ written: number; failed: number }> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
    throw Error('journal_unavailable');
  const rows = (await pool.query(`SELECT event_id,tenant_id,instance_id,kind,detail,occurred_at FROM commerce_control_events
    WHERE journaled_at IS NULL AND ($1::uuid[] IS NULL OR event_id=ANY($1)) ORDER BY occurred_at,event_id LIMIT $2`, [options.eventIds ?? null, options.limit])).rows;
  let written = 0, failed = 0;
  for (const row of rows) {
    try {
      // Provider environment lives in the SQL fact; the namespace is the host environment.
      const detail = Object.fromEntries(Object.entries(row.detail).filter(([key]) => detailKeys.includes(key))) as EffectDetail;
      await journal.append({ environment: journal.environment, kind: 'control.' + row.kind, id: row.event_id, occurred_at: row.occurred_at.toISOString(), tenant_id: row.tenant_id, instance_id: row.instance_id, detail });
      const result = await pool.query('UPDATE commerce_control_events SET journaled_at=clock_timestamp() WHERE event_id=$1 AND journaled_at IS NULL', [row.event_id]);
      written += result.rowCount ?? 0;
    }
    catch (error) {
      console.error('commerce_control_journal_row_failed', row.event_id,
        error instanceof Error && error.message === 'journal_conflict' ? 'journal_conflict' : 'journal_unavailable');
      failed++;
    }
  }
  return { written, failed };
}
/** Domain changes have already committed. A journal outage must preserve their response. */
export async function flushControlEventsBestEffort(pool: Pool, journal: EffectJournalPort | undefined): Promise<void> {
  if (journal)
    try {
      await flushControlEvents(pool, journal, { limit: 200 });
    }
    catch {
      console.error('commerce_control_journal_failed');
    }
}
