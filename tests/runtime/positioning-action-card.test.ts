import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ResultView } from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { emptyPositioningActionCard, serializePositioningActionCard, parsePositioningActionCard, PositioningActionCardSchema } from '../../modules/guild-workspace/positioning-action-card.js';
import { readWorkDocument } from '../../apps/portal-web/src/modules/work-document-reader.js';
import { workResultDigest } from '../../apps/portal-web/src/modules/work-result-save.js';

test('half-filled direction card round-trips as an existing Work content snapshot, without assessment authority', () => {
  const card = emptyPositioningActionCard(randomUUID());
  card.desired_change = '這週試著寫一篇說明';
  card.activities = ['訪談一位朋友', ''];
  const encoded = serializePositioningActionCard(card);
  assert.deepEqual(parsePositioningActionCard(encoded, card.work_id), { kind: 'document', value: card });
  assert.equal(parsePositioningActionCard(encoded, randomUUID()).kind, 'blocked');
  for (const extra of ['assessment_id', 'user_id', 'tenant_id', 'capabilities']) {
    assert.equal(PositioningActionCardSchema.safeParse({ ...card, [extra]: randomUUID() }).success, false);
  }
});

test('a confirmed plan requires a filled chosen activity, completion conditions, time and a real review date', () => {
  const card = emptyPositioningActionCard(randomUUID());
  card.personally_confirmed = true;
  assert.throws(() => serializePositioningActionCard(card));
  Object.assign(card, { desired_change: '試一次', activities: ['寫下訪談提綱', '和夥伴試訪'], selected_activity: 1, completion_criteria: '完成一次試訪紀錄', available_time: '一小時', review_date: '2026-10-15' });
  assert.doesNotThrow(() => serializePositioningActionCard(card));
  for (const patch of [{ selected_activity: 2 }, { activities: ['唯一活動'], selected_activity: 1 }, { activities: [''], selected_activity: 0 }, { review_date: '2026-02-30' }, { review_date: '' }, { available_time: '' }]) {
    assert.throws(() => serializePositioningActionCard({ ...card, ...patch }));
  }
  card.review = '完成試訪，下次先確認問題是否清楚。'; card.next_step = '下週試第二位';
  assert.equal(parsePositioningActionCard(serializePositioningActionCard(card), card.work_id).kind, 'document');
});

test('future, damaged and invalid cards stay blocked; ordinary text stays ordinary', () => {
  const card = emptyPositioningActionCard(randomUUID());
  const text = serializePositioningActionCard(card);
  for (const malformed of [text.replaceAll('/v1', '/v2'), text.slice(0, -5), text.replace('"situation"', '"unknown"'), text.replace('"activities": [', '"activities": [' + '"x",'.repeat(3))]) {
    assert.equal(parsePositioningActionCard(malformed, card.work_id).kind, 'blocked');
  }
  assert.equal(parsePositioningActionCard('ordinary note', card.work_id).kind, 'ordinary');
  for (const situation of ['\u0000', '\ud800', 'x'.repeat(4001)]) assert.throws(() => serializePositioningActionCard({ ...card, situation }));
});

async function row(workId: string, text: string, revision = '3'): Promise<ResultView> {
  const bytes = new TextEncoder().encode(text);
  return { result_id: randomUUID(), work_id: workId, asset_id: randomUUID(), revision, work_version: revision, provenance: 'human', content_type: 'text/markdown', byte_size: bytes.length, sha256: await workResultDigest(bytes), created_at: '2026-10-08T00:00:00.000Z', display_name: 'arbitrary.md' };
}
const reader = { parse: parsePositioningActionCard, label: '方向卡' };

test('direction card reader resumes through ordinary BOM attachments and checks the raw digest', async () => {
  const workId = randomUUID(); const card = serializePositioningActionCard(emptyPositioningActionCard(workId));
  const plain = '\uFEFFordinary attachment'; const latest = await row(workId, plain); latest.display_name = 'positioning-action-card.md';
  const saved = await row(workId, card, '2');
  const input = { ...reader, workId, expectedWorkVersion: '3', currentVersion: async () => '3', budget: 1,
    page: async (cursor: string | null) => ({ items: cursor ? [saved] : [latest], next_cursor: cursor ? null : 'older', source_version: '3' }),
    content: async (result: ResultView) => new TextEncoder().encode(result.result_id === latest.result_id ? plain : card) };
  const first = await readWorkDocument(input); assert.equal(first.kind, 'more');
  if (first.kind !== 'more') throw Error('continuation required');
  const second = await readWorkDocument({ ...input, scan: first.scan }); assert.equal(second.kind, 'found');
  if (second.kind !== 'found') throw Error('card required');
  assert.equal(second.result.result_id, saved.result_id);
  assert.equal(second.text, card);
  assert.equal((await readWorkDocument({ ...input, content: async () => new TextEncoder().encode('changed') })).kind, 'blocked');
});

test('unknown newer card prevents falling back to an old editable card; unreadable bytes never become empty', async () => {
  const workId = randomUUID(); const card = serializePositioningActionCard(emptyPositioningActionCard(workId));
  const future = card.replaceAll('/v1', '/v9'); const saved = await row(workId, future);
  const input = { ...reader, workId, expectedWorkVersion: '3', currentVersion: async () => '3', page: async () => ({ items: [saved], next_cursor: 'older', source_version: '3' }), content: async () => new TextEncoder().encode(future) };
  assert.equal((await readWorkDocument(input)).kind, 'blocked');
  await assert.rejects(readWorkDocument({ ...input, content: async () => { throw Error('unreadable'); } }), /unreadable/);
  assert.equal((await readWorkDocument({ ...input, page: async () => ({ items: [{ ...saved, work_id: randomUUID() }], next_cursor: null, source_version: '3' }) })).kind, 'blocked');
});

test('source_version and final Work version fence prevent mixing direction card snapshots', async () => {
  const workId = randomUUID(); const text = serializePositioningActionCard(emptyPositioningActionCard(workId)); const saved = await row(workId, text);
  const input = { ...reader, workId, expectedWorkVersion: '3', currentVersion: async () => '3', page: async () => ({ items: [saved], next_cursor: null, source_version: '3' }), content: async () => new TextEncoder().encode(text) };
  assert.equal((await readWorkDocument({ ...input, currentVersion: async () => '4' })).kind, 'blocked');
  assert.equal((await readWorkDocument({ ...input, page: async () => ({ items: [saved], next_cursor: null, source_version: '4' }) })).kind, 'blocked');
});
