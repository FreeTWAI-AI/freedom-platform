import type { ResultView } from '../../../../contracts/guild-launchpad/v1/tenant-work';
import { workResultDigest } from './work-result-save';

export type WorkDocumentPage = { items: ResultView[]; next_cursor: string | null; source_version: string };
export type WorkDocumentScan = { remaining: ResultView[]; nextCursor: string | null; seenCursors: string[]; started: boolean; sourceVersion: string };
export type WorkDocumentRead<T> = { kind: 'empty' } | { kind: 'blocked'; reason: string } | { kind: 'more'; scan: WorkDocumentScan }
  | { kind: 'found'; value: T; text: string; result: ResultView };

/** Scan authenticated Result bytes; a content profile carries no identity or permission. */
export async function readWorkDocument<T>(input: {
  parse: (text: string, workId: string) => { kind: 'ordinary' } | { kind: 'blocked'; reason: string } | { kind: 'document'; value: T };
  label: string;
  workId: string;
  expectedWorkVersion: string;
  currentVersion: () => Promise<string>;
  page: (cursor: string | null) => Promise<WorkDocumentPage>;
  content: (result: ResultView) => Promise<Uint8Array>;
  scan?: WorkDocumentScan;
  budget?: number;
}): Promise<WorkDocumentRead<T>> {
  const scan = input.scan ? { ...input.scan, remaining: [...input.scan.remaining], seenCursors: [...input.scan.seenCursors] }
    : { remaining: [], nextCursor: null, seenCursors: [], started: false, sourceVersion: input.expectedWorkVersion };
  const changed: WorkDocumentRead<T> = { kind: 'blocked', reason: `工作版本在讀取期間已改變；請重新讀取${input.label}。` };
  if (scan.sourceVersion !== input.expectedWorkVersion) return changed;
  const fence = async (value: WorkDocumentRead<T>): Promise<WorkDocumentRead<T>> => await input.currentVersion() === scan.sourceVersion ? value : changed;
  let left = Math.max(1, Math.min(input.budget ?? 20, 50));
  while (left > 0) {
    if (scan.remaining.length === 0) {
      if (scan.started && scan.nextCursor === null) return fence({ kind: 'empty' });
      if (scan.nextCursor !== null) {
        if (scan.seenCursors.includes(scan.nextCursor)) return { kind: 'blocked', reason: '成果分頁重複，請重新開啟工作。' };
        scan.seenCursors.push(scan.nextCursor);
      }
      const page = await input.page(scan.nextCursor);
      if (page.source_version !== scan.sourceVersion) return changed;
      scan.started = true; scan.remaining = [...page.items]; scan.nextCursor = page.next_cursor;
      if (scan.remaining.length === 0 && scan.nextCursor !== null) return { kind: 'blocked', reason: '成果分頁不完整，請重新開啟工作。' };
      continue;
    }
    const result = scan.remaining.shift()!;
    if (result.work_id !== input.workId) return { kind: 'blocked', reason: '成果不屬於目前工作。' };
    const bytes = await input.content(result);
    if (bytes.length !== result.byte_size || await workResultDigest(bytes) !== result.sha256) return { kind: 'blocked', reason: '成果內容與保存摘要不符，請重新讀取。' };
    const text = new TextDecoder().decode(bytes);
    const parsed = input.parse(text, input.workId);
    if (parsed.kind === 'blocked') return parsed;
    if (parsed.kind === 'document') return fence({ kind: 'found', value: parsed.value, text, result });
    left -= 1;
  }
  return fence(scan.remaining.length === 0 && scan.nextCursor === null ? { kind: 'empty' } : { kind: 'more', scan });
}
