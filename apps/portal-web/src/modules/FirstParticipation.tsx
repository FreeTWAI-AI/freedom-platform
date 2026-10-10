import {useCallback, useEffect, useRef, useState} from 'react';
import {ApiError} from '../api';
import type {ModulePanelProps} from './shared';
import {openMemberChat} from './chat-entry';
import './FirstParticipation.css';

type Completion = {kind:'work'|'guild_message';source_id:string;created_at:string;title:string|null;href:string;audience:'community'|'guild';reply_count:number|null};
type Claimant = {user_id:string;display_name:string};
type Participation = {aggregate_version:number;choice:null|'work'|'introduction';state:'offered'|'chosen'|'completed'|'source_unavailable'|'skipped'|'dismissed';guild_key:string|null;started_at:string|null;completion:Completion|null;resume:null|{kind:'work_draft';source_id:string;href:string};reception:{requested:boolean;state:'not_requested'|'unclaimed'|'claimed'|'stopped';claimant:Claimant|null}};
type ReceptionItem = {user_id:string;display_name:string;aggregate_version:number;choice:Participation['choice'];completion:Completion;claimant:Claimant|null};
type Queue = {items:ReceptionItem[];next_offset:number|null};
type Action = {action:'choose';choice:'work'|'introduction'}|{action:'skip'|'dismiss'|'resume'|'request_reception'|'stop_reception'};
type Attempt = {path:string;body:Action|Record<string,never>;version:number;key:string;open?:'work'|'introduction'};
type Props = ModulePanelProps & {primaryGuild:{guild_key:string;name:string};firstParticipationEnabled:boolean};
const path = '/me/first-participation';

export function FirstParticipation(props:Props) {
  if (!props.firstParticipationEnabled) return null;
  return <ParticipationGuide key={`${props.session.user.user_id}:${props.session.csrf_token}:${props.primaryGuild.guild_key}`} {...props}/>;
}

