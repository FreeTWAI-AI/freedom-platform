import type { ResultView } from '../../../../contracts/guild-launchpad/v1/tenant-work';
import { parseProductionDossier, type ProductionDossier, type ProductionReference } from '../../../../modules/guild-workspace/production-dossier';
import { readWorkDocument, type WorkDocumentScan, type WorkDocumentPage } from './work-document-reader';

export type ProductionResultPage = WorkDocumentPage;
export type ProductionScan = WorkDocumentScan;
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
  const value = await readWorkDocument({ ...input, label: '製作版本', parse: (text, workId) => {
    const parsed = parseProductionDossier(text, workId);
    return parsed.kind === 'dossier' ? { kind: 'document' as const, value: parsed.value } : parsed;
  } });
  return value.kind === 'found' ? { kind: 'found', dossier: value.value, text: value.text, result: value.result } : value;
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
