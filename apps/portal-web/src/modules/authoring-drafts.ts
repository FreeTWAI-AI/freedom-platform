import { useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';

// Navigation retains author input and owner consent in memory only. Account
// changes discard every type together; credentials must never be stored here.
const drafts = new Map<string, unknown>();
let account: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();
export type SharingMutationScope = { userId: string; type: string };
export type SharingMutationState = {
  keys: Map<string, string>;
  snapshot: { busy: boolean; error: string | null };
  listeners: Set<() => void>;
  live: () => boolean;
};
const mutations = new Map<string, SharingMutationState>();
export function sharingMutationState(scope: SharingMutationScope): SharingMutationState {
  const epoch = generation;
  const key = `${scope.userId}:${scope.type}`;
  let state = mutations.get(key);
  if (!state) {
    state = { keys: new Map(), snapshot: { busy: false, error: null }, listeners: new Set(), live: () => account === scope.userId && generation === epoch };
    mutations.set(key, state);
  }
  return state;
}
export function setSharingDraftAccount(userId: string | null) {
  if (account === userId) return;
  account = userId;
  generation++;
  drafts.clear();
  mutations.clear();
  for (const notify of listeners) notify();
}

export function useAuthoringDraft<T>(userId: string, key: string, initial: T): [T, Dispatch<SetStateAction<T>>, () => boolean] {
  const epoch = generation;
  const fallback = useRef({ userId, epoch, value: initial });
  if (fallback.current.userId !== userId || fallback.current.epoch !== epoch) fallback.current = { userId, epoch, value: initial };
  const current = () => account === userId && generation === epoch;
  const value = useSyncExternalStore(
    notify => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => current() && drafts.has(key) ? drafts.get(key) as T : fallback.current.value,
  );
  const change: Dispatch<SetStateAction<T>> = next => {
    if (!current()) return;
    const previous = drafts.has(key) ? drafts.get(key) as T : value;
    const updated = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
    drafts.set(key, updated);
    for (const notify of listeners) notify();
  };
  return [value, change, current];
}
