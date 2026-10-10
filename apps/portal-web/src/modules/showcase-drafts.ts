import { ApiError, type PortalClient } from '../api';
import type { Showcase } from '../types';
import { authoringDraftState, useAuthoringDraft } from './authoring-drafts';

export type PersonalShowcase = Omit<Showcase, 'aggregate_version'> & { status: 'draft' | 'published' | 'withdrawn'; aggregate_version: number | string };
export type ShowcaseInput = { title: string; description: string; artifact_ref: string; public_url: string };
export type ShowcaseRequest = { method: 'POST' | 'PATCH'; path: string; body: object; version?: number | string; key: string };
export const showcaseInput = (row: PersonalShowcase): ShowcaseInput => ({ title: row.title, description: row.description, artifact_ref: row.artifact_ref ?? '', public_url: row.public_url ?? '' });
export const showcaseBody = (input: ShowcaseInput) => ({ title: input.title.trim(), description: input.description.trim(), ...(input.artifact_ref.trim() ? { artifact_ref: input.artifact_ref.trim() } : {}), public_url: input.public_url.trim() || null });
export type ShowcaseEditor = {
  row: PersonalShowcase | null; input: ShowcaseInput; busy: boolean; retry: ShowcaseRequest | null;
  error: string; notice: string; conflict: boolean; confirm: boolean; consent: boolean;
};
const emptyEditor: ShowcaseEditor = { row: null, input: { title: '', description: '', artifact_ref: '', public_url: '' }, busy: false, retry: null, error: '', notice: '', conflict: false, confirm: false, consent: false };
const editorKey = (id: string | null) => `showcase:editor:${id ?? 'new'}`;
const newIdKey = 'showcase:editor:new-id';

// Share the existing memory-only account/session lifetime. After a create is
// acknowledged, the new editor and the saved-ID editor use the same state.
export function showcaseEditorState(userId: string, id: string | null) {
  const newId = authoringDraftState<string | null>(userId, newIdKey, null);
  const scope = () => authoringDraftState(userId, editorKey(id ?? newId.read()), emptyEditor);
  const live = newId.live;
  const read = () => live() ? scope().read() : emptyEditor;
  const write = (next: ShowcaseEditor) => {
    if (!live()) return;
    if (next.row) {
      authoringDraftState(userId, editorKey(next.row.showcase_id), emptyEditor).write(next);
      if (!id) newId.write(next.row.showcase_id);
    } else scope().write(next);
  };
  const patch = (next: Partial<ShowcaseEditor>) => write({ ...read(), ...next });
  const close = () => {
    if (!live() || read().busy) return;
    patch({ confirm: false, consent: false });
    // An unknown create keeps its original new scope and exact retry tuple.
    const saved = read();
    const dirty = saved.row && JSON.stringify(showcaseBody(saved.input)) !== JSON.stringify(showcaseBody(showcaseInput(saved.row)));
    if (saved.row && (id === null || newId.read() === saved.row.showcase_id) && !dirty && !saved.retry && !saved.busy) {
      authoringDraftState(userId, editorKey(null), emptyEditor).write(emptyEditor);
      newId.write(null);
    }
  };
  return { read, write, patch, close, live };
}
export function useShowcaseEditor(userId: string, id: string | null) {
  const [newId] = useAuthoringDraft<string | null>(userId, newIdKey, null);
  const [value] = useAuthoringDraft(userId, editorKey(id ?? newId), emptyEditor);
  return [value, showcaseEditorState(userId, id)] as const;
}

export function reconcilePublishedShowcase(userId: string, items: Showcase[], observed?: Showcase | null, complete = true) {
  const published = authoringDraftState<Showcase | null>(userId, 'showcase:published', null);
  const previous = published.read();
  // A read begun before a new publication cannot invalidate its later receipt.
  if (observed !== undefined && previous !== observed) return;
  if (previous) {
    const found = items.find(item => item.showcase_id === previous.showcase_id);
    // Absence from a partial page is not evidence that a publication vanished.
    if (found || complete) published.write(found ?? null);
  }
}

export async function performShowcaseRequest(client: PortalClient, userId: string, state: ReturnType<typeof showcaseEditorState>, request: ShowcaseRequest) {
  if (!state.live() || state.read().busy) return null;
  const session = client.sessionGeneration;
  const live = () => state.live() && session === client.sessionGeneration;
  state.patch({ busy: true, error: '', notice: '' });
  try {
    const options = { idempotencyKey: request.key, ifMatch: request.version };
    const result = request.method === 'PATCH'
      ? await client.patch<PersonalShowcase>(request.path, request.body, options)
      : await client.post<PersonalShowcase>(request.path, request.body, options);
    if (!live()) return null;
    state.patch({ row: result, input: showcaseInput(result), retry: null, conflict: false, confirm: false, consent: false,
      notice: result.status === 'published' ? '已發布；只有本社群會員可見。' : result.status === 'withdrawn' ? '已撤下；現在只有你可見。' : '私人草稿已儲存；尚未發布。' });
    const published = authoringDraftState<Showcase | null>(userId, 'showcase:published', null);
    if (published.read()?.showcase_id === result.showcase_id) published.write(null);
    return result;
  } catch (cause) {
    if (live()) state.patch({ error: cause instanceof Error ? cause.message : '操作未完成，請重試。', conflict: cause instanceof ApiError && cause.conflict, retry: cause instanceof ApiError && cause.network ? request : null });
    return null;
  } finally {
    if (live()) state.patch({ busy: false });
  }
}
