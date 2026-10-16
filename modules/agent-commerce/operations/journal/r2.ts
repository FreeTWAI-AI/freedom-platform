import type { R2Bucket } from '@cloudflare/workers-types';
import { encodeEffectRecord, type EffectJournalPort, type EffectRecord, type JournalEnvironment } from './journal.js';
export type CommerceJournalBucket = Pick<R2Bucket, 'put' | 'get'>;
export function createR2EffectJournal(environment: JournalEnvironment, bucket: CommerceJournalBucket): EffectJournalPort {
  return {
    environment, async append(record: EffectRecord) {
      const { key, body } = encodeEffectRecord(record, environment);
      let existing: Uint8Array;
      try {
        const created = await bucket.put(key, body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
        if (created !== null)
          return;
        const object = await bucket.get(key);
        if (!object)
          throw Error();
        existing = new Uint8Array(await object.arrayBuffer());
      }
      catch {
        throw Error('journal_unavailable');
      }
      const expected = new TextEncoder().encode(body);
      if (existing.length !== expected.length || existing.some((byte, index) => byte !== expected[index]))
        throw Error('journal_conflict');
    }
  };
}
