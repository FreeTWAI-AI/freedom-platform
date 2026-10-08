import {useEffect, useState} from 'react';
import type {z} from 'zod';
import {MyStoresSchema} from '../../../../contracts/guild-launchpad/v1/storefront';
import type {PortalClient} from '../api';

type MyStores = z.infer<typeof MyStoresSchema>;
export const stateWord = (item: MyStores['items'][number]) => item.setup_state === 'setup_required' ? '待設定'
  : {never_published: '尚未發布', published: '已發布', unpublished: '已停止公開'}[item.publication_state];
export function useMyStores(client: PortalClient) {
  const [data, setData] = useState<MyStores | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(false);
    void client.get('/me/stores', {signal: controller.signal}).then(raw => {
      const next = MyStoresSchema.parse(raw); if (!controller.signal.aborted) setData(next);
    }).catch(() => {if (!controller.signal.aborted) setError(true);});
    return () => controller.abort();
  }, [client, refresh]);
  return {data, error, retry: () => setRefresh(value => value + 1)};
}
export function MyStoreAction({client, canStart, reasons, onCreate, onEnter}: {
  client: PortalClient; canStart: boolean; reasons: string[]; onCreate: () => void; onEnter: (path: string) => void;
}) {
  const {data, error, retry} = useMyStores(client);
  if (error) return <><p role="alert" className="field-hint">暫時無法讀取你的商店。</p><div className="actions"><button type="button" className="btn btn-ghost" onClick={retry}>重試</button></div></>;
  if (!data) return <p role="status">正在確認你的商店…</p>;
  if (data.items.length) return <>
    {data.items.slice(0, 3).map(item => <p key={item.instance_id}>{item.name ?? '尚未完成設定'}・{stateWord(item)}</p>)}
    <div className="actions"><button type="button" className="btn btn-primary" onClick={() => onEnter(data.items.length === 1 ? `#stores/${data.items[0].tenant_id}/${data.items[0].instance_id}` : '#stores')}>進入我的商店</button></div>
  </>;
  return <><div className="actions"><button type="button" className="btn btn-primary" disabled={!canStart} onClick={onCreate}>建立我的商店</button></div>
    {reasons.map((reason, index) => <p className="field-hint" key={index}>{reason}</p>)}
    <p className="field-hint">交易尚未啟用，只提供店鋪與商品展示。</p></>;
}
