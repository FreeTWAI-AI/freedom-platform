import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, MessagePage } from '../../modules/member-communications/types.js';
import { directMessageReceiptRefreshDue, hasDirectMessageChanges, mergeDirectMessagePage, readLoadedDirectMessageReceipts } from '../../apps/portal-web/src/modules/direct-message-receipts.js';

const readAt = '2026-10-04T06:00:00.000Z';
const message = (index: number, sender = 'sender', read: string | null = null): Message => ({
  message_id: String(index).padStart(4, '0'), sender_ref: sender, recipient_ref: sender === 'sender' ? 'peer' : 'sender',
  body: `synthetic ${index}`, created_at: new Date(Date.UTC(2026, 9, 4, 0, index)).toISOString(), read_at: read,
});
const page = (items: Message[], next: number | null = null): MessagePage => ({
  items, next_offset: next, unread_count: 0, can_send: true,
  participant: { user_id: 'peer', display_name: 'Synthetic peer', avatar_url: null, is_online: false, last_seen_at: null },
});

test('quiet refresh updates all 25 loaded outgoing receipts, including the older page', async () => {
  const loaded = Array.from({ length: 25 }, (_, i) => message(25 - i));
  const current = loaded.map(item => ({ ...item, read_at: readAt }));
  const latest = page(current.slice(0, 20), 20), offsets: number[] = [];
  const receipts = await readLoadedDirectMessageReceipts(latest, loaded, 'sender', async offset => {
    offsets.push(offset); return page(current.slice(offset));
  }, () => true);
  assert.deepEqual(offsets, [20]);
  const merged = mergeDirectMessagePage(latest.items, loaded, receipts!);
  assert.equal(merged.length, 25);
  assert.ok(merged.every(item => item.read_at === readAt));
  assert.ok(loaded.every(item => item.read_at === null), 'existing state is immutable');
});

test('latest outgoing below 21 incoming messages receives its own authoritative receipt', async () => {
  const outgoing = message(1), incoming = Array.from({ length: 21 }, (_, i) => message(22 - i, 'peer'));
  const loaded = [...incoming, outgoing], latest = page(incoming.slice(0, 20), 20);
  const receipts = await readLoadedDirectMessageReceipts(latest, loaded, 'sender', async offset => {
    assert.equal(offset, 20); return page([incoming[20], { ...outgoing, read_at: readAt }]);
  }, () => true);
  const merged = mergeDirectMessagePage(latest.items, loaded, receipts!);
  assert.equal(merged.find(item => item.message_id === outgoing.message_id)!.read_at, readAt);
  assert.ok(merged.filter(item => item.sender_ref === 'peer').every(item => item.read_at === null));
});

test('new messages shifting old pages do not skip loaded receipts or infer read state from a neighboring timestamp', async () => {
  const loaded = [message(3), message(2), message(1)];
  const latest = page(Array.from({ length: 20 }, (_, i) => message(30 - i, 'peer')), 20);
  const offsets: number[] = [];
  const receipts = await readLoadedDirectMessageReceipts(latest, loaded, 'sender', async offset => {
    offsets.push(offset);
    return offset === 20 ? page([message(10, 'peer'), { ...loaded[0], read_at: readAt }], 22)
      : page([loaded[1], { ...loaded[2], read_at: readAt }]);
  }, () => true);
  assert.deepEqual(offsets, [20, 22]);
  const merged = mergeDirectMessagePage(latest.items, loaded, receipts!);
  assert.equal(merged.find(item => item.message_id === '0002')!.read_at, null, 'a late-committing row can remain unread');
  assert.equal(merged.find(item => item.message_id === '0001')!.read_at, readAt);
  assert.equal(merged.length, 23, 'receipt lookups do not insert unrequested intermediate history');
});

test('peer or generation changes discard receipt refreshes after the in-flight page returns', async () => {
  let current = true, calls = 0;
  const receipts = await readLoadedDirectMessageReceipts(page([message(3, 'peer')], 1), [message(1)], 'sender', async () => {
    calls++; current = false; return page([message(1, 'sender', readAt)]);
  }, () => current);
  assert.equal(receipts, null); assert.equal(calls, 1);
});

test('permission failures and repeated paging cursors fail visibly instead of fabricating receipts', async () => {
  const failure = new Error('synthetic access revoked');
  await assert.rejects(readLoadedDirectMessageReceipts(page([], 20), [message(1)], 'sender', async () => { throw failure; }, () => true), error => error === failure);
  let calls = 0;
  await assert.rejects(readLoadedDirectMessageReceipts(page([], 20), [message(1)], 'sender', async () => { calls++; return page([], 20); }, () => true), /已讀狀態尚未確認/);
  assert.equal(calls, 1);
});

test('already-read and incoming-only loaded rows need no historical receipt requests', async () => {
  const loaded = [message(2, 'sender', readAt), message(1, 'peer')];
  const receipts = await readLoadedDirectMessageReceipts(page([], 20), loaded, 'sender', async () => { assert.fail('unexpected history request'); }, () => true);
  assert.equal(receipts!.size, 0);
  assert.deepEqual(mergeDirectMessagePage([], loaded, receipts!), loaded);
});

test('a confirmed send keeps receipt refresh dirty when the new outgoing sentinel masks an older read', async () => {
  const older = message(1), newer = message(2), shown = page([newer, older]);
  const activity = { last_message_id: newer.message_id, last_outgoing: { message_id: newer.message_id, read_at: null }, unread_count: 0, can_send: true };
  assert.equal(hasDirectMessageChanges(activity, shown), false, 'the latest-message sentinel alone cannot detect the older read');
  assert.equal(hasDirectMessageChanges(activity, shown, true), true, 'a confirmed send forces receipt reconciliation');
  const latest = page([newer, { ...older, read_at: readAt }]);
  const receipts = await readLoadedDirectMessageReceipts(latest, shown.items, 'sender', async () => { assert.fail('unexpected older page'); }, () => true);
  const refreshed = { ...latest, items: mergeDirectMessagePage(latest.items, shown.items, receipts!) };
  assert.equal(refreshed.items[1].read_at, readAt);
  assert.equal(refreshed.items[0].read_at, null);
  assert.equal(hasDirectMessageChanges(activity, refreshed), false, 'a successful refresh can clear the dirty marker');
});

test('an older receipt committed after the send refresh is reconciled without a newer sentinel change', () => {
  const older = message(1), newer = message(2), shown = page([newer, older]);
  const activity = { last_message_id: newer.message_id, last_outgoing: { message_id: newer.message_id, read_at: null }, unread_count: 0, can_send: true };
  assert.equal(hasDirectMessageChanges(activity, shown), false);
  assert.equal(directMessageReceiptRefreshDue(shown.items, 'sender', 1000, 8999), false);
  assert.equal(directMessageReceiptRefreshDue(shown.items, 'sender', 1000, 9000), true);
  assert.equal(hasDirectMessageChanges(activity, shown, directMessageReceiptRefreshDue(shown.items, 'sender', 1000, 9000)), true);
  assert.equal(directMessageReceiptRefreshDue([message(1, 'peer')], 'sender', 0, 9000), false);
  assert.equal(directMessageReceiptRefreshDue([message(1, 'sender', readAt)], 'sender', 0, 9000), false);
});
