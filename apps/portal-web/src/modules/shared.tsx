import { useRef, useSyncExternalStore, type SetStateAction } from 'react';
import { ApiError, type PortalClient } from '../api';
import type { SessionPayload, TabId } from '../types';
import { sharingMutationState, type SharingMutationScope, type SharingMutationState } from './authoring-drafts';

export type ModulePanelProps = {
  client: PortalClient;
  session: SessionPayload;
  onNavigate?: (tab: TabId) => void;
};

// Preserve the exact request's key on unknown network outcomes. A changed draft
// gets a new key; a retry with the same body and version reuses its original key.
export function useModuleMutation(client: PortalClient, authorScope?: SharingMutationScope) {
  const local = useRef<SharingMutationState | null>(null);
  if (!local.current) local.current = { keys: new Map(), snapshot: { busy: false, error: null }, listeners: new Set(), live: () => true };
  const state = authorScope ? sharingMutationState(authorScope) : local.current;
  const { busy, error } = useSyncExternalStore(
    notify => { state.listeners.add(notify); return () => { state.listeners.delete(notify); }; },
    () => state.snapshot,
  );
  function update(patch: Partial<SharingMutationState['snapshot']>) {
    if (!state.live()) return;
    state.snapshot = { ...state.snapshot, ...patch };
    for (const notify of state.listeners) notify();
  }
  function setError(next: SetStateAction<string | null>) {
    update({ error: typeof next === 'function' ? next(state.snapshot.error) : next });
  }
  async function mutate<T>(path: string, body: unknown, ifMatch?: number): Promise<T | undefined> {
    if (!state.live() || state.snapshot.busy) return undefined;
    const request = JSON.stringify([path, body, ifMatch]);
    const key = state.keys.get(request) ?? crypto.randomUUID();
    state.keys.set(request, key);
    update({ busy: true, error: null });
    try {
      const result = await client.post<T>(path, body, { idempotencyKey: key, ifMatch });
      if (!state.live()) return undefined;
      state.keys.delete(request);
      return result;
    } catch (cause) {
      if (!state.live()) return undefined;
      if (!(cause instanceof ApiError) || !cause.network) state.keys.delete(request);
      update({ error: cause instanceof Error ? cause.message : '操作未完成，請重新整理後重試。' });
      return undefined;
    } finally {
      update({ busy: false });
    }
  }
  return { mutate, busy, error, setError };
}
