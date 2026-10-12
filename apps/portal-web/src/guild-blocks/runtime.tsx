import {Component, lazy, Suspense, useState, type ComponentType, type ReactNode} from 'react';
import type {GuildBlockProps} from '../../../../packages/guild-presentation/block';

export type GuildBlockModule = {default: ComponentType<GuildBlockProps>; title: string};
export type GuildBlockLoaders = Readonly<Record<string, () => Promise<GuildBlockModule>>>;
const cache = new WeakMap<() => Promise<GuildBlockModule>, ComponentType<GuildBlockProps & {heading?: string | null}>>();

class BlockBoundary extends Component<{children: ReactNode; retry: () => void}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() {return {failed: true};}
  render() {
    return this.state.failed ? <div className="stack"><p role="alert">這個公會區塊暫時無法顯示。其他區塊仍可使用。</p>
      <div className="actions"><button type="button" className="btn btn-ghost btn-small" onClick={this.props.retry}>重新顯示區塊</button></div></div>
      : this.props.children;
  }
}

/** Reviewed, bundled components; an error boundary is not a security sandbox. */
export function GuildBlock({id, heading, loaders, ...props}: GuildBlockProps & {id: string; heading?: string | null; loaders: GuildBlockLoaders}) {
  const [attempt, setAttempt] = useState(0);
  const load = Object.hasOwn(loaders, id) ? loaders[id] : undefined;
  if (!load) return <p role="status">這個區塊的版本目前無法使用。請會長選擇已核准的區塊。</p>;
  let View = cache.get(load);
  if (!View) {
    View = lazy(async () => {const module = await load(); return {default: ({heading: label, ...ports}: GuildBlockProps & {heading?: string | null}) => <><h2>{label ?? module.title}</h2><module.default {...ports}/></>};});
    cache.set(load, View);
  }
  return <BlockBoundary key={`${id}:${props.client.sessionGeneration}:${props.viewer}:${attempt}`} retry={() => {cache.delete(load); setAttempt(value => value + 1);}}><Suspense fallback={<p role="status">正在載入公會區塊…</p>}><View heading={heading} {...props}/></Suspense></BlockBoundary>;
}
