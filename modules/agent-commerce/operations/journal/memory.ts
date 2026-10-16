import { encodeEffectRecord, type EffectJournalPort, type EffectRecord, type JournalEnvironment } from './journal.js';
/** Tests and the local E2E server only. Production installs the R2 adapter. */
export class MemoryEffectJournal implements EffectJournalPort {
  private readonly entries = new Map<string, string>();
  constructor(readonly environment: JournalEnvironment) { }
  get objects(): ReadonlyMap<string, string> { return new Map(this.entries); }
  async append(record: EffectRecord): Promise<void> {
    const { key, body } = encodeEffectRecord(record, this.environment), prior = this.entries.get(key);
    if (prior !== undefined && prior !== body)
      throw Error('journal_conflict');
    this.entries.set(key, body);
  }
}
