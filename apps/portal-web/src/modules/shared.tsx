import { useRef, useState } from 'react';
import { ApiError, type PortalClient } from '../api';
import type { SessionPayload, TabId } from '../types';

export type ModulePanelProps = {
  client: PortalClient;
  session: SessionPayload;
  onNavigate?: (tab: TabId) => void;
};

// Preserve the exact request's key on unknown network outcomes. A changed draft
// gets a new key; a retry with the same body and version reuses its original key.
export function useModuleMutation(client: PortalClient) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const keys = useRef(new Map<string, string>());
  async function mutate<T>(path: string, body: unknown, ifMatch?: number): Promise<T | undefined> {
    if (pending.current) return undefined;
    const request = JSON.stringify([path, body, ifMatch]);
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await client.post<T>(path, body, { idempotencyKey: key, ifMatch });
      keys.current.delete(request);
      return result;
    } catch (cause) {
      if (!(cause instanceof ApiError) || !cause.network) keys.current.delete(request);
      setError(cause instanceof Error ? cause.message : '操作未完成，請重新整理後重試。');
      return undefined;
    } finally {
      pending.current = false; setBusy(false);
    }
  }
  return { mutate, busy, error, setError };
}
