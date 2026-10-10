import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type PortalClient } from '../../apps/portal-web/src/api.js';
import { authoringDraftState, setSharingDraftAccount } from '../../apps/portal-web/src/modules/authoring-drafts.js';
import { showcaseEditorState, performShowcaseRequest, showcaseBody, reconcilePublishedShowcase, type PersonalShowcase, type ShowcaseRequest } from '../../apps/portal-web/src/modules/showcase-drafts.js';
import type { Showcase } from '../../apps/portal-web/src/types.js';

let generation = 0;
beforeEach(() => setSharingDraftAccount('owner', ++generation));
const row = (status: PersonalShowcase['status'] = 'draft'): PersonalShowcase => ({ showcase_id: 'saved-id', owner_ref: 'owner', owner_name: 'Owner', title: 'Saved once', description: 'Description', artifact_ref: 'artifact:saved', public_url: null, status, visibility: status === 'published' ? 'community' : 'private', aggregate_version: 1 });
function transport() {
  const calls: unknown[] = [], pending: { resolve: (value: PersonalShowcase) => void; reject: (cause: unknown) => void }[] = [];
  const invoke = (method: string) => (path: string, body: unknown, options: unknown) => new Promise<PersonalShowcase>((resolve, reject) => { calls.push({ method, path, body: structuredClone(body), options: structuredClone(options) }); pending.push({ resolve, reject }); });
  const client = { sessionGeneration: generation, post: invoke('POST'), patch: invoke('PATCH') } as unknown as PortalClient;
  return { client, calls, pending };
}
const createRequest = (): ShowcaseRequest => ({ method: 'POST', path: '/me/showcases', body: { title: 'Saved once', description: 'Description', public_url: null }, key: 'exact-create-key' });

test('unknown create survives Close/reopen and replays exact method, body, key and version', async () => {
  const { client, calls, pending } = transport(), state = showcaseEditorState('owner', null), request = createRequest();
  state.patch({ input: { title: 'Saved once', description: 'Description', artifact_ref: '', public_url: '' } });
  const first = performShowcaseRequest(client, 'owner', state, request);
  pending[0].reject(new ApiError({ message: 'Committed acknowledgement lost', network: true }));
  assert.equal(await first, null);
  state.close();
  const reopened = showcaseEditorState('owner', null);
  assert.deepEqual(reopened.read().retry, request);
  assert.equal(reopened.read().input.title, 'Saved once');
  const retried = performShowcaseRequest(client, 'owner', reopened, reopened.read().retry!);
  assert.deepEqual(calls[1], calls[0]);
  pending[1].resolve(row()); await retried;
  assert.equal(reopened.read().row?.showcase_id, 'saved-id');
  assert.equal(reopened.read().retry, null);
});

test('saved-new dirty edits survive Close and reopen through both new and saved-ID scopes, then PATCH the same ID', async () => {
  const { client, calls, pending } = transport(), state = showcaseEditorState('owner', null);
  const first = performShowcaseRequest(client, 'owner', state, createRequest()); pending[0].resolve(row()); await first;
  state.patch({ input: { ...state.read().input, title: 'Unsent revised title' } });
  state.close();
  const reopened = showcaseEditorState('owner', 'saved-id');
  assert.equal(reopened.read().input.title, 'Unsent revised title');
  assert.equal(showcaseEditorState('owner', null).read().input.title, 'Unsent revised title');
  const saved = reopened.read().row!;
  const request: ShowcaseRequest = { method: 'PATCH', path: `/me/showcases/${saved.showcase_id}`, body: showcaseBody(reopened.read().input), version: saved.aggregate_version, key: 'edit-key' };
  const edited = performShowcaseRequest(client, 'owner', reopened, request);
  assert.deepEqual(calls[1], { method: 'PATCH', path: '/me/showcases/saved-id', body: { title: 'Unsent revised title', description: 'Description', artifact_ref: 'artifact:saved', public_url: null }, options: { idempotencyKey: 'edit-key', ifMatch: 1 } });
  pending[1].resolve({ ...row(), title: 'Unsent revised title', aggregate_version: 2 }); await edited;
  reopened.close();
  assert.equal(showcaseEditorState('owner', null).read().row, null);
  assert.equal(showcaseEditorState('owner', 'saved-id').read().row?.aggregate_version, 2);
});

