import {useEffect, useState} from 'react';

/** Presentation ports only. Every domain endpoint still checks current authority. */
export type GuildReadClient = {
  readonly sessionGeneration: number;
  get<T>(path: string, options?: {signal?: AbortSignal}): Promise<T>;
};
export type GuildBlockProps = {
  viewer: 'visitor' | 'member' | 'read_only';
  client: GuildReadClient;
  navigate: (path: string) => void;
  /** The existing application launcher owns eligibility, creation and leave guards. */
  startApplication?: (applicationKey: string) => void;
  startableApplications?: readonly string[];
  /** Optional. The site's supplier-console flag; absent or false means OFF, so no console endpoint is read. */
  supplierConsoleEnabled?: boolean;
  /** Optional. Only a guild page that already knows its key should pass it. */
  guildKey?: string;
};
export type ReadState<T> =
  | {kind: 'visitor' | 'loading' | 'denied' | 'unavailable' | 'error'}
  | {kind: 'ready'; data: T};

export function useGuildRead<T>(client: GuildReadClient, viewer: GuildBlockProps['viewer'], path: string, parse: (value: unknown) => T) {
  const generation = client.sessionGeneration;
  const [snapshot, setSnapshot] = useState<{client: GuildReadClient; generation: number; viewer: GuildBlockProps['viewer']; path: string; state: ReadState<T>} | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const setState = (state: ReadState<T>) => setSnapshot({client, generation, viewer, path, state});
    if (viewer === 'visitor') {setState({kind: 'visitor'}); return;}
    const controller = new AbortController();
    const live = () => !controller.signal.aborted && generation === client.sessionGeneration;
    setState({kind: 'loading'});
    void client.get(path, {signal: controller.signal}).then(value => {
      const data = parse(value);
      if (live()) setState({kind: 'ready', data});
    }).catch(error => {
      if (!live()) return;
      const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
      setState({kind: status === 401 || status === 403 ? 'denied' : status === 404 ? 'unavailable' : 'error'});
    });
    return () => controller.abort();
  }, [client, generation, viewer, path, parse, attempt]);
  // Fence the render itself, not only the later effect and response callback.
  const state: ReadState<T> = viewer === 'visitor' ? {kind: 'visitor'}
    : snapshot?.client === client && snapshot.generation === generation && snapshot.viewer === viewer && snapshot.path === path
      ? snapshot.state : {kind: 'loading'};
  return {state, retry: () => setAttempt(value => value + 1)};
}
