import {useEffect,useId,useState} from 'react';
import type {PortalClient} from '../api';
import {useLanguage} from '../language';
import {useLocalAction} from '../useLocalAction';
import {MemberModelHttpOverviewSchema,type MemberModelHttpOverview} from '../../../../contracts/execution/v2/member-model-http';
import {SOCIAL_POST_GOALS,ownSocialPostModels,socialModelLabel,socialPostTask,type SocialPostGoal,type SocialPostOptimizationJob} from '../social-post-task';
import './SocialPostOptimizer.css';

export function SocialPostOptimizer({client,job,draft,disabled,onApply,onRecoverDraft}:{client:PortalClient;job:SocialPostOptimizationJob;draft:string;disabled:boolean;onApply:(text:string)=>void;onRecoverDraft:(text:string)=>void}) {
  const id=useId();
  const [overview,setOverview]=useState<MemberModelHttpOverview|null>(null),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [mode,setMode]=useState<'connected'|'handoff'>('connected'),[modelId,setModelId]=useState(''),[tool,setTool]=useState('Codex');
  const [goal,setGoal]=useState<SocialPostGoal>('clear'),[tokens,setTokens]=useState('512'),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const {t}=useLanguage(),copyAction=useLocalAction([client,job,draft,goal,tool,mode,disabled]);
  // Parent subscribes to this same job, preserving an approved operation when the dialog closes.
  const state=job.snapshot(),locked=['busy','uncertain','waiting'].includes(state.phase);
  useEffect(()=>{
    let live=true;setLoading(true);
    void client.get<unknown>('/me/model-step-overview',{suppressConsole:true}).then(raw=>{
      if(!live)return;const value=MemberModelHttpOverviewSchema.parse(raw);setOverview(value);
    }).catch(()=>{if(live)setOverview(null);}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[client,revision]);
  const models=overview?ownSocialPostModels(overview):[],model=models.find(value=>value.modelConnectionId===modelId);
  const maximum=model&&overview?.allowedSelections.find(value=>JSON.stringify(value.selection)===JSON.stringify(model.selection))?.maxOutputTokens;
  const tokenNumber=Number(tokens),tokenValid=maximum!==undefined&&Number.isInteger(tokenNumber)&&tokenNumber>=1&&tokenNumber<=maximum;
  const ready=state.phase==='ready'&&Boolean(state.result.trim()),stale=ready&&state.source!==draft;
  const prompt=draft.trim()?socialPostTask(draft,goal):'';
  async function copyTask(){
    const result=await copyAction.run('copy',()=>{
      setNotice('');setError('');
      // Capture only an accepted copy, before awaiting permission or editing.
      job.rememberHandoff(draft);
      return navigator.clipboard.writeText(`${tool==='Codex'?'若已安裝 Social Post，使用 $social-post。\n':tool==='Claude Code'?'若已安裝 Social Post，使用 /social-post。\n':''}${prompt}`);
    });
    if(result.status==='done')setNotice(`任務已複製。到自己的 ${tool} 執行，再把結果貼回來。`);
    else if(result.status==='failed')setError('無法自動複製。展開下方任務，手動複製到自己的 AI。');
  }
  return <section className="social-post-optimizer" aria-labelledby={id}>
    <header><h3 id={id}>Social Post 文案優化</h3><p>使用你自己的 AI 額度。優化後先預覽，再決定是否採用。</p></header>
    <label className="field">優化方向<select value={goal} disabled={disabled||locked} onChange={event=>setGoal(event.target.value as SocialPostGoal)}>{Object.entries(SOCIAL_POST_GOALS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <div className="optimizer-modes" role="group" aria-label="使用自己的 AI"><button type="button" className="btn btn-ghost" aria-pressed={mode==='connected'} disabled={disabled||locked} onClick={()=>setMode('connected')}>已連接的模型</button><button type="button" className="btn btn-ghost" aria-pressed={mode==='handoff'} disabled={disabled||locked} onClick={()=>setMode('handoff')}>到自己的 AI 工具</button></div>
    {mode==='connected'?<>
      {loading?<p role="status">正在讀取你的模型連線…</p>:models.length>0?<>
        <label className="field">我的模型<select value={modelId} disabled={disabled||locked} onChange={event=>{setModelId(event.target.value);const selected=models.find(value=>value.modelConnectionId===event.target.value);const limit=overview!.allowedSelections.find(value=>JSON.stringify(value.selection)===JSON.stringify(selected?.selection))?.maxOutputTokens;setTokens(String(Math.min(512,limit??512)));}}><option value="">選擇本人的模型</option>{models.map(value=><option key={value.modelConnectionId} value={value.modelConnectionId}>{socialModelLabel(value.selection)} · {value.selection.billingSource==='user_cli'?'自己的帳號額度':'自己的 API Key'}</option>)}</select></label>
        <label className="field">最多輸出 Token<input type="number" min={1} max={maximum} step={1} value={tokens} disabled={disabled||locked} onChange={event=>setTokens(event.target.value)}/></label>
        {model&&<p className="optimizer-fine-print">{socialModelLabel(model.selection)} · {model.selection.billingSource==='user_cli'?'使用本人的 CLI 帳號額度':'使用本人的 API Key 計費'}。費用以供應商為準。</p>}
        <details className="optimizer-export"><summary>查看這次送出的內容</summary><pre>{prompt||'先寫下貼文內容。'}</pre></details>
        <button type="button" className="btn btn-primary" disabled={disabled||locked||!model||!tokenValid||!draft.trim()} onClick={()=>{setError('');void job.start(overview!,modelId,draft,goal,tokenNumber).catch(cause=>setError(cause instanceof Error?cause.message:'無法開始優化。'));}}>同意送出草稿，優化一次</button>
      </>:<p role="status">目前沒有可直接執行的本人模型連線。可先設定連線，或把任務交給自己的 Codex、Claude Code、Grok 等工具。</p>}
      <div className="optimizer-actions"><a className="btn btn-ghost" href="/#private-ai" target="_blank" rel="noopener noreferrer">設定我的模型 ↗</a><button type="button" className="btn btn-ghost" disabled={loading||locked||disabled} onClick={()=>{setModelId('');setRevision(value=>value+1);}}>更新連線</button></div>
    </>:<>
      <label className="field">我的 AI 工具<select value={tool} disabled={disabled||locked} onChange={event=>setTool(event.target.value)}>{['Codex','Claude Code','Grok','其他 LLM'].map(value=><option key={value}>{value}</option>)}</select></label>
      <p className="optimizer-fine-print">複製任務到你自己的工具執行，使用該工具的本人帳號或 API Key，再貼回結果。</p>
      <button type="button" className="btn btn-ghost" aria-busy={copyAction.pending!==null} disabled={disabled||locked||!draft.trim()||copyAction.pending!==null} onClick={()=>void copyTask()}>{copyAction.pending?t('action.copying'):'複製文案優化任務'}</button>
      <details className="optimizer-export"><summary>查看／手動複製任務</summary><textarea aria-label="文案優化任務" readOnly value={prompt} rows={5} onFocus={event=>{job.rememberHandoff(draft);event.target.select();}} onCopy={()=>job.rememberHandoff(draft)}/></details>
      <label className="field" htmlFor={`${id}-manual-result`}><span id={`${id}-manual-label`}>貼回 AI 優化結果</span><textarea id={`${id}-manual-result`} aria-labelledby={`${id}-manual-label`} rows={4} maxLength={2000} value={state.evidence==='manual_handoff'?state.result:''} disabled={disabled||locked} onChange={event=>job.manualResult(event.target.value,draft,tool)}/></label>
    </>}
    {state.message&&<p role="status">{state.message}</p>}
    {state.source&&state.source!==draft&&<button type="button" className="btn btn-ghost" disabled={disabled} onClick={()=>onRecoverDraft(state.source)}>取回這次優化的原稿</button>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    {['uncertain','waiting'].includes(state.phase)&&<button type="button" className="btn btn-ghost" disabled={disabled} onClick={()=>void job.confirm()}>確認原請求結果</button>}
    {ready&&<section className="optimizer-preview" aria-label="優化文案預覽"><h4>優化文案預覽</h4><p className="optimizer-fine-print">{state.model}{state.evidence==='synthetic_local_fixture'?' · 本機合成測試，未使用真實模型':state.evidence==='manual_handoff'?' · 本人貼回，尚未驗證模型用量':''}</p>
      {state.usage&&<p className="optimizer-fine-print">輸入 {state.usage.inputTokens}／輸出 {state.usage.outputTokens} Token，費用以供應商為準。</p>}
      <p className="optimizer-result">{state.result}</p>
      {stale&&<p role="alert">原稿已更新。請依目前內容重新優化，避免覆蓋新的修改。</p>}
      {state.result.length>2000&&<p role="alert">結果超過 2000 字，請先在自己的 AI 工具縮短後貼回。</p>}
      <button type="button" className="btn btn-ghost" disabled={disabled||stale||state.result.length>2000} onClick={()=>onApply(state.result)}>採用這版文案</button>
    </section>}
  </section>;
}
