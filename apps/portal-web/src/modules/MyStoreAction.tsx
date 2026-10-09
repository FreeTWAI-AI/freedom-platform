import {useEffect, useRef, useState} from 'react';
import type {z} from 'zod';
import {MyStoresPageSchema} from '../../../../contracts/guild-launchpad/v1/storefront-pagination';
import type {PortalClient} from '../api';

type MyStores = z.infer<typeof MyStoresPageSchema>;
export const stateWord = (item: MyStores['items'][number]) => item.setup_state === 'setup_required' ? '待設定'
  : {never_published: '尚未發布', published: '已發布', unpublished: '已停止公開'}[item.publication_state];
export function useMyStores(client: PortalClient) {
  const [data, setData] = useState<MyStores | null>(null);
  const [error, setError] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; busy.current = false;
    setData(null); setError(false); setPageError(false); setLoadingMore(false);
    void client.get('/me/stores?pagination=cursor', {signal: controller.signal}).then(raw => {
      const next = MyStoresPageSchema.parse(raw); if (!controller.signal.aborted) setData(next);
    }).catch(() => {if (!controller.signal.aborted) setError(true);});
    return () => controller.abort();
  }, [client, refresh]);
  async function loadMore() {
    const controller = request.current;
    if (!data?.next_cursor || !controller || controller.signal.aborted || busy.current) return;
    busy.current = true; setLoadingMore(true); setPageError(false);
    try {
      const next = MyStoresPageSchema.parse(await client.get(`/me/stores?pagination=cursor&cursor=${encodeURIComponent(data.next_cursor)}`, {signal: controller.signal}));
      if (!controller.signal.aborted) setData(current => {
        if (!current) return current;
        const known = new Set(current.items.map(item => item.instance_id));
        return {...next, items: [...current.items, ...next.items.filter(item => !known.has(item.instance_id))]};
      });
    } catch { if (!controller.signal.aborted) setPageError(true); }
    finally { if (!controller.signal.aborted) { busy.current = false; setLoadingMore(false); } }
  }
  return {data, error, retry: () => setRefresh(value => value + 1), loadMore, loadingMore, pageError};
}
export function MyStoreAction({client, canStart, reasons, onCreate, onEnter}: {
  client: PortalClient; canStart: boolean; reasons: string[]; onCreate: () => void; onEnter: (path: string) => void;
}) {
  const {data, error, retry} = useMyStores(client);
  if (error) return <><p role="alert" className="field-hint">暫時無法讀取你的商店。</p><div className="actions"><button type="button" className="btn btn-ghost" onClick={retry}>重試</button></div></>;
  if (!data) return <p role="status">正在確認你的商店…</p>;
  if (data.items.length) return <>
    {data.items.slice(0, 3).map(item => <p key={item.instance_id}>{item.name ?? '尚未完成設定'}・{stateWord(item)}</p>)}
    <div className="actions"><button type="button" className="btn btn-primary" onClick={() => onEnter(data.items.length === 1 && !data.next_cursor ? `#stores/${data.items[0].tenant_id}/${data.items[0].instance_id}` : '#stores')}>進入我的商店</button></div>
  </>;
  if (data.next_cursor) return <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => onEnter('#stores')}>查看我的商店</button></div>;
  return <><div className="actions"><button type="button" className="btn btn-primary" disabled={!canStart} onClick={onCreate}>建立我的商店</button></div>
    {reasons.map((reason, index) => <p className="field-hint" key={index}>{reason}</p>)}
    <p className="field-hint">交易尚未啟用，只提供店鋪與商品展示。</p></>;
}
