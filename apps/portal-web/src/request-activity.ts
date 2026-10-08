/** Aggregate transport activity only: no URL, account, payload or success claims. */
type Snapshot = Readonly<{pending: number; mutations: number}>;
const empty: Snapshot = Object.freeze({pending: 0, mutations: 0});
let snapshot: Snapshot = empty;
const active = new Map<symbol, boolean>();
const listeners = new Set<() => void>();
function publish() {
  snapshot = active.size ? Object.freeze({pending: active.size, mutations: [...active.values()].filter(Boolean).length}) : empty;
  for (const listener of listeners) listener();
}
export const requestActivity = {
  snapshot: () => snapshot,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function beginRequest(mutation: boolean) {
  const id = Symbol();
  active.set(id, mutation); publish();
  return () => { if (active.delete(id)) publish(); };
}