function ParticipationGuide({client,session,onNavigate,primaryGuild}:Props) {
  const [data,setData] = useState<Participation|null>(null);
  const [loading,setLoading] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [retry,setRetry] = useState(false);
  const [queue,setQueue] = useState<Queue|null>(null);
  const [queueOpen,setQueueOpen] = useState(false);
  const [queueLoading,setQueueLoading] = useState(false);
  const [queueError,setQueueError] = useState<string|null>(null);
  const live = useRef(false), reading = useRef(0), queueReading = useRef(0);
  const pending = useRef<Attempt|null>(null), sending = useRef(false);
  const queueVisible = useRef(false);
  queueVisible.current = queueOpen;

  const load = useCallback(async () => {
    const ticket = ++reading.current;
    setLoading(true);
    // Current source permissions are reread; a failed refresh must not leave a private label/link visible.
    setData(null);
    try {
      const result = await client.get<Participation>(path);
      if (!live.current || ticket !== reading.current) return;
      setData(result);
      return result;
    } catch (cause) {
      if (live.current && ticket === reading.current) setError(cause instanceof Error ? cause.message : '參與進度未能載入。');
    } finally { if (live.current && ticket === reading.current) setLoading(false); }
  },[client]);
  const loadQueue = useCallback(async (offset=0) => {
    const ticket = ++queueReading.current;
    setQueue(null); setQueueLoading(true); setQueueError(null);
    try {
      const result = await client.get<Queue>(`/first-participation/reception?offset=${offset}`);
      if (live.current && ticket === queueReading.current) setQueue(result);
    } catch (cause) {
      if (live.current && ticket === queueReading.current) setQueueError(cause instanceof Error ? cause.message : '接待需求未能載入。');
    } finally { if (live.current && ticket === queueReading.current) setQueueLoading(false); }
  },[client]);
  useEffect(() => {
    live.current = true;
    void load();
    const refresh = () => { if (!sending.current) { void load(); if (queueVisible.current) void loadQueue(); } };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus',refresh); window.addEventListener('hashchange',refresh);
    document.addEventListener('visibilitychange',visible);
    return () => {
      live.current = false; reading.current++; queueReading.current++;
      window.removeEventListener('focus',refresh); window.removeEventListener('hashchange',refresh);
      document.removeEventListener('visibilitychange',visible);
    };
  },[load,loadQueue,primaryGuild.guild_key]);

  function open(choice:'work'|'introduction',guildKey?:string|null) {
    if (choice === 'work') onNavigate?.('showcase');
    else if (guildKey) openMemberChat('guild',guildKey);
  }
  async function send(attempt:Attempt) {
    if (sending.current || !live.current) return;
    sending.current = true; pending.current = attempt; setBusy(true); setError(null); setRetry(false);
    reading.current++; queueReading.current++; setData(null); setQueue(null);
    try {
      await client.post(attempt.path,attempt.body,{ifMatch:attempt.version,idempotencyKey:attempt.key});
      if (!live.current) return;
      pending.current = null;
      const current = await load();
      if (!live.current) return;
      if (queueVisible.current) await loadQueue();
      if (live.current && attempt.open && current?.choice === attempt.open && current.state === 'chosen') open(attempt.open,current.guild_key);
    } catch (cause) {
      if (!live.current) return;
      const uncertain = !(cause instanceof ApiError) || cause.network || cause.timedOut;
      if (!uncertain) pending.current = null;
      setRetry(uncertain);
      setError(cause instanceof Error ? cause.message : '操作未完成，請重試。');
      // Keep the exact command/body/version/key after an unknown outcome; no different command may replace it.
      if (!uncertain) { await load(); if (queueVisible.current) await loadQueue(); }
    } finally {
      sending.current = false;
      if (live.current) setBusy(false);
    }
  }
  function action(body:Action,openAfter?:Attempt['open']) {
    if (!data || pending.current) return;
    void send({path,body,version:data.aggregate_version,key:crypto.randomUUID(),open:openAfter});
  }
  const disabled = busy || loading || retry;
  const quiet = data?.state === 'skipped' || data?.state === 'dismissed';
  const chosenGuildCurrent = data?.guild_key === primaryGuild.guild_key;

  return <div className="first-participation">
    <div className="first-participation-heading"><strong>第一次參與 · 選填</strong><button className="btn btn-ghost" type="button" disabled={busy||loading||retry} onClick={()=>{setError(null);void load();}}>重新讀取進度</button></div>
    {loading && <p role="status">正在讀取真實參與進度…</p>}
    {error && <div role="alert"><p>{error}</p>{retry && <><p>結果尚未確認；保留原操作，不會另送一份內容。</p><button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>{if(pending.current)void send(pending.current);}}>重試同一操作</button></>}</div>}
    {data && <>
      {quiet ? <><p>{data.state === 'dismissed' ? '已停止提示。' : '已略過第一次參與。'}常用入口仍可照常使用。</p><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'resume'})}>重新啟用參與引導</button></> : <>
        <p>不用補做完整定位，也不用綁定 GitHub、AI 或社群帳號。選一條路，實際送出後才會記錄成果；點開頁面不算完成。</p>
        {data.state === 'offered' && <div className="first-participation-actions"><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'choose',choice:'work'},'work')}>選擇分享自己的作品</button><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'choose',choice:'introduction'},'introduction')}>選擇在{primaryGuild.name}介紹自己</button></div>}
        {data.state === 'chosen' && <>
          <p role="status">已選擇{data.choice === 'work' ? '分享作品' : '公會自我介紹'}，尚未確認實際發布。{data.started_at && <> 起始時間：<time dateTime={data.started_at}>{new Date(data.started_at).toLocaleString()}</time>。</>}</p>
          {data.choice === 'work' ? <><p>前往原作品分享表單，填必要欄位；確認原作與分享同意後，才發布到社群作品。私人草稿不算完成。</p><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>open('work')}>回到原分享表單</button></> : <><p>內容只在所選公會原聊天室送出，由有權的公會成員閱讀。未送出的聊天文字只在目前瀏覽器記憶體，不保證重新登入後保留。</p>{chosenGuildCurrent ? <button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>open('introduction',data.guild_key)}>回到原公會聊天室</button> : <p>目前主要公會已改變；請重新選擇目前公會，不會把其他聊天室訊息算成這次參與。</p>}</>}
          {data.resume && <p><a href={data.resume.href}>回到我的內容中的原私人作品草稿</a>（尚未完成）</p>}
          <details><summary>換一條參與路徑</summary><div className="first-participation-actions"><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'choose',choice:'work'},'work')}>改選分享作品</button><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'choose',choice:'introduction'},'introduction')}>改選目前公會自我介紹</button></div></details>
        </>}
        {data.state === 'completed' && data.completion && <div role="status"><p>已確認實際{data.completion.kind === 'work' ? '作品發布' : '公會訊息送出'}：<a href={data.completion.href}>{data.completion.title ?? '查看原內容'}</a>。</p><p>誰能看到：{data.completion.audience === 'guild' ? '有權的所選公會成員（非公開貼文）' : '有權的社群成員'}。在原內容查看回應；{data.completion.kind === 'work' ? '作品可透過原合作需求入口交流，自己的需求在原作品與商機查看' : '在原公會聊天室人工交流'}。{data.completion.reply_count === null ? '目前無權讀取回應數。' : <>目前可讀的{data.completion.kind === 'work' ? '私人合作需求' : '公會訊息回覆'}數：{data.completion.reply_count}。</>}接待認領不代表已回覆，也不證明真人身分或內容品質。</p></div>}
        {data.state === 'source_unavailable' && <p role="status">曾有真實參與紀錄，但原來源目前不可讀。不顯示舊標題或連結，也不代表現在仍公開。</p>}
        {data.state === 'source_unavailable' && <div className="first-participation-actions"><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'choose',choice:'work'},'work')}>重新選擇分享作品</button><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'choose',choice:'introduction'},'introduction')}>重新選擇目前公會介紹</button></div>}
        <details><summary>查看教學範例與範圍</summary><p>以下為虛構教學範例，非真人內容，也不會自動代填或發布。</p><p>公會介紹：「大家好，我想練習排版，最近正在做自己的小作品。」只需原聊天室訊息；送出前自行確認內容。</p><p>作品：「我的排版練習」搭配自己的原作介紹；只填原表單必要欄位。不要貼他人私人資料。</p><p>社群分享的「發文」可另外使用，但不計入這裡的完成；目前沒有公開提問型別，公會介紹也不是公開提問的替代完成紀錄。</p></details>
        <div className="first-participation-actions"><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'skip'})}>略過</button><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'dismiss'})}>不再提示</button></div>
      </>}
      {data.state !== 'chosen' && data.resume && <p><a href={data.resume.href}>回到我的內容中的原私人作品草稿</a>（草稿不算參與完成）</p>}
      <details><summary>自願接待 · 不會自動發訊息</summary>
        <p>明確加入後，只有目前有權讀取原成果的同社群接待者能看見需求；不提供 email、聯絡資料或私人草稿。沒有保證有人接待。</p>
        <p role="status">{data.reception.state === 'claimed' && data.reception.claimant ? `目前由 ${data.reception.claimant.display_name} 認領；不代表已回覆。` : data.reception.state === 'unclaimed' ? '需求已加入，目前無人認領。' : data.reception.state === 'stopped' ? '已停止接待需求。' : '尚未加入接待需求。'}</p>
        <div className="first-participation-actions">{data.reception.requested ? <button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>action({action:'stop_reception'})}>停止接待需求</button> : <button className="btn btn-ghost" type="button" disabled={disabled||!data.completion||data.state!=='completed'} onClick={()=>action({action:'request_reception'})}>自願加入接待需求</button>}</div>
      </details>
    </>}
    <details onToggle={event=>{const opened=event.currentTarget.open;setQueueOpen(opened);if(opened)void loadQueue();else{queueReading.current++;setQueue(null);setQueueLoading(false);}}}><summary>我願意接待 · 查看目前可讀的自願需求</summary>
      <p>只列目前可讀、本人已選擇加入的需求。自行認領後仍須到原內容人工回應；不會自動私訊、加好友或替你送出回覆。</p>
      <button className="btn btn-ghost" type="button" disabled={busy||queueLoading} onClick={()=>void loadQueue()}>重新讀取需求</button>
      {queueLoading && <p role="status">正在讀取接待需求…</p>}{queueError && <p role="alert">{queueError}</p>}
      {queue && <>{queue.items.length===0 && <p>目前沒有你可讀的自願接待需求。</p>}<ul className="first-participation-queue">{queue.items.map(item=><li key={item.user_id}><p>{item.display_name} · <a href={item.completion.href}>{item.completion.title ?? '查看原内容'}</a>（{item.completion.audience==='guild'?'公會內':'社群內'}）</p><p>{item.claimant ? `${item.claimant.display_name} 已認領，尚不表示已回覆。` : '目前無人認領。'}</p><p>{item.completion.kind==='work'?'到原作品的合作需求入口交流。':'到原訊息所屬公會聊天室交流。'}</p>{item.user_id!==session.user.user_id && (!item.claimant || item.claimant.user_id===session.user.user_id) && <button className="btn btn-ghost" type="button" disabled={disabled||queueLoading} onClick={()=>{if(!pending.current)void send({path:`/first-participation/reception/${encodeURIComponent(item.user_id)}/${item.claimant?'release':'claim'}`,body:{},version:item.aggregate_version,key:crypto.randomUUID()});}}>{item.claimant?'釋放我的認領':'自願認領'}</button>}</li>)}</ul>{queue.next_offset!==null && <button className="btn btn-ghost" type="button" disabled={busy||queueLoading} onClick={()=>void loadQueue(queue.next_offset!)}>下一批需求</button>}</>}
    </details>
  </div>;
}
