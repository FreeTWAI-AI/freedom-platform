import type {ReadState} from '../../../../packages/guild-presentation/block';

export function GuildBlockState({state, retry, noun}: {state: ReadState<unknown>; retry: () => void; noun: string}) {
  if (state.kind === 'ready') return null;
  if (state.kind === 'visitor') return <p>登入後可查看自己的{noun}；公會公開頁不會顯示私人資料。</p>;
  if (state.kind === 'loading') return <p role="status">正在讀取{noun}…</p>;
  if (state.kind === 'denied') return <p role="status">目前身分無法讀取{noun}。請確認登入身分與既有授權。</p>;
  if (state.kind === 'unavailable') return <p role="status">此環境尚未提供{noun}。</p>;
  return <div className="stack"><p role="alert">暫時無法讀取{noun}，已保存的內容不會因此改變。</p>
    <div className="actions"><button type="button" className="btn btn-ghost btn-small" onClick={retry}>重新讀取</button></div></div>;
}