test('pending request is single-flight through unmount and persists its eventual receipt', async () => {
  const { client, pending, calls } = transport(), state = showcaseEditorState('owner', null);
  const first = performShowcaseRequest(client, 'owner', state, createRequest());
  const remounted = showcaseEditorState('owner', null);
  assert.equal(remounted.read().busy, true);
  assert.equal(await performShowcaseRequest(client, 'owner', remounted, createRequest()), null);
  assert.equal(calls.length, 1); pending[0].resolve(row()); await first;
  assert.equal(remounted.read().row?.showcase_id, 'saved-id'); assert.equal(remounted.read().busy, false);
});

test('withdraw clears the original publication cache and an authoritative missing row cannot resurrect it', async () => {
  const published = authoringDraftState<Showcase | null>('owner', 'showcase:published', null);
  published.write({ ...row('published'), aggregate_version: 1 });
  reconcilePublishedShowcase('owner', []); assert.equal(published.read(), null);
  published.write({ ...row('published'), aggregate_version: 1 });
  const { client, pending } = transport(), state = showcaseEditorState('owner', 'saved-id');
  const withdrawn = performShowcaseRequest(client, 'owner', state, { method: 'POST', path: '/me/showcases/saved-id/withdraw', body: {}, version: 1, key: 'withdraw-key' });
  pending[0].resolve(row('withdrawn')); await withdrawn;
  assert.equal(published.read(), null); assert.equal(state.read().row?.status, 'withdrawn');
});

test('partial showcase pages retain a receipt until its row arrives or the complete union proves absence', () => {
  const published = authoringDraftState<Showcase | null>('owner', 'showcase:published', null);
  const receipt = {...row('published'), aggregate_version: 1};
  published.write(receipt);
  reconcilePublishedShowcase('owner', [], receipt, false);
  assert.equal(published.read(), receipt);
  const refreshed = {...receipt, title: 'Current title'};
  reconcilePublishedShowcase('owner', [refreshed], receipt, true);
  assert.equal(published.read(), refreshed);
  reconcilePublishedShowcase('owner', [], refreshed, false);
  assert.equal(published.read(), refreshed);
  reconcilePublishedShowcase('owner', [], refreshed, true);
  assert.equal(published.read(), null);
});

test('an exhausted older pagination generation cannot clear a newer publication receipt', () => {
  const published = authoringDraftState<Showcase | null>('owner', 'showcase:published', null);
  const observed = {...row('published'), aggregate_version: 1};
  published.write(observed);
  const newer = {...observed, showcase_id: 'newer-publication'};
  published.write(newer);
  reconcilePublishedShowcase('owner', [], observed, true);
  assert.equal(published.read(), newer);
});

for (const boundary of ['switch', 'same-user replacement', 'logout'] as const) test(`${boundary} clears private editor input/retry and fences delayed receipts`, async () => {
  const { client, pending } = transport(), state = showcaseEditorState('owner', null);
  state.patch({ input: { title: 'Private input', description: 'Secret', artifact_ref: '', public_url: '' } });
  const request = performShowcaseRequest(client, 'owner', state, createRequest());
  setSharingDraftAccount(boundary === 'switch' ? 'other' : boundary === 'logout' ? null : 'owner', ++generation);
  if (boundary === 'logout') setSharingDraftAccount('owner', ++generation);
  pending[0].resolve(row()); assert.equal(await request, null);
  assert.equal(state.live(), false); assert.equal(showcaseEditorState('owner', null).read().row, null);
  assert.equal(showcaseEditorState('owner', null).read().input.title, '');
});

 test('a gallery read started before publication cannot discard the newer receipt', () => {
  const published = authoringDraftState<Showcase | null>('owner', 'showcase:published', null);
  const observed = published.read();
  published.write({ ...row('published'), aggregate_version: 1 });
  reconcilePublishedShowcase('owner', [], observed);
  assert.equal(published.read()?.showcase_id, 'saved-id');
 });
