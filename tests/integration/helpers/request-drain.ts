// Track whole SDK operations as well as server handlers: an operation may not
// have dispatched yet, and an aborted caller may leave its handler running.
export function createRequestDrain() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(operation: Promise<T>): Promise<T> {
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    async drain(): Promise<void> {
      // Settling one operation can dispatch another. Original callers still
      // receive their original rejection; cleanup only waits for quiescence.
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
