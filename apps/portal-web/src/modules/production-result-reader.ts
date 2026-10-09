import type { ResultView } from '../../../../contracts/guild-launchpad/v1/tenant-work';
import { parseProductionDossier, type ProductionDossier, type ProductionReference } from '../../../../modules/guild-workspace/production-dossier';
import { workResultDigest } from './work-result-save';

export type ProductionResultPage = { items: ResultView[]; next_cursor: string | null; source_version: string };
export type ProductionScan = { remaining: ResultView[]; nextCursor: string | null; seenCursors: string[]; started: boolean; sourceVersion: string };
export type ProductionRead =
  | { kind: 'empty' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'more'; scan: ProductionScan }
  | { kind: 'found'; dossier: ProductionDossier; text: string; result: ResultView };

/** Bounded lazy scan of one opened Work. Filenames and current_result_id never identify the dossier. */
export async function readProductionResult(input: {
  workId: string;
  expectedWorkVersion: string;
  currentVersion: () => Promise<string>;
  page: (cursor: string | null) => Promise<ProductionResultPage>;
  content: (result: ResultView) => Promise<Uint8Array>;
  scan?: ProductionScan;
  budget?: number;
}): Promise<ProductionRead> {
  const scan = input.scan ? { ...input.scan, remaining: [...input.scan.remaining], seenCursors: [...input.scan.seenCursors] }
    : { remaining: [], nextCursor: null, seenCursors: [], started: false, sourceVersion: input.expectedWorkVersion };
  const changed: ProductionRead = { kind: 'blocked', reason: '工作版本在讀取期間已改變；請重新讀取製作版本。' };
  if (scan.sourceVersion !== input.expectedWorkVersion) return changed;
  const fence = async (value: ProductionRead): Promise<ProductionRead> => await input.currentVersion() === scan.sourceVersion ? value : changed;
  let left = Math.max(1, Math.min(input.budget ?? 20, 50));
  while (left > 0) {
    if (scan.remaining.length === 0) {
      if (scan.started && scan.nextCursor === null) return fence({ kind: 'empty' });
      if (scan.nextCursor !== null) {
        if (scan.seenCursors.includes(scan.nextCursor)) return { kind: 'blocked', reason: '成果分頁重複，請重新開啟專案。' };
        scan.seenCursors.push(scan.nextCursor);
      }
      const page = await input.page(scan.nextCursor);
      if (page.source_version !== scan.sourceVersion) return changed;
      scan.started = true; scan.remaining = [...page.items]; scan.nextCursor = page.next_cursor;
      if (scan.remaining.length === 0 && scan.nextCursor !== null) return { kind: 'blocked', reason: '成果分頁不完整，請重新開啟專案。' };
      continue;
    }
    const result = scan.remaining.shift()!;
    if (result.work_id !== input.workId) return { kind: 'blocked', reason: '成果不屬於目前專案。' };
    const bytes = await input.content(result);
    if (bytes.length !== result.byte_size || await workResultDigest(bytes) !== result.sha256) return { kind: 'blocked', reason: '成果內容與保存摘要不符，請重新讀取。' };
    const text = new TextDecoder().decode(bytes);
    const parsed = parseProductionDossier(text, input.workId);
    if (parsed.kind === 'blocked') return parsed;
    if (parsed.kind === 'dossier') return fence({ kind: 'found', dossier: parsed.value, text, result });
    left -= 1;
  }
  return fence(scan.remaining.length === 0 && scan.nextCursor === null ? { kind: 'empty' } : { kind: 'more', scan });
}

/** Resolve through the current Work's authenticated endpoint; document IDs carry no permission. */
export async function verifyProductionReferences(workId: string, references: ProductionReference[], get: (id: string) => Promise<ResultView>): Promise<void> {
  const checked = new Map<string, ResultView>();
  for (const ref of references) {
    if (ref.kind !== 'same_work_text_result') continue;
    let result = checked.get(ref.result_id);
    if (!result) { result = await get(ref.result_id); checked.set(ref.result_id, result); }
    if (result.result_id !== ref.result_id || result.work_id !== workId || result.sha256 !== ref.sha256 || result.revision !== ref.revision) throw new Error('素材版本引用與已保存成果不符，請重新選擇確切版本。');
  }
}
