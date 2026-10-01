import {useEffect,useRef,useState} from 'react';
import {formatIsoLocal} from '../format';
import type {GuildReport} from '../../../../modules/community/guild-discovery';
import './MemberConnections.css';
type Result={generated_at:string|null;next_attempt_at:string|null;ai_configured:boolean;report:GuildReport};
type Client={request<T>(path:string,body?:unknown):Promise<T>};
export function GuildDiscoveryReport({client}:{client:Client}){
  const [data,setData]=useState<Result|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[open,setOpen]=useState(false),generation=useRef(0);
  async function load(refresh=false){const current=++generation.current;setLoading(true);setError('');try{const result=await client.request<Result>(refresh?'/guild-discovery/refresh':'/guild-discovery',refresh?{}:undefined);if(current===generation.current)setData(result);}catch(cause){if(current===generation.current)setError(cause instanceof Error?cause.message:'分析報告暫時無法載入。');}finally{if(current===generation.current)setLoading(false);}}
  useEffect(()=>{if(open)void load();return()=>{generation.current++;};},[client,open]);
  return <section className="card stack guild-discovery-report"><div className="card-head"><h2>公會主題與重疊分析</h2><button type="button" className="btn btn-ghost" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'收起分析':'查看分析'}</button></div><p>每天整理公會目的與共同技能書，提供合作、分工或整合建議供管理者討論。</p>
    {open&&<>{loading&&<p role="status">正在讀取分析…</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}{data&&<><p className="field-hint">{data.report.method==='ai'?'AI 分析，待人工確認':'依公會目錄與技能書比對'} · {data.generated_at?`更新於 ${formatIsoLocal(data.generated_at)}`:'定期分析尚未執行，顯示目前目錄比對'}</p>
      {data.report.ai_status==='unavailable'||data.report.ai_status==='invalid_response'?<p className="field-hint">AI 本次沒有提供可用結果，已保留目錄比對。</p>:null}
      {!data.ai_configured&&<p className="field-hint">AI 分析尚未啟用；管理者可依部署文件設定分析模型。目錄比對仍可使用。</p>}
      {data.report.pairs.length?<div className="guild-review-pairs">{data.report.pairs.map(pair=><article className="guild-review-pair" key={pair.guild_keys.join('/')}><h3>{pair.names.join(' × ')}</h3><span className="badge">{pair.suggestion==='collaborate'?'可先共作':pair.suggestion==='consider_merge'?'可討論整合':'釐清分工'}</span><p>{pair.reason}</p><p className="muted">{pair.difference}</p>{pair.shared_topics.length>0&&<p>共同主題：{pair.shared_topics.join('、')}</p>}{pair.shared_books.length>0&&<p>共同技能書：{pair.shared_books.join('、')}</p>}</article>)}</div>:<p>目前沒有需要討論的重疊組合。</p>}
      <p className="field-hint">分析不會改動公會、會員或技能書。下一次可更新：{data.next_attempt_at?formatIsoLocal(data.next_attempt_at):'尚未排定'}。</p></>}
      <div className="actions"><button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void load()}>重讀分析</button><button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void load(true)}>更新到期分析</button></div>
    </>}
  </section>;
}
