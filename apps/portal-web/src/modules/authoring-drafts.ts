import { useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';

// Navigation retains input and consent in memory only. A different account or
// client session generation discards all types. No credentials are stored here.
const drafts = new Map<string, unknown>();
let account: string | null = null;
let generation = 0;
let sessionGeneration: number | null = null;
const listeners = new Set<() => void>();
export type SharingMutationScope = { userId: string; type: string };
export type SharingMutationState = {
  keys: Map<string, string>;
  snapshot: { busy: boolean; error: string | null; lastFailureUnknown: boolean };
  listeners: Set<() => void>;
  live: () => boolean;
};
const mutations = new Map<string, SharingMutationState>();
export function sharingMutationState(scope: SharingMutationScope): SharingMutationState {
  const epoch = generation;
  const key = `${scope.userId}:${scope.type}`;
  let state = mutations.get(key);
  if (!state) {
    state = { keys: new Map(), snapshot: { busy: false, error: null, lastFailureUnknown: false }, listeners: new Set(), live: () => account === scope.userId && generation === epoch };
    mutations.set(key, state);
  }
  return state;
}
export function setSharingDraftAccount(userId: string | null, nextSessionGeneration: number) {
  if (account === userId && sessionGeneration === nextSessionGeneration) return;
  account = userId;
  sessionGeneration = nextSessionGeneration;
  generation++;
  drafts.clear();
  mutations.clear();
  for (const notify of listeners) notify();
}

// The hook and pure tests use the same lifetime-fenced store operations.
export function authoringDraftState<T>(userId: string, key: string, initial: T) {
  const epoch = generation;
  const live = () => account === userId && generation === epoch;
  const read = () => live() && drafts.has(key) ? drafts.get(key) as T : initial;
  const write: Dispatch<SetStateAction<T>> = next => {
    if (!live()) return;
    drafts.set(key, typeof next === 'function' ? (next as (value: T) => T)(read()) : next);
    for (const notify of listeners) notify();
  };
  return { read, write, live };
}
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
export function useAuthoringDraft<T>(userId: string, key: string, initial: T): [T, Dispatch<SetStateAction<T>>, () => boolean] {
  const fallback = useRef({ userId, key, epoch: generation, state: authoringDraftState(userId, key, initial) });
  if (fallback.current.userId !== userId || fallback.current.key !== key || fallback.current.epoch !== generation) {
    fallback.current = { userId, key, epoch: generation, state: authoringDraftState(userId, key, initial) };
  }
  const state = fallback.current.state;
  const value = useSyncExternalStore(subscribe, state.read);
  return [value, state.write, state.live];
}
