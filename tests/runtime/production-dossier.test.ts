import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyProductionDossier, parseProductionDossier, serializeProductionDossier, ProductionDossierSchema } from '../../modules/guild-workspace/production-dossier';
import { readProductionResult, verifyProductionReferences } from '../../apps/portal-web/src/modules/production-result-reader';
import { advanceWorkResultSave, workResultDigest, type WorkResultSaveAttempt } from '../../apps/portal-web/src/modules/work-result-save';
import type { ResultView } from '../../contracts/guild-launchpad/v1/tenant-work';
import type { PortalClient } from '../../apps/portal-web/src/api';

test('production dossier is typed, deterministic UTF-8 Result content bound to one Work', () => {
  const value = emptyProductionDossier(randomUUID());
  value.brief.audience = '熟齡攝影入門者';
  value.shots.push({ id: randomUUID(), description: '木桌上的產品特寫', framing: '近景', lighting_props: '窗光與白卡', owner_label: '企劃填寫的名字', material_ids: [] });
  const encoded = serializeProductionDossier(value);
  const parsed = parseProductionDossier(encoded, value.work_id);
  assert.deepEqual(parsed, { kind: 'dossier', value });
  assert.equal(serializeProductionDossier(value), encoded);
  assert.equal(parseProductionDossier(encoded, randomUUID()).kind, 'blocked');
  assert.equal(ProductionDossierSchema.safeParse({ ...value, author_id: randomUUID() }).success, false);
});

test('future, damaged, oversize or credential-bearing content cannot become a blank editable dossier', () => {
  const value = emptyProductionDossier(randomUUID());
  const encoded = serializeProductionDossier(value);
  for (const broken of [encoded.replace('/v1', '/v2'), encoded.slice(0, -8), encoded.replace('"brief"', '"unknown"')]) {
    assert.equal(parseProductionDossier(broken, value.work_id).kind, 'blocked');
  }
  value.materials.push({ id: randomUUID(), label: '參考', rights_note: '', reference: { kind: 'external_reference', url: 'https://user:secret@example.com/media', declared_version: 'v1' } });
  assert.throws(() => serializeProductionDossier(value));
  value.materials = [];
  value.shots = Array.from({ length: 100 }, () => ({ id: randomUUID(), description: '鏡位', framing: '光'.repeat(1000), lighting_props: '物'.repeat(2000), owner_label: '', material_ids: [] }));
  assert.throws(() => serializeProductionDossier(value), /262144/);
});

test('delivery freezes exact versions; feedback cannot silently move to another delivery version', () => {
  const value = emptyProductionDossier(randomUUID());
  const material = { id: randomUUID(), label: '版本一', rights_note: '', reference: { kind: 'external_reference' as const, url: 'https://example.com/version-1', declared_version: 'v1' } };
  value.materials.push(material);
  value.deliveries.push({ id: randomUUID(), version_label: '初剪 v1', change_summary: '', status: 'prepared', method: '', recipient_label: '', targets: [{ material_id: material.id, label: material.label, reference: structuredClone(material.reference) }] });
  material.reference.url = 'https://example.com/version-2';
  assert.equal(ProductionDossierSchema.parse(value).deliveries[0].targets[0].reference.kind, 'external_reference');
  assert.match(serializeProductionDossier(value), /version-1/);
  value.feedback.push({ id: randomUUID(), delivery_id: value.deliveries[0].id, target_version: 'wrong', source: 'externally_reported', text: '請縮短開頭', follow_up: '', status: 'open' });
  assert.throws(() => serializeProductionDossier(value));
});

async function result(workId: string, text: string, revision: string): Promise<ResultView> {
  const bytes = new TextEncoder().encode(text);
  return { result_id: randomUUID(), work_id: workId, asset_id: randomUUID(), revision, work_version: revision, provenance: 'human', content_type: 'text/markdown', byte_size: bytes.length, sha256: await workResultDigest(bytes), created_at: '2026-10-08T00:00:00.000Z', display_name: '任意檔名.md' };
}

test('bounded reader resumes across interleaved Results and pagination; it ignores filenames', async () => {
  const workId = randomUUID();
  const text = serializeProductionDossier(emptyProductionDossier(workId));
  const latest = await result(workId, 'ordinary attachment', '3');
  latest.display_name = 'production-dossier.md';
  const dossier = await result(workId, text, '2');
  const calls: (string | null)[] = [];
  const input = { workId, budget: 1, page: async (cursor: string | null) => { calls.push(cursor); return cursor ? { items: [dossier], next_cursor: null } : { items: [latest], next_cursor: 'next' }; }, content: async (row: ResultView) => row === latest ? 'ordinary attachment' : text };
  const first = await readProductionResult(input);
  assert.equal(first.kind, 'more');
  if (first.kind !== 'more') throw Error('expected continuation');
  const second = await readProductionResult({ ...input, scan: first.scan });
  assert.equal(second.kind, 'found');
  assert.deepEqual(calls, [null, 'next']);
});

test('unknown newer dossier blocks fallback to an older recognized snapshot; bytes must match metadata', async () => {
  const workId = randomUUID();
  const future = serializeProductionDossier(emptyProductionDossier(workId)).replaceAll('/v1', '/v3');
  const row = await result(workId, future, '7');
  assert.equal((await readProductionResult({ workId, page: async () => ({ items: [row], next_cursor: 'older' }), content: async () => future })).kind, 'blocked');
  assert.equal((await readProductionResult({ workId, page: async () => ({ items: [row], next_cursor: null }), content: async () => 'tampered' })).kind, 'blocked');
});

test('references resolve only via the authorized same Work and exact digest/revision', async () => {
  const workId = randomUUID(); const row = await result(workId, 'material', '4');
  const reference = { kind: 'same_work_text_result' as const, result_id: row.result_id, sha256: row.sha256, revision: row.revision };
  await verifyProductionReferences(workId, [reference], async () => row);
  await assert.rejects(verifyProductionReferences(randomUUID(), [reference], async () => row));
  await assert.rejects(verifyProductionReferences(workId, [{ ...reference, revision: '5' }], async () => row));
  await assert.rejects(verifyProductionReferences(workId, [reference], async () => { throw new Error('403'); }), /403/);
});

test('uploader preserves exact finalize key and payload across uncertain outcomes; stale generations stop', async () => {
  const attempt: WorkResultSaveAttempt = { phase: 'finalize', key: randomUUID(), bytes: new TextEncoder().encode('draft'), sha256: 'a'.repeat(64), contentType: 'text/markdown', displayName: 'draft.md', expectedWorkVersion: '8', sourceText: 'draft', uploadId: randomUUID(), uploadVersion: '1', putVersion: '2' };
  const calls: unknown[] = []; let fail = true; let saved: WorkResultSaveAttempt = attempt;
  const client = { post: async (...args: unknown[]) => { calls.push(args); if (fail) { fail = false; throw Error('uncertain'); } return { resource_ref: { resource_id: 'result-id' } }; } } as unknown as PortalClient;
  const invoke = (live = true) => advanceWorkResultSave(client, { tenantId: 'tenant', workId: 'work' }, saved, { live: () => live }, value => { saved = value; }, () => {});
  await assert.rejects(invoke(), /uncertain/);
  assert.equal(saved, attempt);
  await invoke();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(saved.phase, 'confirm');
  assert.equal(saved.resultId, 'result-id');
  assert.equal(await invoke(false), null);
  assert.equal(calls.length, 2);
});
